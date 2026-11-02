import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import {
  SESSION_ENGINE_VERSION,
  isSessionSyncPayload,
  type SessionSyncPayload,
  type SessionSnapshot
} from './session-sync.js'
import { discoverSessionSources, sessionSnapshots } from './session-sources.js'
const exec = promisify(execFile)
interface SyncAccount {
  id: string
  start_day: string
  enrolled_at: string
}
export interface AutomaticOptions {
  apiBaseUrl: string
  token?: string
  configDir: string
  homes: string[]
  enroll: boolean
  preview: boolean
  watch: boolean
  interval: number
  deviceName?: string
  signal?: AbortSignal
}
export function installationIdentity(configDir: string) {
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  const file = resolve(configDir, 'installation-id')
  try {
    writeFileSync(file, randomUUID(), { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'))
      throw error
  }
  const id = readFileSync(file, 'utf8').trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
    throw Error('Invalid installation identity')
  return id
}
function endpoint(apiBaseUrl: string) {
  const url = new URL('/api/session-sync', apiBaseUrl)
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw Error('Automatic sync requires HTTPS, except on localhost')
  return url
}
async function request(options: AutomaticOptions, body?: unknown) {
  if (!options.token) throw Error('Run codextime login before automatic sync')
  const response = await fetch(endpoint(options.apiBaseUrl), {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${options.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([
      AbortSignal.timeout(30000),
      ...(options.signal ? [options.signal] : [])
    ])
  })
  if (!response.ok)
    throw Error(
      `Automatic sync failed (${response.status}). No historical data was replaced. Retry after checking login, source version, or tracking window.`
    )
  return response.json()
}
export async function automaticAccount(apiBaseUrl: string, token: string) {
  const result = await request({
    apiBaseUrl,
    token,
    configDir: '',
    homes: [],
    enroll: false,
    preview: false,
    watch: false,
    interval: 300
  })
  return result.account as SyncAccount | null
}
export function batchSessionSnapshots(
  base: Omit<SessionSyncPayload, 'items'>,
  items: SessionSnapshot[],
  maxBytes = 90 * 1024
) {
  const batches: SessionSyncPayload[] = []
  let current: SessionSnapshot[] = []
  for (const item of items) {
    if (
      current.length >= 500 ||
      Buffer.byteLength(JSON.stringify({ ...base, items: [...current, item] })) > maxBytes
    ) {
      if (!current.length) throw Error('One session snapshot exceeds the upload limit')
      batches.push({ ...base, items: current })
      current = []
    }
    if (Buffer.byteLength(JSON.stringify({ ...base, items: [item] })) > maxBytes)
      throw Error('One session snapshot exceeds the upload limit')
    current.push(item)
  }
  if (current.length || !batches.length) batches.push({ ...base, items: current })
  return batches
}
export async function runAutomaticSync(options: AutomaticOptions, existing?: SyncAccount) {
  let account =
    existing || (options.token ? await automaticAccount(options.apiBaseUrl, options.token) : null)
  if (!account && !options.preview) {
    if (!options.enroll && !options.watch)
      throw Error('Enable automatic sync explicitly with --automatic')
    account = (await request(options, { kind: 'enroll' })).account
  }
  const startDay = account?.start_day || new Date().toISOString().slice(0, 10)
  console.log(
    `${options.preview ? 'Preview window' : 'Automatic tracking starts'}: ${startDay} UTC. Historical imports remain unchanged.`
  )
  if (!options.preview)
    console.log('Legacy uploads are frozen for this account. Upgrade the CLI on every device.')
  const installationId = options.preview
    ? '00000000-0000-4000-8000-000000000000'
    : installationIdentity(options.configDir)
  const base = {
    installationId,
    deviceName: options.deviceName || `Installation ${installationId.slice(0, 8)}`,
    windowStart: startDay,
    engineVersion: SESSION_ENGINE_VERSION
  }
  const acknowledged = new Set<string>()
  let previousSignature: string | null = null
  let stopped = false,
    wake: (() => void) | undefined
  const abort = new AbortController()
  options = { ...options, signal: abort.signal }
  const stop = () => {
    stopped = true
    abort.abort()
    wake?.()
  }
  if (options.watch) {
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  }
  try {
    do {
      try {
        const sources = await discoverSessionSources(options.homes)
        let items: SessionSnapshot[] = []
        if (
          sources.files.length &&
          startDay <= new Date().toISOString().slice(0, 10) &&
          (sources.signature !== previousSignature || options.preview)
        ) {
          const { stdout } = await exec(
            'npx',
            [
              '--yes',
              `ccusage@${SESSION_ENGINE_VERSION}`,
              'daily',
              '--json',
              '--by-agent',
              '--sections',
              'session',
              '--timezone',
              'UTC',
              '--since',
              startDay,
              '--offline',
              '--no-cost'
            ],
            {
              env: { ...process.env, CODEX_HOME: options.homes.join(',') },
              maxBuffer: 50 * 1024 * 1024,
              timeout: 240000,
              signal: abort.signal
            }
          )
          const result = await sessionSnapshots(
            JSON.parse(stdout),
            sources.files,
            options.configDir
          )
          items = result.items
          if (result.skipped)
            console.warn(
              `${result.skipped} sources or report rows were ambiguous or unreadable and were not synced.`
            )
        }
        if (options.preview) {
          const projects = new Set(
            items.flatMap((item) => (item.project ? [item.project.key] : []))
          )
          console.log(
            `Preview: ${items.length} session/model snapshots, ${projects.size} detected projects. No enrollment or upload performed.`
          )
          return
        }
        const pending = items.filter(
          (item) =>
            !acknowledged.has(createHash('sha256').update(JSON.stringify(item)).digest('hex'))
        )
        let added = 0,
          held = 0
        for (const payload of batchSessionSnapshots(base, pending)) {
          if (!isSessionSyncPayload(payload))
            throw Error('Invalid automatic sync payload; no guessing or fallback applied')
          const result = await request(options, payload)
          if (result.success !== true || result.processed !== payload.items.length)
            throw Error('Automatic sync was not confirmed')
          added += result.addedTokens
          held += result.held
          for (const item of payload.items)
            acknowledged.add(createHash('sha256').update(JSON.stringify(item)).digest('hex'))
        }
        previousSignature = sources.signature
        console.log(
          `Automatic sync: ${added} new tracked tokens; ${held} held observations. Duplicate devices are not summed.`
        )
      } catch (error) {
        if (stopped) break
        if (!options.watch) throw error
        console.error(error instanceof Error ? error.message : 'Automatic sync failed; will retry')
      }
      if (options.watch && !stopped)
        await new Promise<void>((resolveWait) => {
          const timer = setTimeout(() => {
            wake = undefined
            resolveWait()
          }, options.interval * 1000)
          wake = () => {
            clearTimeout(timer)
            resolveWait()
          }
        })
    } while (options.watch && !stopped)
  } finally {
    if (options.watch) {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
    }
  }
}
