import type { DailyUsagePayload, ModelBreakdownPayload, UsageDataPayload } from './usage-payload.js'

export const CCUSAGE_VERSION = '20.0.47'

interface ModelRow {
  modelName: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
  cost?: number
  missingPricing?: boolean
}
interface AgentRow {
  agent: string
  modelBreakdowns: ModelRow[]
  totalTokens?: number
}
interface PeriodRow { date?: string; period?: string; agents?: AgentRow[] }

export function normalizeCodexDailyReport(report: unknown): UsageDataPayload {
  if (!report || typeof report !== 'object' || !('daily' in report) || !Array.isArray(report.daily)) {
    throw new Error('Unsupported ccusage daily report; refusing to guess usage.')
  }
  const daily: DailyUsagePayload[] = []
  for (const period of report.daily as PeriodRow[]) {
    if (!Array.isArray(period.agents)) throw new Error('ccusage report is missing per-agent breakdowns.')
    const codexRows = period.agents.filter(agent => agent.agent === 'codex')
    if (!codexRows.length) continue
    if (codexRows.length !== 1) throw new Error('Duplicate Codex agent rows in one reporting period.')
    const agent = codexRows[0]
    const date = period.date ?? period.period
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
      throw new Error('Invalid ccusage reporting date.')
    }
    if (!Array.isArray(agent.modelBreakdowns) || !agent.modelBreakdowns.length) throw new Error('Missing Codex model breakdowns.')
    const models: ModelBreakdownPayload[] = agent.modelBreakdowns.map(model => {
      const counts = [model.inputTokens, model.outputTokens, model.cacheCreationTokens ?? 0, model.cacheReadTokens ?? 0]
      if (typeof model.modelName !== 'string' || !model.modelName.trim() || counts.some(n => !Number.isSafeInteger(n) || n < 0)) {
        throw new Error('Invalid ccusage model counters.')
      }
      const totalTokens = counts.reduce((sum, n) => sum + n, 0)
      if (!Number.isSafeInteger(totalTokens)) throw new Error('Codex token total exceeds safe integer precision.')
      const hasPrice = model.missingPricing !== true && typeof model.cost === 'number' && Number.isFinite(model.cost) && model.cost >= 0
      return {
        modelName: model.modelName, provider: 'codex', inputTokens: counts[0], outputTokens: counts[1],
        cacheCreationTokens: counts[2], cacheReadTokens: counts[3], totalTokens,
        cost: hasPrice ? model.cost! : 0,
        metadata: { source: 'ccusage', ccusageVersion: CCUSAGE_VERSION, granularity: 'daily', timezone: 'UTC', coverage: 'retained-local-logs', pricingStatus: hasPrice ? 'upstream_estimate' : 'unknown' },
      }
    })
    if (new Set(models.map(model => model.modelName)).size !== models.length) throw new Error('Duplicate Codex model rows in one reporting period.')
    const sum = (key: 'inputTokens' | 'outputTokens' | 'cacheCreationTokens' | 'cacheReadTokens' | 'totalTokens') => models.reduce((total, model) => total + (model[key] ?? 0), 0)
    if (agent.totalTokens !== undefined && agent.totalTokens !== sum('totalTokens')) throw new Error('ccusage totals do not match the Codex model breakdowns.')
    daily.push({
      date, provider: 'codex', ide: 'codex-ccusage', inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
      cacheCreationTokens: sum('cacheCreationTokens'), cacheReadTokens: sum('cacheReadTokens'), totalTokens: sum('totalTokens'),
      totalCost: models.reduce((total, model) => total + model.cost, 0), modelsUsed: models.map(model => model.modelName), modelBreakdowns: models,
      metadata: { source: 'ccusage-codex-daily', ccusageVersion: CCUSAGE_VERSION, timezone: 'UTC', pricingStatus: models.some(model => model.metadata?.pricingStatus === 'unknown') ? 'partial' : 'upstream_estimate' },
    })
  }
  if (new Set(daily.map(day => day.date)).size !== daily.length) throw new Error('Duplicate Codex reporting dates.')
  daily.sort((a, b) => a.date.localeCompare(b.date))
  return { provider: 'codex', metadata: { source: 'ccusage-codex-daily', ccusageVersion: CCUSAGE_VERSION, coverage: 'retained-local-logs' }, daily }
}
