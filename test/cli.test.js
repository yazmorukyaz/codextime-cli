import { execFile, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { calculateModelTotalTokens, isValidUsageRequest } from '../dist/usage-payload.js'

const testDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(testDir, '..')
const repoDir = resolve(packageDir, '..', '..')
const cliPath = resolve(packageDir, 'dist', 'index.js')
const exampleUsage = resolve(packageDir, 'example-usage.json')
const safetyHome = mkdtempSync(resolve(tmpdir(), 'codextime-safety-home-'))
after(() => rmSync(safetyHome, { recursive: true, force: true }))

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoDir,
    env: {
      ...process.env,
      CODEXTIME_UPLOAD_TOKEN: '',
      CODEXTIME_USAGE_FILE: '',
      ...env
    },
    encoding: 'utf8'
  })
}

describe('codextime CLI safety behavior', () => {
  it('keeps installation identity stable across retries and distinct across devices', async () => {
    const payloads = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const payload = JSON.parse(body)
        payloads.push(payload)
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ success: true, processed: payload.data.daily.reduce((n, day) => n + day.modelBreakdowns.length, 0), errors: [] }))
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      for (const home of [resolve(safetyHome, 'one'), resolve(safetyHome, 'one'), resolve(safetyHome, 'two')]) {
        await promisify(execFile)(process.execPath, [cliPath, 'sync', '--input', exampleUsage, '--force'], {
          cwd: repoDir, timeout: 10000,
          env: { ...process.env, HOME: home, CODEXTIME_API_BASE: `http://127.0.0.1:${server.address().port}`, CODEXTIME_UPLOAD_TOKEN: 'ct_test_token', CODEXTIME_USAGE_FILE: '' },
        })
      }
      const metadata = payloads.map(payload => payload.data.daily[0].modelBreakdowns[0].metadata)
      assert.equal(metadata[0].installationId, metadata[1].installationId)
      assert.notEqual(metadata[0].installationId, metadata[2].installationId)
      assert.equal(metadata[0].importerVersion, '0.5.1')
      assert.equal(metadata[0].cloudCoverage, 'not-included')
    } finally { await new Promise(resolve => server.close(resolve)) }
  })
  it('includes provenance in batch sizing for a large completed history', async () => {
    const received = []
    const fixture = resolve(safetyHome, 'large-history.json')
    const original = JSON.parse(readFileSync(exampleUsage, 'utf8'))
    const daily = Array.from({ length: 240 }, (_, index) => ({
      ...original.daily[0], date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10)
    }))
    writeFileSync(fixture, JSON.stringify({ ...original, daily }))
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const payload = JSON.parse(body)
        received.push({ bytes: Buffer.byteLength(body), days: payload.data.daily.length })
        response.writeHead(Buffer.byteLength(body) > 100 * 1024 ? 413 : 200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ success: true, processed: payload.data.daily.length, errors: [] }))
      })
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      await promisify(execFile)(process.execPath, [cliPath, 'sync', '--input', fixture, '--force'], {
        cwd: repoDir, timeout: 10000,
        env: { ...process.env, HOME: safetyHome, CODEXTIME_API_BASE: `http://127.0.0.1:${server.address().port}`, CODEXTIME_UPLOAD_TOKEN: 'ct_test_token', CODEXTIME_USAGE_FILE: '' },
      })
      assert.ok(received.length > 1)
      assert.ok(received.every(batch => batch.bytes <= 90 * 1024))
      assert.equal(received.reduce((sum, batch) => sum + batch.days, 0), 240)
    } finally { await new Promise(resolve => server.close(resolve)) }
  })

  it('exits unsuccessfully for partial uploads even when the server returns HTTP 200', async () => {
    const server = createServer((request, response) => {
      request.resume()
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ success: true, processed: 1, errors: [{ error: 'Rejected test row' }] }))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      await assert.rejects(promisify(execFile)(process.execPath, [cliPath, 'sync', '--input', exampleUsage, '--force'], {
        cwd: repoDir,
        env: { ...process.env, HOME: safetyHome, CODEXTIME_API_BASE: `http://127.0.0.1:${address.port}`, CODEXTIME_UPLOAD_TOKEN: 'ct_test_token', CODEXTIME_USAGE_FILE: '' },
        timeout: 10000,
      }), error => {
        assert.match(error.stderr, /Upload incomplete/)
        assert.doesNotMatch(error.stdout, /Upload complete/)
        return true
      })
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })

  it('rejects malformed dates and invalid token amounts before ingestion', () => {
    const valid = {
      userId: 'test-user',
      data: { daily: [{ date: '2026-11-02', totalCost: 0, modelBreakdowns: [{ modelName: 'test-model', inputTokens: 10, outputTokens: 2, cost: 0 }] }] },
    }
    assert.equal(isValidUsageRequest(valid), true)
    for (const date of ['invalid', '2026-02-30', '2026-13-01', '2026-11-02garbage']) {
      const payload = structuredClone(valid)
      payload.data.daily[0].date = date
      assert.equal(isValidUsageRequest(payload), false, date)
    }
    const timestampPayload = structuredClone(valid)
    timestampPayload.data.daily[0].date = '2026-11-02T00:00:00Z'
    assert.equal(isValidUsageRequest(timestampPayload), true)
    for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const payload = structuredClone(valid)
      payload.data.daily[0].modelBreakdowns[0].inputTokens = value
      assert.equal(isValidUsageRequest(payload), false, String(value))
    }
    const payload = structuredClone(valid)
    payload.data.daily[0].reasoningTokens = -1
    assert.equal(isValidUsageRequest(payload), false)
    assert.equal(isValidUsageRequest({ userId: 'test-user', data: { daily: [] } }), false)
  })

  it('treats reasoning tokens as a subset of output tokens', () => {
    const total = calculateModelTotalTokens({
      modelName: 'gpt-5.6-sol',
      inputTokens: 10,
      cacheCreationTokens: 2,
      cacheReadTokens: 3,
      outputTokens: 4,
      reasoningTokens: 1,
      toolTokens: 7,
      cost: 0.001
    })

    assert.equal(total, 19)
  })

  it('does not silently fall back to raw snapshots when ccusage returns no data', () => {
    const fakeCodexHome = mkdtempSync(resolve(tmpdir(), 'codextime-direct-'))
    const fakeNpxPath = resolve(fakeCodexHome, 'npx')
    const sessionDir = resolve(fakeCodexHome, 'sessions', '2026', '07', '10')
    const sessionPath = resolve(sessionDir, 'rollout-test.jsonl')

    writeFileSync(fakeNpxPath, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ daily: [], totals: {} }))
`)
    chmodSync(fakeNpxPath, 0o755)
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(sessionPath, [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'test-session',
          timestamp: '2026-07-10T12:00:00.000Z',
          cwd: '/private/test',
          cli_version: 'test'
        }
      }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 40,
              output_tokens: 20,
              reasoning_output_tokens: 5,
              total_tokens: 120
            }
          }
        }
      })
    ].join('\n'))

    try {
      const result = runCli(['preview', '--from-codex'], {
        PATH: `${fakeCodexHome}:${process.env.PATH ?? ''}`,
        CODEX_HOME: fakeCodexHome
      })

      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /No daily entries/)
      assert.doesNotMatch(result.stdout, /Total tokens: 120/)
    } finally {
      rmSync(fakeCodexHome, { recursive: true, force: true })
    }
  })

  it('previews usage without requiring an upload token', () => {
    const result = runCli(['preview', '--input', exampleUsage])

    assert.equal(result.status, 0)
    assert.match(result.stdout, /Codextime upload preview/)
    assert.match(result.stdout, /Total tokens: 3200/)
    assert.match(result.stdout, /Does not upload: prompts, responses, source code/)
    assert.equal(result.stderr, '')
  })

  it('refuses sync without an upload token', () => {
    const result = runCli(['sync', '--input', exampleUsage, '--api', 'http://127.0.0.1:9'])

    assert.equal(result.status, 1)
    assert.match(result.stderr, /Upload token is required/)
  })

  it('masks tokens in doctor output', () => {
    const result = runCli(
      ['doctor', '--api', 'http://127.0.0.1:9'],
      { CODEXTIME_UPLOAD_TOKEN: 'ctu_live_abcd1234_abcdefghijklmnopqrstuvwxyzABCDE' }
    )

    assert.equal(result.status, 1)
    assert.match(result.stdout, /ctu_live_abcd1234_\*\*\*\*\*\*\*\*/)
    assert.doesNotMatch(result.stdout + result.stderr, /abcdefghijklmnopqrstuvwxyzABCDE/)
  })

  it('pins ccusage, requests per-agent reports, and imports complete UTC history initially', () => {
    const fakeBinDir = mkdtempSync(resolve(tmpdir(), 'codextime-ccusage-'))
    const fakeNpxPath = resolve(fakeBinDir, 'npx')
    const capturedArgsPath = resolve(fakeBinDir, 'args.json')
    const report = {
      daily: [{
        date: '2026-07-10',
        inputTokens: 10,
        cacheCreationTokens: 2,
        cacheReadTokens: 3,
        outputTokens: 4,
        reasoningOutputTokens: 1,
        totalTokens: 19,
        costUSD: 0.001,
        models: {
          'gpt-5.6-sol': {
            inputTokens: 10,
            cacheCreationTokens: 2,
            cacheReadTokens: 3,
            outputTokens: 4,
            reasoningOutputTokens: 1,
            totalTokens: 19,
            isFallback: false
          }
        }
      }],
      totals: {
        inputTokens: 10,
        cacheCreationTokens: 2,
        cacheReadTokens: 3,
        outputTokens: 4,
        reasoningOutputTokens: 1,
        totalTokens: 19,
        costUSD: 0.001
      }
    }

    const day = report.daily[0]
    report.daily = [{ period: day.date, agents: [{
      ...day, agent: 'codex', modelBreakdowns: [{
        modelName: 'gpt-6.1-sol', inputTokens: 10, outputTokens: 4,
        cacheCreationTokens: 2, cacheReadTokens: 3, cost: 0.001,
      }],
    }] }]

    writeFileSync(fakeNpxPath, `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
writeFileSync(${JSON.stringify(capturedArgsPath)}, JSON.stringify(process.argv.slice(2)))
process.stdout.write(${JSON.stringify(JSON.stringify(report))})
`)
    chmodSync(fakeNpxPath, 0o755)

    try {
      const result = runCli(['preview', '--from-codex'], {
        PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
        CODEX_HOME: fakeBinDir
      })

      assert.equal(result.status, 0, result.stderr)
      const capturedArgs = JSON.parse(readFileSync(capturedArgsPath, 'utf8'))
      assert.deepEqual(capturedArgs.slice(0, 4), [
        '--yes',
        'ccusage@20.0.47',
        'daily',
        '--json'
      ])
      assert.ok(capturedArgs.includes('--json'))
      assert.ok(capturedArgs.includes('--by-agent'))
      assert.ok(capturedArgs.includes('UTC'))
      assert.ok(!capturedArgs.includes('--since'))
    } finally {
      rmSync(fakeBinDir, { recursive: true, force: true })
    }
  })
})
