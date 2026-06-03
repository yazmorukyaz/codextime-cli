import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const testDir = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(testDir, '..')
const repoDir = resolve(packageDir, '..', '..')
const cliPath = resolve(packageDir, 'dist', 'index.js')
const exampleUsage = resolve(packageDir, 'example-usage.json')

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
  it('previews usage without requiring an upload token', () => {
    const result = runCli(['preview', '--input', exampleUsage])

    assert.equal(result.status, 0)
    assert.match(result.stdout, /Codextime upload preview/)
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
})
