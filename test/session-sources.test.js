import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import * as zlib from 'node:zlib'
import { remoteProject, projectResolver } from '../dist/session-projects.js'
import { discoverSessionSources, sessionSnapshots } from '../dist/session-sources.js'
const id = '11111111-1111-4111-8111-111111111111'
test('remote identities merge SSH/HTTPS without sending credentials or remote addresses', () => {
  const one = remoteProject('https://user:DO_NOT_SEND@github.com/Owner/Repo.git?token=PRIVATE')
  const two = remoteProject('git@github.com:owner/repo.git')
  assert.equal(one.key, two.key)
  assert.equal(one.name, 'Repo')
  assert.ok(!JSON.stringify(one).includes('DO_NOT_SEND'))
  assert.ok(!JSON.stringify(one).includes('github.com'))
  assert.equal(remoteProject('file:///private/repo'), null)
})
test('metadata binding uses header identity and leaves mixed repositories unassigned', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-project-test-'))
  try {
    const a = join(root, 'a'),
      b = join(root, 'b'),
      home = join(root, 'codex')
    mkdirSync(a)
    mkdirSync(b)
    mkdirSync(join(home, 'sessions'), { recursive: true })
    for (const [folder, name] of [
      [a, 'alpha'],
      [b, 'beta']
    ]) {
      execFileSync('git', ['init', '-q', folder])
      execFileSync('git', [
        '-C',
        folder,
        'remote',
        'add',
        'origin',
        `https://github.com/example/${name}.git`
      ])
    }
    const file = join(home, 'sessions', 'misleading-filename.jsonl')
    const records = [
      { type: 'session_meta', payload: { id, cwd: a } },
      { type: 'response_item', payload: { text: 'PRIVATE PROMPT' } }
    ]
    writeFileSync(file, records.map((row) => JSON.stringify(row)).join('\n') + '\n')
    const report = {
      session: [
        {
          agent: 'codex',
          period: 'misleading-filename',
          totalTokens: 15,
          modelBreakdowns: [{ modelName: 'future-model', inputTokens: 10, outputTokens: 5 }]
        }
      ]
    }
    const sources = await discoverSessionSources([home])
    const first = await sessionSnapshots(report, sources.files, join(root, 'config'))
    assert.equal(first.items[0].sessionId, id)
    assert.equal(first.items[0].project.name, 'alpha')
    assert.ok(!JSON.stringify(first).includes(root))
    assert.ok(!JSON.stringify(first).includes('PRIVATE PROMPT'))
    writeFileSync(
      file,
      records
        .concat({ type: 'turn_context', payload: { cwd: b } })
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n'
    )
    assert.equal(
      (await sessionSnapshots(report, sources.files, join(root, 'config'))).items[0].project,
      null
    )
    writeFileSync(
      file,
      JSON.stringify({
        type: 'session_meta',
        payload: { id: '22222222-2222-4222-8222-222222222222', cwd: a }
      }) + '\n'
    )
    assert.equal(
      (await sessionSnapshots(report, sources.files, join(root, 'config'))).items.length,
      0
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('plain/archived/compressed copies follow source precedence and duplicate identities are held', async () => {
  const root = mkdtempSync(join(tmpdir(), 'session-copies-'))
  try {
    for (const folder of ['sessions', 'archived_sessions']) mkdirSync(join(root, folder))
    const text = JSON.stringify({ type: 'session_meta', payload: { id, cwd: root } }) + '\n'
    writeFileSync(join(root, 'sessions', 'same.jsonl'), text)
    writeFileSync(join(root, 'sessions', 'corrupt.jsonl.zst'), 'not a zstd stream')
    writeFileSync(join(root, 'archived_sessions', 'same.jsonl'), text)
    if (zlib.zstdCompressSync)
      writeFileSync(
        join(root, 'sessions', 'same.jsonl.zst'),
        zlib.zstdCompressSync(Buffer.from(text))
      )
    assert.equal((await discoverSessionSources([root])).files.length, 1)
    assert.equal((await discoverSessionSources([root])).skipped, 1)
    writeFileSync(join(root, 'sessions', 'second.jsonl'), text)
    const report = {
      session: [
        {
          agent: 'codex',
          period: 'same',
          totalTokens: 1,
          modelBreakdowns: [{ modelName: 'm', inputTokens: 1, outputTokens: 0 }]
        }
      ]
    }
    const result = await sessionSnapshots(
      report,
      (await discoverSessionSources([root])).files,
      join(root, 'config')
    )
    assert.equal(result.items.length, 0)
    assert.ok(result.skipped > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('local identities survive restarts and same-name folders do not merge', async () => {
  const root = mkdtempSync(join(tmpdir(), 'local-projects-'))
  try {
    const a = join(root, 'one', 'same'),
      b = join(root, 'two', 'same')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    const config = join(root, 'config'),
      first = await projectResolver(config)
    const one = await first.resolve(a),
      two = await first.resolve(b)
    assert.notEqual(one.key, two.key)
    assert.equal((await (await projectResolver(config)).resolve(a)).key, one.key)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('pinned engine computes a fixed post-cutover window rather than lifetime totals', (context) => {
  const engine = process.env.CCUSAGE_ENGINE
  if (!engine) {
    context.skip('Set CCUSAGE_ENGINE to the pinned ccusage executable wrapper')
    return
  }
  const root = mkdtempSync(join(tmpdir(), 'engine-window-'))
  try {
    mkdirSync(join(root, 'sessions'))
    const usage = (input, cached, output) => ({
      input_tokens: input,
      cached_input_tokens: cached,
      output_tokens: output,
      total_tokens: input + output
    })
    const records = [
      {
        timestamp: '2026-01-01T00:00:00Z',
        type: 'session_meta',
        payload: { id, timestamp: '2026-01-01T00:00:00Z', cwd: root }
      },
      {
        timestamp: '2026-01-01T00:00:00Z',
        type: 'turn_context',
        payload: { model: 'gpt-5-codex', cwd: root }
      },
      ...[
        ['2026-01-01T23:00:00Z', usage(100, 20, 30), usage(100, 20, 30)],
        ['2026-01-02T01:00:00Z', usage(120, 25, 35), usage(20, 5, 5)]
      ].map(([timestamp, total, last]) => ({
        timestamp,
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } }
      }))
    ]
    writeFileSync(
      join(root, 'sessions', 'source.jsonl'),
      records.map((row) => JSON.stringify(row)).join('\n') + '\n'
    )
    writeFileSync(join(root,'sessions','bad.jsonl.zst'),'not compressed')
    const output = execFileSync(
      process.execPath,
      [
        resolve(engine),
        'daily',
        '--json',
        '--by-agent',
        '--sections',
        'session',
        '--timezone',
        'UTC',
        '--since',
        '2026-01-02',
        '--offline',
        '--no-cost'
      ],
      { env: { ...process.env, HOME: root, CODEX_HOME: root }, encoding: 'utf8', timeout: 30000 }
    )
    const report = JSON.parse(output)
    assert.equal(
      report.session
        .filter((row) => row.agent === 'codex')
        .reduce((sum, row) => sum + row.totalTokens, 0),
      25
    )
    const empty = execFileSync(
      process.execPath,
      [
        resolve(engine),
        'daily',
        '--json',
        '--by-agent',
        '--sections',
        'session',
        '--timezone',
        'UTC',
        '--since',
        '2026-01-03',
        '--offline',
        '--no-cost'
      ],
      { env: { ...process.env, HOME: root, CODEX_HOME: root }, encoding: 'utf8', timeout: 30000 }
    )
    assert.equal(JSON.parse(empty).session.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
