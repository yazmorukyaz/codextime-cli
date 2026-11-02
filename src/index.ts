#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import process from 'node:process'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CCUSAGE_VERSION, normalizeCodexDailyReport } from './ccusage-report.js'
import { partitionUpload } from './upload-batches.js'
import { automaticAccount, runAutomaticSync } from './automatic-sync.js'
import {
  UsageRequestPayload,
  UsageDataPayload,
  DailyUsagePayload,
  ModelBreakdownPayload,
  isValidUsageRequest,
  Provider
} from './usage-payload.js'

interface CliOptions {
  command: 'preview' | 'login' | 'sync' | 'watch' | 'doctor' | 'legacy-sync'
  userId?: string
  uploadToken?: string
  inputPath?: string
  apiBaseUrl: string
  verbose: boolean
  forceUpload: boolean
  fromCodex: boolean
  automatic?: boolean
  interval?: number
  deviceName?: string
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

const CCUSAGE_PACKAGE = `ccusage@${CCUSAGE_VERSION}`

const execFileAsync = promisify(execFile)

function estimateCodexCost(event: LogEvent) {
  if (event.cost === undefined) throw new Error('Manual event imports require an explicit cost; automatic model pricing is available through --from-codex.')
  return event.cost
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
  codextime preview --automatic
  codextime sync --automatic [--device-name "Work laptop"]
  codextime watch [--interval 300] [--device-name "Work laptop"]

Automatic mode detects session projects locally and deduplicates copied sessions across devices.
First enrollment freezes legacy uploads and selects a clean UTC tracking boundary.
Run the new CLI on each computer. Watch runs in the foreground until stopped; no service is installed.

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
  const command = ['preview', 'login', 'sync', 'watch', 'doctor'].includes(firstArg)
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

  const automatic = argv.includes('--automatic') || command === 'watch'
  const interval = Number(getFlagValue(argv, '--interval') ?? 300)
  const deviceName = getFlagValue(argv, '--device-name')
  if (!Number.isSafeInteger(interval) || interval < 60 || interval > 3600) throw Error('Watch interval must be an integer from 60 to 3600 seconds')
  if (deviceName !== undefined && (!deviceName.trim() || deviceName.length > 80 || /[\x00-\x1f\x7f/\\]/.test(deviceName))) throw Error('Invalid device name')
  if (automatic) {
    if (argv.includes('--input') || process.env.CODEXTIME_USAGE_FILE) throw Error('Automatic sync uses Codex logs, not manual input files')
    return { command, uploadToken, apiBaseUrl, verbose, forceUpload, fromCodex: true, automatic, interval, deviceName }
  }

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
      cacheReadTokens

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
        day.tokens.cacheRead

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

async function loadUsageFromCcusage(sinceDay: string | null, verbose: boolean): Promise<UsageDataPayload> {
  const args = ['--yes', CCUSAGE_PACKAGE, 'daily', '--json', '--by-agent', '--timezone', 'UTC']
  if (sinceDay) args.push('--since', computeCcusageWindow(sinceDay))
  if (verbose) console.log('Reading Codex-only usage from ccusage per-agent model breakdowns.')
  try {
    const { stdout } = await execFileAsync('npx', args, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 })
    return normalizeCodexDailyReport(JSON.parse(stdout))
  } catch {
    throw new Error('Unable to read reliable Codex usage from ccusage. No fallback totals were generated.')
  }
}

function withInstallationProvenance(payload: UsageRequestPayload): UsageRequestPayload {
  const installationPath = resolve(CODEXTIME_CONFIG_DIR, 'installation-id')
  mkdirSync(CODEXTIME_CONFIG_DIR, { recursive: true, mode: 0o700 })
  if (!existsSync(installationPath)) {
    try { writeFileSync(installationPath, randomUUID(), { mode: 0o600, flag: 'wx' }) }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
  }
  const installationId = readFileSync(installationPath, 'utf8').trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(installationId)) throw new Error('Invalid installation identity; refusing an unattributed upload.')
  const coverage = payload.data.metadata?.source === 'ccusage-codex-daily' ? 'retained-local-logs' : 'manual-input'
  const provenance = { installationId, importerVersion: '0.5.0', coverage, missingLogs: 'unknown', cloudCoverage: 'not-included' }
  return {
    ...payload,
    data: {
      ...payload.data,
      metadata: { ...payload.data.metadata, ...provenance },
      daily: payload.data.daily.map(day => ({
        ...day,
        metadata: { ...day.metadata, ...provenance },
        modelBreakdowns: day.modelBreakdowns.map(model => ({
          ...model, metadata: { ...model.metadata, ...provenance }
        }))
      }))
    }
  }
}

async function uploadUsage(apiBaseUrl: string, payload: UsageRequestPayload, uploadToken?: string) {
  const response = await fetch(new URL('/api/usage', apiBaseUrl), {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
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

  if (body.success === false || body.status === 'failed' || body.status === 'partial_success' || (Array.isArray(body.errors) && body.errors.length > 0)) {
    throw new Error(`Upload incomplete: ${body.processed ?? 0} records saved. Fix the rejected rows and retry. ${JSON.stringify(body.errors ?? [])}`)
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
  const totalTokens = payload.data.daily.reduce((sum, day) => sum + day.modelBreakdowns.reduce(
    (total, model) => total + model.inputTokens + model.outputTokens + (model.cacheCreationTokens ?? 0) + (model.cacheReadTokens ?? 0), 0
  ), 0)
  const firstDate = payload.data.daily[0]?.date ?? 'n/a'
  const lastDate = payload.data.daily[payload.data.daily.length - 1]?.date ?? 'n/a'

  console.log('Codextime upload preview')
  console.log(`Rows: ${rows}`)
  console.log(`Days/sessions: ${payload.data.daily.length}`)
  console.log(`Date range: ${firstDate} -> ${lastDate}`)
  console.log(`Total tokens: ${totalTokens}`)
  const unpricedRows = payload.data.daily.flatMap(day => day.modelBreakdowns).filter(model => model.metadata?.pricingStatus === 'unknown').length
  if (unpricedRows) console.log(`Pricing unavailable for ${unpricedRows} model rows. Zero placeholders are not free usage.`)
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

  const usageData = fromCodex
    ? await loadUsageFromCcusage(forceUpload ? null : lastUpdateCursor?.day ?? null, verbose)
    : await loadUsageData(inputPath!, provider)

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
  console.log(`Usage engine: ccusage ${CCUSAGE_VERSION}; Codex entries only; UTC; retained local logs`)
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

  if (options.automatic || (options.command === 'sync' && options.fromCodex && options.uploadToken)) {
    const account = options.uploadToken && !options.automatic ? await automaticAccount(options.apiBaseUrl, options.uploadToken) : null
    if (options.automatic || account) {
      await runAutomaticSync({ apiBaseUrl: options.apiBaseUrl, token: options.uploadToken, configDir: CODEXTIME_CONFIG_DIR,
        homes: (process.env.CODEX_HOME || resolve(HOME_DIRECTORY, '.codex')).split(',').map(home => resolve(home.trim())),
        enroll: Boolean(options.automatic), preview: options.command === 'preview', watch: options.command === 'watch', interval: options.interval || 300, deviceName: options.deviceName }, account || undefined)
      return
    }
  }

  if (options.verbose) {
    console.log(`Using API base URL: ${options.apiBaseUrl}`)
    console.log(`Provider: ${provider}`)
    console.log(options.fromCodex ? 'Ingesting directly from local Codex session logs.' : `Reading input: ${options.inputPath}`)
    console.log('Pricing uses per-model ccusage estimates; missing prices remain explicitly unknown.')
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

  let processed = 0
  let verificationStatus: string | undefined
  const today = new Date().toISOString().slice(0, 10)
  const completed = payload.data.daily.filter(day => day.date.slice(0, 10) < today)
  if (!completed.length) throw new Error('No completed UTC days to upload. Today remains local until the day closes.')
  if (completed.length !== payload.data.daily.length) console.log('Open UTC days remain local until the day closes.')
  const completedPayload = withInstallationProvenance({ ...payload, data: { ...payload.data, daily: completed } })
  for (const batch of partitionUpload(completedPayload)) {
    const uploaded = await uploadUsage(options.apiBaseUrl, batch, options.uploadToken)
    processed += uploaded.processed ?? 0
    verificationStatus = uploaded.verificationStatus
  }
  const result = { processed, verificationStatus }
  console.log(`Upload complete. Processed ${result.processed ?? 0} records.`)
  if (result.verificationStatus) {
    console.log(`Verification: ${result.verificationStatus}`)
  }
}

main().catch(error => {
  console.error('codextime failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
