export type Provider = 'codex'

export interface ModelBreakdownPayload {
  modelName: string
  provider?: Provider
  inputTokens: number
  outputTokens: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
  reasoningTokens?: number
  toolTokens?: number
  totalTokens?: number
  cost: number
  latencyMs?: number
  ide?: string
  sessionId?: string
  metadata?: Record<string, unknown>
}

export interface DailyUsagePayload {
  date: string
  provider?: Provider
  ide?: string
  sessionId?: string
  latencyMs?: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
  reasoningTokens?: number
  toolTokens?: number
  totalTokens?: number
  totalCost: number
  modelsUsed: string[]
  modelBreakdowns: ModelBreakdownPayload[]
  metadata?: Record<string, unknown>
}

export interface UsageDataPayload {
  provider?: Provider
  metadata?: Record<string, unknown>
  daily: DailyUsagePayload[]
}

export interface UsageRequestPayload {
  userId: string
  provider?: Provider
  data: UsageDataPayload
}

export const PROVIDER_VALUES: Provider[] = ['codex']

export function isProvider(value: string): value is Provider {
  return PROVIDER_VALUES.includes(value as Provider)
}

export function normalizeProvider(value?: string | null): Provider {
  if (value && isProvider(value)) {
    return value as Provider
  }
  return 'codex'
}

export function isValidUsageRequest(payload: UsageRequestPayload): payload is UsageRequestPayload {
  if (!payload || typeof payload.userId !== 'string' || !payload.userId) {
    return false
  }

  if (!payload.data || !Array.isArray(payload.data.daily)) {
    return false
  }

  const validCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  const validAmount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0
  const optionalCounts = ['cacheCreationTokens', 'cacheReadTokens', 'reasoningTokens', 'toolTokens', 'totalTokens'] as const

  return payload.data.daily.length > 0 && payload.data.daily.every(day => {
    const dayIsValid = Boolean(
      day &&
      typeof day.date === 'string' &&
      /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(day.date) &&
      Number.isFinite(Date.parse(day.date)) &&
      new Date(day.date.slice(0, 10)).toISOString().slice(0, 10) === day.date.slice(0, 10) &&
      Array.isArray(day.modelBreakdowns) &&
      day.modelBreakdowns.length > 0 &&
      validAmount(day.totalCost) &&
      optionalCounts.every(key => day[key] === undefined || validCount(day[key]))
    )

    if (!dayIsValid) return false

    return day.modelBreakdowns.every(model => {
      return Boolean(
        model &&
        typeof model.modelName === 'string' &&
        model.modelName.length > 0 &&
        validCount(model.inputTokens) &&
        validCount(model.outputTokens) &&
        optionalCounts.every(key => model[key] === undefined || validCount(model[key])) &&
        validCount(calculateModelTotalTokens(model)) &&
        validAmount(model.cost)
      )
    })
  })
}

export function calculateModelTotalTokens(model: ModelBreakdownPayload): number {
  // Codex reports reasoning and tool tokens as details already included in outputTokens.
  return model.inputTokens +
    model.outputTokens +
    (model.cacheCreationTokens ?? 0) +
    (model.cacheReadTokens ?? 0)
}
