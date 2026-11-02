import { test } from 'node:test'
import assert from 'node:assert/strict'
import { partitionUpload } from '../dist/upload-batches.js'
test('batches complete history without losing or splitting days', () => {
  const payload = { userId: 'test', data: { daily: Array.from({ length: 30 }, (_, i) => ({ date: String(i), metadata: { padding: 'x'.repeat(200) } })) } }
  const batches = partitionUpload(payload, 1000)
  assert.ok(batches.length > 1)
  assert.deepEqual(batches.flatMap(b => b.data.daily), payload.data.daily)
  assert.ok(batches.every(b => Buffer.byteLength(JSON.stringify(b)) <= 1000))
})
test('refuses a single oversized day before returning any batches', () => {
  assert.throws(() => partitionUpload({ userId: 'test', data: { daily: [{ date: '2026-11-02', metadata: { padding: 'x'.repeat(1000) } }] } }, 100), /exceeds/)
})
