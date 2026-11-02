import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCodexDailyReport } from '../dist/ccusage-report.js'

const report = () => ({ daily: [{ period: '2026-11-02', agents: [
  { agent: 'claude', totalTokens: 999, modelBreakdowns: [{ modelName: 'not-codex', inputTokens: 999, outputTokens: 0, cost: 100 }] },
  { agent: 'codex', totalTokens: 200, modelBreakdowns: [
    { modelName: 'gpt-6.1-sol', inputTokens: 10, outputTokens: 10, cacheReadTokens: 80, cost: 0.4 },
    { modelName: 'gpt-6.1-terra', inputTokens: 90, outputTokens: 10, cost: 0.1 },
  ] },
] }] })

test('isolates Codex and preserves per-model prices instead of allocating by token share', () => {
  const data = normalizeCodexDailyReport(report())
  assert.equal(data.daily[0].totalTokens, 200)
  assert.equal(data.daily[0].totalCost, 0.5)
  assert.deepEqual(data.daily[0].modelBreakdowns.map(m => [m.modelName, m.cost]), [['gpt-6.1-sol', 0.4], ['gpt-6.1-terra', 0.1]])
})
test('retains new model names and explicitly marks unknown pricing', () => {
  const r = report()
  const model = r.daily[0].agents[1].modelBreakdowns[0]
  model.modelName = 'future-model'
  delete model.cost
  const data = normalizeCodexDailyReport(r)
  assert.equal(data.daily[0].modelBreakdowns[0].modelName, 'future-model')
  assert.equal(data.daily[0].modelBreakdowns[0].metadata.pricingStatus, 'unknown')
  assert.equal(data.daily[0].metadata.pricingStatus, 'partial')
})
test('rejects inconsistent totals and incomplete source attribution', () => {
  const r = report(); r.daily[0].agents[1].totalTokens = 201
  assert.throws(() => normalizeCodexDailyReport(r), /totals do not match/)
  assert.throws(() => normalizeCodexDailyReport({ daily: [{ period: '2026-11-02' }] }), /per-agent/)
})
