import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { batchSessionSnapshots } from '../dist/automatic-sync.js'
const exec = promisify(execFile),
  cli = resolve(fileURLToPath(new URL('../dist/index.js', import.meta.url)))
const id = '11111111-1111-4111-8111-111111111111'
const startDay = new Date().toISOString().slice(0, 10)
test('final automatic payload batching includes device and project metadata', () => {
  const base = {
    installationId: id,
    deviceName: 'Test',
    windowStart: '2026-11-03',
    engineVersion: '20.0.47'
  }
  const items = Array.from({ length: 1200 }, (_, index) => ({
    sessionId: id,
    model: `model-${index}`,
    input: 10,
    output: 5,
    cacheCreation: 0,
    cacheRead: 0,
    project: { key: 'a'.repeat(64), name: 'long-project-name', kind: 'git_remote' }
  }))
  const batches = batchSessionSnapshots(base, items)
  assert.ok(batches.length > 1)
  assert.ok(
    batches.every(
      (batch) => batch.items.length <= 500 && Buffer.byteLength(JSON.stringify(batch)) <= 90 * 1024
    )
  )
  assert.equal(batches.flatMap((batch) => batch.items).length, 1200)
})
test('automatic CLI enrolls explicitly, uses one fixed window and never calls legacy upload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'automatic-cli-')),
    calls = [],
    argumentsFile = join(root, 'args.json')
  mkdirSync(join(root, 'logs', 'sessions'), { recursive: true })
  mkdirSync(join(root, 'bin'))
  writeFileSync(
    join(root, 'logs', 'sessions', 'source.jsonl'),
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id,
        cwd: root,
        git: { repository_url: 'https://user:SECRET@github.com/example/project.git' }
      }
    }) + '\n'
  )
  const report = {
    session: [
      {
        agent: 'codex',
        period: 'source',
        totalTokens: 15,
        modelBreakdowns: [{ modelName: 'future-model', inputTokens: 10, outputTokens: 5 }]
      }
    ]
  }
  const fake = join(root, 'bin', 'npx')
  writeFileSync(
    fake,
    `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(argumentsFile)},JSON.stringify(process.argv.slice(2)));process.stdout.write(${JSON.stringify(JSON.stringify(report))});`
  )
  chmodSync(fake, 0o755)
  let enrolled = false
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => (raw += chunk))
    request.on('end', () => {
      const body = raw ? JSON.parse(raw) : null
      calls.push({ path: request.url, body })
      response.setHeader('Content-Type', 'application/json')
      if (request.method === 'GET')
        response.end(
          JSON.stringify({ account: enrolled ? { id: 'state', start_day: startDay } : null })
        )
      else if (body.kind === 'enroll') {
        enrolled = true
        response.end(JSON.stringify({ account: { id: 'state', start_day: startDay } }))
      } else
        response.end(
          JSON.stringify({ success: true, processed: body.items.length, held: 0, addedTokens: 15 })
        )
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const env = {
      ...process.env,
      HOME: root,
      CODEX_HOME: join(root, 'logs'),
      CODEXTIME_UPLOAD_TOKEN: 'test-token',
      CODEXTIME_USAGE_FILE: '',
      PATH: `${join(root, 'bin')}:${process.env.PATH}`
    }
    const result = await exec(
      process.execPath,
      [cli, 'sync', '--automatic', '--api', `http://127.0.0.1:${server.address().port}`],
      { env, timeout: 15000 }
    )
    assert.match(result.stdout, /Historical imports remain unchanged/)
    assert.ok(calls.every((call) => call.path === '/api/session-sync'))
    const upload = calls.find((call) => call.body?.items)
    assert.equal(upload.body.windowStart, startDay)
    assert.equal(upload.body.items[0].project.name, 'project')
    assert.ok(!JSON.stringify(upload).includes('SECRET'))
    assert.ok(!JSON.stringify(upload).includes(root))
    assert.ok(JSON.parse(readFileSync(argumentsFile, 'utf8')).includes(startDay))
    calls.length = 0
    const child = spawn(
      process.execPath,
      [cli, 'watch', '--api', `http://127.0.0.1:${server.address().port}`],
      { env, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
    child.stdout.on('data', (data) => {
      if (String(data).includes('Automatic sync:')) child.kill('SIGINT')
    })
    assert.equal(await exited, 0)
    clearTimeout(timer)
    assert.ok(calls.some((call) => call.body?.items))
  } finally {
    await new Promise((resolve) => server.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
})
