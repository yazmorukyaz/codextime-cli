#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises'
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import process from 'node:process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import {
  UsageRequestPayload,
  UsageDataPayload,
  DailyUsagePayload,
  ModelBreakdownPayload,
  isValidUsageRequest,
  Provider
} from '@codextime/types'

interface CliOptions {
  command: 'preview' | 'login' | 'sync' | 'doctor' | 'legacy-sync'
  userId?: string
  uploadToken?: string
  inputPath?: string
  apiBaseUrl: string
  verbose: boolean
  forceUpload: boolean
  fromCodex: boolean
}

interface LogEvent {
  timestamp: string
  model: string
  provider?: Provider
  ide?: string
  sessionId?: string
  rateLimits?: RateLimitsSnapshot
  inputTokens?: number
  outputTokens?: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
  reasoningTokens?: number
  toolTokens?: number
  totalTokens?: number
  cost?: number
  latencyMs?: number
  metadata?: Record<string, unknown>
}

interface RateLimitWindow {
  usedPercent: number
  windowMinutes: number
  resetsAt: number
}

interface RateLimitsSnapshot {
  primary?: RateLimitWindow
  secondary?: RateLimitWindow
}

const CODEX_PRICING = {
  inputPerToken: 1.25 / 1_000_000,
  cachedInputPerToken: 0.125 / 1_000_000,
  outputPerToken: 10 / 1_000_000,
  docsUrl: 'https://developers.openai.com/codex/pricing/'
} as const

const execFileAsync = promisify(execFile)

function estimateCodexCost(event: LogEvent) {
  const inputTokens = event.inputTokens ?? 0
  const cachedTokens = event.cacheReadTokens ?? 0
  const outputTokens =
    (event.outputTokens ?? 0) +
    (event.reasoningTokens ?? 0) +
    (event.toolTokens ?? 0)

  return (
    inputTokens * CODEX_PRICING.inputPerToken +
    cachedTokens * CODEX_PRICING.cachedInputPerToken +
    outputTokens * CODEX_PRICING.outputPerToken
  )
}

const DEFAULT_INPUT_FILENAME = 'codextime-usage.json'
const HOME_DIRECTORY = homedir()
const CODEXTIME_CONFIG_DIR = resolve(HOME_DIRECTORY, '.codextime')
const CODEXTIME_CONFIG_PATH = resolve(CODEXTIME_CONFIG_DIR, 'config.json')
const TOKEN_PATTERN = /^ctu_live_[a-f0-9]{8}_[A-Za-z0-9_-]{32,}$/
const DEFAULT_INPUT_SEARCH_PATHS = [
  () => resolve(process.cwd(), DEFAULT_INPUT_FILENAME),
  () => resolve(HOME_DIRECTORY, DEFAULT_INPUT_FILENAME),
  () => resolve(CODEXTIME_CONFIG_DIR, DEFAULT_INPUT_FILENAME)
]
const CODEX_HOME_PATH = () => resolve(process.env.CODEX_HOME ?? resolve(HOME_DIRECTORY, '.codex'))

interface CliConfig {
  uploadToken?: string
  apiBaseUrl?: string
}

function maskToken(token?: string | null) {
  if (!token) return 'not configured'
  const parts = token.split('_')
  if (parts.length >= 4) {
    return `${parts[0]}_${parts[1]}_${parts[2]}_********`
  }
  return 'ctu_live_********'
}

function printUsage() {
  console.log(`codextime

Usage:
  codextime preview [--input codextime-usage.json] [--api https://example.com] [--verbose]
  codextime login [--token ctu_live_...] [--api https://example.com]
  codextime sync [--input codextime-usage.json] [--api https://example.com] [--force] [--verbose]
  codextime doctor [--api https://example.com]

Legacy migration:
  codextime <userId> [--input codextime-usage.json] [--api https://example.com] [--force] [--verbose]

Environment variables:
  CODEXTIME_API_BASE   Base URL for Codextime (default: https://codexti.me)
  CODEXTIME_UPLOAD_TOKEN Upload token for automation. Prefer codextime login for normal use.
  CODEXTIME_USAGE_FILE Optional absolute path to your default usage JSON.
  CODEX_HOME           Root directory for Codex CLI session logs.

Input file format:
  1) JSON object matching UsageDataPayload (see CLI_GUIDE.md) with a "daily" array.
  2) Array of log events (or { "events": [...] }) where each event has:
     {
       "timestamp": "2025-06-24T10:15:00Z",
       "model": "gpt-5-codex",
       "inputTokens": 1000,
       "outputTokens": 2200,
       "reasoningTokens": 150,
       "toolTokens": 30,
       "cost": 0.42,
       "ide": "vscode",
       "sessionId": "abc-123",
       "metadata": { ... }
     }
  The CLI will aggregate these events into the required UsageDataPayload format.
  If --input is omitted, the CLI scans local Codex logs when available.
`)
}

function loadConfig(): CliConfig {
  if (!existsSync(CODEXTIME_CONFIG_PATH)) return {}
  try {
    return JSON.parse(readFileSync(CODEXTIME_CONFIG_PATH, 'utf8')) as CliConfig
  } catch {
    return {}
  }
}

function saveConfig(config: CliConfig) {
  if (!existsSync(CODEXTIME_CONFIG_DIR)) {
    mkdirSync(CODEXTIME_CONFIG_DIR, { recursive: true, mode: 0o700 })
  }
  writeFileSync(CODEXTIME_CONFIG_PATH, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(CODEXTIME_CONFIG_DIR, 0o700)
    chmodSync(CODEXTIME_CONFIG_PATH, 0o600)
  } catch {
    // Best-effort on platforms that do not support POSIX file modes.
  }
}

function getFlagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index !== -1 && index + 1 < argv.length) {
    return argv[index + 1]
  }
  return undefined
}

async function promptForToken(): Promise<string> {
  return new Promise((resolvePrompt) => {
    const stdin = process.stdin
    const stdout = process.stdout
    stdout.write('Paste your Codextime upload token: ')

    let token = ''
    const wasRaw = stdin.isRaw
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    const onData = (char: string) => {
      if (char === '\n' || char === '\r') {
        stdout.write('\n')
        stdin.setRawMode?.(wasRaw)
        stdin.pause()
        stdin.off('data', onData)
        resolvePrompt(token.trim())
        return
      }
      if (char === '\u0003') {
        stdout.write('\n')
        process.exit(130)
      }
      if (char === '\b' || char === '\u007f') {
        token = token.slice(0, -1)
        return
      }
      token += char
    }

    stdin.on('data', onData)
  })
}

function findExistingInputPath(): string | null {
  const envPath = process.env.CODEXTIME_USAGE_FILE
  if (envPath && existsSync(envPath)) {
    return envPath
  }

  for (const pathResolver of DEFAULT_INPUT_SEARCH_PATHS) {
    const candidate = pathResolver()
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

function codexHomeExists(): boolean {
  try {
    return existsSync(CODEX_HOME_PATH())
  } catch {
    return false
  }
}

function parseArgs(argv: string[]): CliOptions | null {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    printUsage()
    return null
  }

  const firstArg = argv[0]
  const command = ['preview', 'login', 'sync', 'doctor'].includes(firstArg)
    ? firstArg as CliOptions['command']
    : 'legacy-sync'

  const config = loadConfig()
  const apiBaseUrl =
    getFlagValue(argv, '--api') ??
    process.env.CODEXTIME_API_BASE ??
    config.apiBaseUrl ??
    'https://codexti.me'
  const verbose = argv.includes('--verbose')
  const forceUpload = argv.includes('--force')
  const uploadToken =
    getFlagValue(argv, '--token') ??
    process.env.CODEXTIME_UPLOAD_TOKEN ??
    config.uploadToken

  if (command === 'login' || command === 'doctor') {
    return {
      command,
      uploadToken,
      inputPath: undefined,
      apiBaseUrl,
      verbose,
      forceUpload,
      fromCodex: false
    }
  }

  const codexDetected = codexHomeExists()
  const explicitFromCodex = argv.includes('--from-codex')
  let fromCodex = explicitFromCodex

  const cliInputValue = getFlagValue(argv, '--input')
  const rawInputValue = cliInputValue ?? process.env.CODEXTIME_USAGE_FILE
  let inputPath: string | undefined
  if (rawInputValue) {
    const resolvedPath = resolve(process.cwd(), rawInputValue)
    if (!existsSync(resolvedPath)) {
      console.error(`Input file not found: ${resolvedPath}`)
      return null
    }
    inputPath = resolvedPath
    fromCodex = false
  }

  if (explicitFromCodex && inputPath) {
    console.warn('Both --input and --from-codex were supplied. Ignoring --input and ingesting directly from Codex CLI logs.')
    inputPath = undefined
    fromCodex = true
  }

  if (!fromCodex && !inputPath && codexDetected) {
    fromCodex = true
    console.log('Detected Codex CLI logs under CODEX_HOME; defaulting to --from-codex ingestion. Pass --input <file> to override.')
  }

  if (!fromCodex) {
    if (!inputPath) {
      const existingPath = findExistingInputPath()
      if (existingPath) {
        inputPath = existingPath
      } else if (!codexDetected) {
        const fallbackPath = resolve(HOME_DIRECTORY, '.codextime', DEFAULT_INPUT_FILENAME)
        console.log(`No --input provided and ${DEFAULT_INPUT_FILENAME} not found in standard locations.`)
        console.log('Run Codex at least once, or pass --input with an explicit usage JSON file.')
        inputPath = fallbackPath
      } else {
        fromCodex = true
      }
    }
  }

  const userId = command === 'legacy-sync' ? firstArg : undefined

  return {
    command,
    userId,
    uploadToken,
    inputPath,
    apiBaseUrl,
    verbose,
    forceUpload,
    fromCodex,
  }
}

interface LastUpdateCursor {
  day: string | null
  timestamp: string | null
}

async function getLastUpdateCursor(
  baseUrl: string,
  auth: { uploadToken?: string; userId?: string },
  provider: Provider,
  verbose: boolean
): Promise<LastUpdateCursor | null> {
  const url = new URL('/api/get_last_update_day', baseUrl)
  if (auth.userId) {
    url.searchParams.set('userId', auth.userId)
  }
  url.searchParams.set('provider', provider)

  try {
    const response = await fetch(url, {
      headers: auth.uploadToken
        ? { Authorization: `Bearer ${auth.uploadToken}` }
        : undefined
    })
    if (response.status === 404) {
      if (verbose) {
        console.log('No previous uploads found for this provider.')
      }
      return null
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch last update day (${response.status})`)
    }
    const data = await response.json() as { lastUpdateDay?: string; lastUpdateTimestamp?: string }
    return {
      day: data.lastUpdateDay ?? null,
      timestamp: data.lastUpdateTimestamp ?? null
    }
  } catch (error) {
    console.error('Failed to fetch last update day:', error)
    return null
  }
}

function filterDailyEntries(daily: UsageDataPayload['daily'], lastUpdateDay: string | null) {
  if (!lastUpdateDay) return daily
  return daily.filter(day => {
    const normalizedDate = day.date.replace(/-/g, '')
    return normalizedDate > lastUpdateDay
  })
}

function isUsageDataPayloadCandidate(value: unknown): value is UsageDataPayload {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Array.isArray((value as UsageDataPayload).daily)
  )
}

function isLogEventCandidate(value: unknown): value is LogEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as LogEvent
  return typeof event.timestamp === 'string' && typeof event.model === 'string'
}

function toDateKey(timestamp: string): string | null {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().split('T')[0]
}

function aggregateEventsToUsage(events: LogEvent[], provider: Provider): UsageDataPayload {
  if (!events.length) {
    throw new Error('No valid log events found in input file.')
  }

  interface DailyAccumulator {
    date: string
    ide?: string
    sessionId?: string
    tokens: {
      input: number
      output: number
      cacheCreation: number
      cacheRead: number
      reasoning: number
      tool: number
    }
    totalCost: number
    models: Map<string, {
      totalTokens: number
      inputTokens: number
      outputTokens: number
      cacheCreationTokens: number
      cacheReadTokens: number
      reasoningTokens: number
      toolTokens: number
      cost: number
    }>
  }

  const dailyMap = new Map<string, DailyAccumulator>()

  for (const event of events) {
    const dateKey = toDateKey(event.timestamp)
    if (!dateKey) continue

    if (!dailyMap.has(dateKey)) {
      dailyMap.set(dateKey, {
        date: dateKey,
        ide: event.ide,
        sessionId: event.sessionId,
        tokens: {
          input: 0,
          output: 0,
          cacheCreation: 0,
          cacheRead: 0,
          reasoning: 0,
          tool: 0
        },
        totalCost: 0,
        models: new Map()
      })
    }

    const accumulator = dailyMap.get(dateKey)!
    const inputTokens = event.inputTokens ?? 0
    const outputTokens = event.outputTokens ?? 0
    const cacheCreationTokens = event.cacheCreationTokens ?? 0
    const cacheReadTokens = event.cacheReadTokens ?? 0
    const reasoningTokens = event.reasoningTokens ?? 0
    const toolTokens = event.toolTokens ?? 0
    const totalTokens =
      event.totalTokens ??
      inputTokens +
      outputTokens +
      cacheCreationTokens +
      cacheReadTokens +
      reasoningTokens +
      toolTokens

    accumulator.tokens.input += inputTokens
    accumulator.tokens.output += outputTokens
    accumulator.tokens.cacheCreation += cacheCreationTokens
    accumulator.tokens.cacheRead += cacheReadTokens
    accumulator.tokens.reasoning += reasoningTokens
    accumulator.tokens.tool += toolTokens
    const eventCost = event.cost ?? estimateCodexCost(event)
    accumulator.totalCost += eventCost

    const modelKey = event.model
    if (!accumulator.models.has(modelKey)) {
      accumulator.models.set(modelKey, {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        reasoningTokens: 0,
        toolTokens: 0,
        cost: 0
      })
    }

    const modelTotals = accumulator.models.get(modelKey)!
    modelTotals.totalTokens += totalTokens
    modelTotals.inputTokens += inputTokens
    modelTotals.outputTokens += outputTokens
    modelTotals.cacheCreationTokens += cacheCreationTokens
    modelTotals.cacheReadTokens += cacheReadTokens
    modelTotals.reasoningTokens += reasoningTokens
    modelTotals.toolTokens += toolTokens
    modelTotals.cost += eventCost
  }

  const daily: DailyUsagePayload[] = Array.from(dailyMap.values())
    .map((day): DailyUsagePayload => {
      const modelBreakdowns: ModelBreakdownPayload[] = Array.from(day.models.entries())
        .map(([modelName, totals]) => ({
          modelName,
          provider,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          cacheCreationTokens: totals.cacheCreationTokens,
          cacheReadTokens: totals.cacheReadTokens,
          reasoningTokens: totals.reasoningTokens,
          toolTokens: totals.toolTokens,
          cost: totals.cost,
          totalTokens: totals.totalTokens
        }))

      const totalTokens =
        day.tokens.input +
        day.tokens.output +
        day.tokens.cacheCreation +
        day.tokens.cacheRead +
        day.tokens.reasoning +
        day.tokens.tool

      return {
        date: day.date,
        provider,
        ide: day.ide,
        sessionId: day.sessionId,
        inputTokens: day.tokens.input,
        outputTokens: day.tokens.output,
        cacheCreationTokens: day.tokens.cacheCreation,
        cacheReadTokens: day.tokens.cacheRead,
        reasoningTokens: day.tokens.reasoning,
        toolTokens: day.tokens.tool,
        totalTokens,
        totalCost: day.totalCost,
        modelsUsed: modelBreakdowns.map(breakdown => breakdown.modelName),
        modelBreakdowns
      }
    })
    .sort((a, b) => a.date.localeCompare(b.date))

  return {
    provider,
    metadata: { source: 'log-events' },
    daily
  }
}

async function loadUsageData(filePath: string, provider: Provider): Promise<UsageDataPayload> {
  const absolutePath = resolve(process.cwd(), filePath)
  const raw = await readFile(absolutePath, 'utf-8')
  const parsed = JSON.parse(raw)

  if (isUsageDataPayloadCandidate(parsed)) {
    return {
      provider,
      metadata: parsed.metadata,
      daily: parsed.daily || []
    }
  }

  const events = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.events)
      ? parsed.events
      : null

  if (!events) {
    throw new Error('Input file must be a UsageDataPayload or an array of log events.')
  }

  const logEvents = events.filter(isLogEventCandidate)
  return aggregateEventsToUsage(logEvents, provider)
}

function extractLatestRateLimits(payload: UsageDataPayload | null): RateLimitsSnapshot | null {
  if (!payload?.daily?.length) return null
  for (let i = payload.daily.length - 1; i >= 0; i--) {
    const entry = payload.daily[i]
    if (entry?.metadata && 'rateLimits' in entry.metadata && entry.metadata.rateLimits) {
      return entry.metadata.rateLimits as RateLimitsSnapshot
    }
  }
  return null
}

function formatDayForCcusage(day: string | null): string | null {
  if (!day) return null
  if (day.includes('-')) return day
  if (day.length === 8) {
    return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6)}`
  }
  return null
}

function computeCcusageWindow(lastCursorDay: string | null): string {
  if (!lastCursorDay) {
    const now = new Date()
    const resetDate = new Date(now)
    resetDate.setDate(now.getDate() - now.getDay())
    return resetDate.toISOString().split('T')[0]
  }

  const date = formatDayForCcusage(lastCursorDay)
  if (date) return date

  const parsed = Date.parse(lastCursorDay)
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString().split('T')[0]
  }

  const fallback = new Date()
  fallback.setDate(fallback.getDate() - 7)
  return fallback.toISOString().split('T')[0]
}

async function loadUsageFromCcusage(
  sinceDay: string | null,
  provider: Provider,
  verbose: boolean,
  latestRateLimits?: RateLimitsSnapshot | null
): Promise<UsageDataPayload | null> {
  try {
    const sinceArg = computeCcusageWindow(sinceDay)
    const args = ['--yes', 'ccusage', 'daily', '--json', '--since', sinceArg]
    if (verbose) {
      console.log(`Fetching Codex usage via ccusage (since ${sinceArg})...`)
    }
    const { stdout } = await execFileAsync('npx', args, { maxBuffer: 10 * 1024 * 1024 })
    const report = JSON.parse(stdout) as {
      daily?: Array<{
        date?: string
        period?: string
        inputTokens?: number
        cachedInputTokens?: number
        cacheReadTokens?: number
        cacheCreationTokens?: number
        outputTokens?: number
        reasoningOutputTokens?: number
        reasoningTokens?: number
        totalTokens?: number
        costUSD?: number
        totalCost?: number
        modelsUsed?: string[]
        modelBreakdowns?: Array<{
          modelName: string
          inputTokens?: number
          cachedInputTokens?: number
          cacheReadTokens?: number
          cacheCreationTokens?: number
          outputTokens?: number
          reasoningOutputTokens?: number
          reasoningTokens?: number
          totalTokens?: number
          cost?: number
          costUSD?: number
        }>
        models?: Record<string, {
          inputTokens?: number
          cachedInputTokens?: number
          cacheReadTokens?: number
          outputTokens?: number
          reasoningOutputTokens?: number
          reasoningTokens?: number
          totalTokens?: number
          isFallback?: boolean
        }>
      }>
    }

    if (!report?.daily || report.daily.length === 0) {
      if (verbose) {
        console.log('ccusage returned no usage data.')
      }
      return null
    }

    const daily = report.daily.map(entry => {
      const entryDate = entry.date ?? entry.period
      if (!entryDate) {
        throw new Error('ccusage entry missing date/period')
      }
      const parsedDate = new Date(`${entryDate}T00:00:00Z`)
      if (Number.isNaN(parsedDate.getTime())) {
        throw new Error(`Invalid ccusage date: ${entryDate}`)
      }
      const isoDate = parsedDate.toISOString().split('T')[0]
      const totalCost = entry.costUSD ?? entry.totalCost ?? 0
      const models = entry.modelBreakdowns
        ? Object.fromEntries(entry.modelBreakdowns.map(model => [model.modelName, model]))
        : entry.models || {}
      const modelBreakdowns: ModelBreakdownPayload[] = Object.entries(models).map(([modelName, stats]) => {
        const cacheReadTokens = stats.cacheReadTokens ?? stats.cachedInputTokens ?? 0
        const reasoningTokens = stats.reasoningTokens ?? stats.reasoningOutputTokens ?? 0
        const totalTokens = stats.totalTokens ?? (
          (stats.inputTokens ?? 0) +
          cacheReadTokens +
          (stats.outputTokens ?? 0) +
          reasoningTokens
        )
        const share = entry.totalTokens && entry.totalTokens > 0
          ? totalTokens / entry.totalTokens
          : 1
        const costShare = stats.cost ?? stats.costUSD ?? (totalCost * share)

        return {
          modelName,
          provider,
          inputTokens: stats.inputTokens ?? 0,
          outputTokens: stats.outputTokens ?? 0,
          cacheCreationTokens: stats.cacheCreationTokens ?? 0,
          cacheReadTokens,
          reasoningTokens,
          toolTokens: 0,
          cost: costShare,
          totalTokens
        }
      })

      const modelsUsed = entry.modelsUsed ?? Object.keys(models)
      const totalTokens = entry.totalTokens ?? (
        (entry.inputTokens ?? 0) +
        (entry.cacheReadTokens ?? entry.cachedInputTokens ?? 0) +
        (entry.outputTokens ?? 0) +
        (entry.reasoningTokens ?? entry.reasoningOutputTokens ?? 0)
      )

      const metadata: Record<string, unknown> = { source: 'ccusage-codex' }

      return {
        date: isoDate,
        provider,
        ide: 'codex-ccusage',
        sessionId: undefined,
        inputTokens: entry.inputTokens ?? 0,
        outputTokens: entry.outputTokens ?? 0,
        cacheCreationTokens: entry.cacheCreationTokens ?? 0,
        cacheReadTokens: entry.cacheReadTokens ?? entry.cachedInputTokens ?? 0,
        reasoningTokens: entry.reasoningTokens ?? entry.reasoningOutputTokens ?? 0,
        toolTokens: 0,
        totalTokens,
        totalCost,
        modelsUsed,
        modelBreakdowns,
        metadata
      }
    })

    if (latestRateLimits && daily.length > 0) {
      const lastEntry = daily[daily.length - 1]
      lastEntry.metadata = {
        ...(lastEntry.metadata || {}),
        rateLimits: latestRateLimits
      }
    }

    return {
      provider,
      metadata: { source: 'ccusage-codex' },
      daily
    }
  } catch (error) {
    console.error('Failed to fetch usage via ccusage:', error)
    return null
  }
}

const CODEX_SESSIONS_SUBPATH = 'sessions'

interface CodexSessionTotals {
  input_tokens: number
  cached_input_tokens: number
  output_tokens: number
  reasoning_output_tokens: number
  total_tokens: number
}

async function loadUsageFromCodex(
  lastUpdateTimestamp: string | null,
  verbose: boolean
): Promise<UsageDataPayload> {
  const events = await collectCodexSessions(lastUpdateTimestamp, verbose)

  if (!events.length) {
    if (verbose) {
      console.log('No Codex sessions found after the previous cursor.')
    }
    return {
      provider: 'codex',
      metadata: { source: 'codex-sessions' },
      daily: []
    }
  }

  const daily: DailyUsagePayload[] = events.map(event => {
    const totalTokens =
      event.totalTokens ??
      (event.inputTokens ?? 0) +
        (event.cacheReadTokens ?? 0) +
        (event.outputTokens ?? 0) +
        (event.reasoningTokens ?? 0) +
        (event.toolTokens ?? 0)

    const cost = event.cost ?? estimateCodexCost(event)

    return {
      date: event.timestamp,
      provider: 'codex',
      ide: event.ide ?? 'codex-cli',
      sessionId: event.sessionId,
      inputTokens: event.inputTokens ?? 0,
      outputTokens: event.outputTokens ?? 0,
      cacheCreationTokens: 0,
      cacheReadTokens: event.cacheReadTokens ?? 0,
      reasoningTokens: event.reasoningTokens ?? 0,
      toolTokens: event.toolTokens ?? 0,
      totalTokens,
      totalCost: cost,
      modelsUsed: [event.model],
      modelBreakdowns: [
        {
          modelName: event.model,
          provider: 'codex',
          inputTokens: event.inputTokens ?? 0,
          outputTokens: event.outputTokens ?? 0,
          cacheCreationTokens: 0,
          cacheReadTokens: event.cacheReadTokens ?? 0,
          reasoningTokens: event.reasoningTokens ?? 0,
          toolTokens: event.toolTokens ?? 0,
          cost,
          ide: event.ide,
          sessionId: event.sessionId,
          metadata: event.metadata
        }
      ],
      metadata: event.metadata
    }
  })

  return {
    provider: 'codex',
    metadata: { source: 'codex-sessions' },
    daily
  }
}

async function collectCodexSessions(lastUpdateTimestamp: string | null, verbose: boolean) {
  const codexHome = CODEX_HOME_PATH()
  const sessionsRoot = join(codexHome, CODEX_SESSIONS_SUBPATH)

  if (!existsSync(sessionsRoot)) {
    throw new Error(`Codex sessions directory not found at ${sessionsRoot}. Run Codex at least once before using --from-codex.`)
  }

  const sinceEpoch = lastUpdateTimestamp ? Date.parse(lastUpdateTimestamp) : null
  if (lastUpdateTimestamp && Number.isNaN(sinceEpoch)) {
    throw new Error(`Invalid last update timestamp: ${lastUpdateTimestamp}`)
  }

  const files = await listSessionFiles(sessionsRoot, sinceEpoch)
  if (verbose) {
    console.log(`Scanning ${files.length} Codex session file${files.length === 1 ? '' : 's'}...`)
  }

  const events: LogEvent[] = []

  for (const filePath of files) {
    const event = await parseSessionFile(filePath, sinceEpoch, sessionsRoot)
    if (event) {
      events.push(event)
    }
  }

  return events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
}

async function listSessionFiles(root: string, sinceEpoch: number | null): Promise<string[]> {
  const results: string[] = []
  const years = await safeReadDir(root)
  const sinceDayStart = sinceEpoch ? startOfDayUtc(sinceEpoch) : null

  for (const year of years.filter(isYearDirectory).sort()) {
    const yearPath = join(root, year)
    const months = await safeReadDir(yearPath)

    for (const month of months.filter(isMonthDirectory).sort()) {
      const monthPath = join(yearPath, month)
      const days = await safeReadDir(monthPath)

      for (const day of days.filter(isDayDirectory).sort()) {
        const dayPath = join(monthPath, day)
        const dayEpoch = Date.parse(`${year}-${month}-${day}T00:00:00Z`)
        if (sinceDayStart && !Number.isNaN(dayEpoch) && dayEpoch < sinceDayStart) {
          continue
        }

        const sessionFiles = await safeReadDir(dayPath)
        sessionFiles
          .filter(name => name.endsWith('.jsonl'))
          .sort()
          .forEach(file => results.push(join(dayPath, file)))
      }
    }
  }

  return results
}

async function safeReadDir(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}

function isYearDirectory(name: string) {
  return /^\d{4}$/.test(name)
}

function isMonthDirectory(name: string) {
  return /^\d{2}$/.test(name)
}

function isDayDirectory(name: string) {
  return /^\d{2}$/.test(name)
}

function startOfDayUtc(epoch: number) {
  const date = new Date(epoch)
  date.setUTCHours(0, 0, 0, 0)
  return date.getTime()
}

function normalizeRateLimits(raw: any): RateLimitsSnapshot {
  const snapshot: RateLimitsSnapshot = {}
  if (raw?.primary) {
    snapshot.primary = {
      usedPercent: Number(raw.primary.used_percent ?? raw.primary.usedPercent ?? 0),
      windowMinutes: Number(raw.primary.window_minutes ?? raw.primary.windowMinutes ?? 0),
      resetsAt: Number(raw.primary.resets_at ?? raw.primary.resetsAt ?? 0)
    }
  }
  if (raw?.secondary) {
    snapshot.secondary = {
      usedPercent: Number(raw.secondary.used_percent ?? raw.secondary.usedPercent ?? 0),
      windowMinutes: Number(raw.secondary.window_minutes ?? raw.secondary.windowMinutes ?? 0),
      resetsAt: Number(raw.secondary.resets_at ?? raw.secondary.resetsAt ?? 0)
    }
  }
  return snapshot
}

async function parseSessionFile(
  filePath: string,
  sinceEpoch: number | null,
  sessionsRoot: string
): Promise<LogEvent | null> {
  try {
    let sessionId: string | null = null
    let sessionTimestamp: string | null = null
    let cwd: string | null = null
    let cliVersion: string | null = null
    let modelName: string | null = null
    let latestRateLimits: RateLimitsSnapshot | null = null
    let totals: CodexSessionTotals = {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0
    }
    let observedUsage = false
    let malformedLineCount = 0

    const lines = createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity
    })

    for await (const line of lines) {
      if (!line) continue
      let entry: any
      try {
        entry = JSON.parse(line)
      } catch {
        malformedLineCount += 1
        continue
      }
      switch (entry.type) {
        case 'session_meta':
          sessionId = entry.payload?.id ?? sessionId
          sessionTimestamp = entry.payload?.timestamp ?? entry.timestamp ?? sessionTimestamp
          cwd = entry.payload?.cwd ?? cwd
          cliVersion = entry.payload?.cli_version ?? cliVersion
          break
        case 'turn_context':
          if (entry.payload?.model) {
            modelName = entry.payload.model
          }
          if (!cwd && entry.payload?.cwd) {
            cwd = entry.payload.cwd
          }
          break
        case 'event_msg':
          if (entry.payload?.type === 'token_count') {
            const info = entry.payload?.info
            const delta =
              info?.last_token_usage ??
              info?.total_token_usage ??
              null
            if (delta) {
              observedUsage = true
              totals.input_tokens += delta.input_tokens ?? 0
              totals.cached_input_tokens += delta.cached_input_tokens ?? 0
              totals.output_tokens += delta.output_tokens ?? 0
              totals.reasoning_output_tokens += delta.reasoning_output_tokens ?? 0
              totals.total_tokens += delta.total_tokens ?? 0
            }
            if (entry.payload?.rate_limits) {
              latestRateLimits = normalizeRateLimits(entry.payload.rate_limits)
            }
          }
          break
      }
    }

    if (!sessionTimestamp || !observedUsage) {
      return null
    }

    const sessionEpoch = Date.parse(sessionTimestamp)
    if (Number.isNaN(sessionEpoch)) {
      return null
    }
    if (sinceEpoch && sessionEpoch <= sinceEpoch) {
      return null
    }

    const metadata: Record<string, unknown> = {
      codexSessionFile: filePath.replace(sessionsRoot, `~/.codex/${CODEX_SESSIONS_SUBPATH}`)
    }
    if (cwd) {
      metadata.cwd = cwd
    }
    if (cliVersion) {
      metadata.cliVersion = cliVersion
    }
    if (sessionId) {
      metadata.codexSessionId = sessionId
    }
    if (latestRateLimits && (latestRateLimits.primary || latestRateLimits.secondary)) {
      metadata.rateLimits = latestRateLimits
    }
    if (malformedLineCount > 0) {
      metadata.malformedLineCount = malformedLineCount
    }

    const event: LogEvent = {
      timestamp: sessionTimestamp,
      model: modelName ?? 'gpt-5-codex',
      provider: 'codex',
      sessionId: sessionId ?? undefined,
      ide: 'codex-cli',
      metadata,
      rateLimits: latestRateLimits ?? undefined,
      inputTokens: totals.input_tokens,
      cacheReadTokens: totals.cached_input_tokens,
      outputTokens: totals.output_tokens,
      reasoningTokens: totals.reasoning_output_tokens,
      totalTokens: totals.total_tokens > 0
        ? totals.total_tokens
        : totals.input_tokens +
          totals.cached_input_tokens +
          totals.output_tokens +
          totals.reasoning_output_tokens
    }

    event.cost = estimateCodexCost(event)
    return event
  } catch (error) {
    console.warn(`Failed to parse Codex session file ${filePath}:`, error instanceof Error ? error.message : error)
    return null
  }
}

async function uploadUsage(apiBaseUrl: string, payload: UsageRequestPayload, uploadToken?: string) {
  const response = await fetch(new URL('/api/usage', apiBaseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(uploadToken ? { Authorization: `Bearer ${uploadToken}` } : {})
    },
    body: JSON.stringify(payload)
  })

  const body = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(`Upload failed (${response.status}): ${JSON.stringify(body)}`)
  }

  return body
}

async function verifyUploadToken(apiBaseUrl: string, token: string) {
  const response = await fetch(new URL('/api/cli-upload-tokens/verify', apiBaseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`Token verification failed (${response.status}): ${JSON.stringify(body)}`)
  }
}

function printPayloadSummary(payload: UsageRequestPayload) {
  const rows = payload.data.daily.reduce((sum, day) => sum + day.modelBreakdowns.length, 0)
  const totalTokens = payload.data.daily.reduce((sum, day) => sum + (day.totalTokens ?? 0), 0)
  const firstDate = payload.data.daily[0]?.date ?? 'n/a'
  const lastDate = payload.data.daily[payload.data.daily.length - 1]?.date ?? 'n/a'

  console.log('Codextime upload preview')
  console.log(`Rows: ${rows}`)
  console.log(`Days/sessions: ${payload.data.daily.length}`)
  console.log(`Date range: ${firstDate} -> ${lastDate}`)
  console.log(`Total tokens: ${totalTokens}`)
  console.log('Uploads: token counts, model names, timestamps, optional usage metadata')
  console.log('Does not upload: prompts, responses, source code, file contents, secrets, or environment variables')
}

async function buildPayload(options: CliOptions, provider: Provider): Promise<UsageRequestPayload | null> {
  const { userId, inputPath, apiBaseUrl, verbose, forceUpload, fromCodex, uploadToken, command } = options

  if (!fromCodex && !inputPath) {
    throw new Error('Input file path is required when Codex log ingestion is not enabled.')
  }

  const auth = command === 'legacy-sync'
    ? { userId }
    : { uploadToken }

  const lastUpdateCursor = command === 'preview' || forceUpload
    ? null
    : await getLastUpdateCursor(apiBaseUrl, auth, provider, verbose)

  let localUsageData: UsageDataPayload | null = null
  let ccusageData: UsageDataPayload | null = null

  if (fromCodex) {
    ccusageData = await loadUsageFromCcusage(
      forceUpload ? null : lastUpdateCursor?.day ?? null,
      provider,
      verbose
    )
  }

  if (!ccusageData || !ccusageData.daily.length) {
    localUsageData = fromCodex
      ? await loadUsageFromCodex(lastUpdateCursor?.timestamp ?? null, verbose)
      : await loadUsageData(inputPath!, provider)

    if (!localUsageData.daily.length && fromCodex && !forceUpload && command !== 'preview') {
      console.log('No Codex sessions found after the previous cursor. Replaying full history to stay in sync...')
      const replayed = await loadUsageFromCodex(null, verbose)
      localUsageData.daily = replayed.daily
    }
  }

  const latestRateLimits = localUsageData ? extractLatestRateLimits(localUsageData) : null
  if (ccusageData && latestRateLimits && ccusageData.daily.length > 0) {
    const lastEntry = ccusageData.daily[ccusageData.daily.length - 1]
    lastEntry.metadata = {
      ...(lastEntry.metadata || {}),
      rateLimits: latestRateLimits
    }
  }

  const usageData: UsageDataPayload = ccusageData && ccusageData.daily.length > 0
    ? ccusageData
    : localUsageData!

  if (!usageData.daily.length) {
    console.log('No daily entries found in input data.')
    return null
  }

  let filteredDaily = forceUpload || fromCodex || command === 'preview'
    ? usageData.daily
    : filterDailyEntries(usageData.daily, lastUpdateCursor?.day ?? null)

  if (!filteredDaily.length && fromCodex && !forceUpload && command !== 'preview') {
    console.log('No incremental sessions to upload. Replaying full Codex history once more.')
    filteredDaily = usageData.daily
  }

  if (!filteredDaily.length) {
    console.log('No new usage to upload (all entries already processed). Use --force to resend the entire file.')
    return null
  }

  const payload: UsageRequestPayload = {
    userId: userId ?? 'token-authenticated',
    provider,
    data: {
      ...usageData,
      provider,
      daily: filteredDaily
    }
  }

  if (!isValidUsageRequest(payload)) {
    throw new Error('Payload failed validation. Ensure input file matches UsageDataPayload schema.')
  }

  return payload
}

async function runLogin(options: CliOptions) {
  const token = options.uploadToken ?? await promptForToken()
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error('Invalid Codextime upload token format.')
  }
  await verifyUploadToken(options.apiBaseUrl, token)
  saveConfig({
    ...loadConfig(),
    apiBaseUrl: options.apiBaseUrl,
    uploadToken: token
  })
  console.log(`Saved Codextime upload token ${maskToken(token)}.`)
}

async function runDoctor(options: CliOptions) {
  const config = loadConfig()
  const token = options.uploadToken ?? config.uploadToken
  console.log('Codextime doctor')
  console.log(`API: ${options.apiBaseUrl}`)
  console.log(`Config: ${existsSync(CODEXTIME_CONFIG_PATH) ? CODEXTIME_CONFIG_PATH : 'not found'}`)
  console.log(`Upload token: ${maskToken(token)}`)
  console.log(`Codex home: ${CODEX_HOME_PATH()} (${codexHomeExists() ? 'found' : 'not found'})`)
  if (token) {
    await verifyUploadToken(options.apiBaseUrl, token)
    console.log('Upload token: verified')
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options) {
    return
  }

  const provider: Provider = 'codex'

  if (options.command === 'login') {
    await runLogin(options)
    return
  }

  if (options.command === 'doctor') {
    await runDoctor(options)
    return
  }

  if (options.verbose) {
    console.log(`Using API base URL: ${options.apiBaseUrl}`)
    console.log(`Provider: ${provider}`)
    console.log(options.fromCodex ? 'Ingesting directly from local Codex session logs.' : `Reading input: ${options.inputPath}`)
    console.log(`Applying Codex pricing defaults from ${CODEX_PRICING.docsUrl}`)
  }

  if (options.command === 'sync' && !options.uploadToken) {
    throw new Error('Upload token is required. Run `codextime login` first, or set CODEXTIME_UPLOAD_TOKEN.')
  }

  if (options.command === 'legacy-sync') {
    console.warn('Warning: legacy user ID sync is temporary, unverified, and stops working after June 17, 2026.')
    console.warn('Recommended setup: npx codextime@latest login && npx codextime@latest sync')
  }

  const payload = await buildPayload(options, provider)
  if (!payload) return

  if (options.command === 'preview') {
    printPayloadSummary(payload)
    return
  }

  const result = await uploadUsage(options.apiBaseUrl, payload, options.uploadToken)
  console.log(`Upload complete. Processed ${result.processed ?? 0} records.`)
  if (result.verificationStatus) {
    console.log(`Verification: ${result.verificationStatus}`)
  }
  if (result.errors && result.errors.length > 0) {
    console.log('Errors:', result.errors)
  }
}

main().catch(error => {
  console.error('codextime failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
