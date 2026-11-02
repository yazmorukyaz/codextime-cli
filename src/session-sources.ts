import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import * as zlib from 'node:zlib'
import { StringDecoder } from 'node:string_decoder'
import { createHash } from 'node:crypto'
import type { Transform } from 'node:stream'
import type { SessionSnapshot, SessionProject } from './session-sync.js'
import { projectResolver, remoteProject } from './session-projects.js'

interface Source {
  file: string
  period: string
  id: string
  cwd: string | null
  remote: string | null
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
async function* lines(file: string) {
  const input = createReadStream(file)
  let stream = input as NodeJS.ReadableStream & AsyncIterable<Buffer> & { destroy(): void }
  if (file.endsWith('.zst')) {
    const create = (zlib as unknown as { createZstdDecompress?: () => Transform })
      .createZstdDecompress
    if (!create) {
      input.destroy()
      throw Error('Compressed Codex logs require Node.js 22.15 or later.')
    }
    const decoded = create()
    input.on('error', (error) => decoded.destroy(error))
    stream = input.pipe(decoded) as typeof stream
  }
  const decoder = new StringDecoder('utf8')
  let pending = '',
    dropping = false
  try {
    for await (const chunk of stream) {
      const text = decoder.write(chunk)
      let offset = 0,
        newline: number
      while ((newline = text.indexOf('\n', offset)) >= 0) {
        const part = text.slice(offset, newline)
        if (!dropping && pending.length + part.length <= 8 * 1024 * 1024) yield pending + part
        else yield ''
        pending = ''
        dropping = false
        offset = newline + 1
      }
      if (!dropping) {
        pending += text.slice(offset)
        if (pending.length > 8 * 1024 * 1024) {
          pending = ''
          dropping = true
        }
      }
    }
    pending += decoder.end()
    if (pending && !dropping) yield pending
  } finally {
    input.destroy()
    stream.destroy()
  }
}
async function header(file: string) {
  let inspected = 0
  for await (const line of lines(file)) {
    inspected += line.length
    if (inspected > 256 * 1024) return null
    try {
      const row = JSON.parse(line)
      if (row.type !== 'session_meta') continue
      const id = row.payload?.id || row.payload?.session_id
      return typeof id === 'string' && uuid.test(id)
        ? {
            id: id.toLowerCase(),
            cwd: typeof row.payload.cwd === 'string' ? row.payload.cwd : null,
            remote:
              typeof row.payload.git?.repository_url === 'string'
                ? row.payload.git.repository_url
                : null
          }
        : null
    } catch {
      return null
    }
  }
  return null
}
export async function discoverSessionSources(homes: string[]) {
  const files = new Map<string, { file: string; period: string; expectedId: string | null }>()
  const signature = createHash('sha256')
  for (const home of homes) {
    const roots: string[] = []
    for (const name of ['sessions', 'archived_sessions']) {
      try {
        if ((await stat(resolve(home, name))).isDirectory()) roots.push(resolve(home, name))
      } catch {
        /* Optional root. */
      }
    }
    if (!roots.length) roots.push(home)
    const chosen = new Map<string, { file: string; period: string }>()
    async function walk(root: string, directory: string) {
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name)
      )
      for (const entry of entries) {
        const file = resolve(directory, entry.name)
        if (entry.isDirectory()) await walk(root, file)
        else if (entry.isFile() && /\.jsonl(?:\.zst)?$/.test(entry.name)) {
          const period = relative(root, file)
            .split(sep)
            .join('/')
            .replace(/\.jsonl(?:\.zst)?$/, '')
          if (!chosen.has(period)) chosen.set(period, { file, period })
        }
      }
    }
    for (const root of roots) await walk(root, root)
    for (const value of chosen.values()) {
      const info = await stat(value.file)
      signature.update(value.file + '\0' + info.size + '\0' + info.mtimeMs)
      files.set(value.file, { ...value, expectedId: (await header(value.file))?.id ?? null })
    }
  }
  return { files: [...files.values()], signature: signature.digest('hex') }
}
export async function sessionSnapshots(
  report: unknown,
  files: { file: string; period: string; expectedId?: string | null }[],
  configDir: string
) {
  if (
    !report ||
    typeof report !== 'object' ||
    !('session' in report) ||
    !Array.isArray(report.session)
  )
    throw Error('Unsupported ccusage session report')
  const byPeriod = new Map<string, Source[]>(),
    byId = new Map<string, Source[]>()
  let skipped = 0
  for (const file of files) {
    const metadata = await header(file.file)
    if (!metadata || ('expectedId' in file && metadata.id !== file.expectedId)) {
      skipped++
      continue
    }
    const source = { ...file, ...metadata }
    byPeriod.set(source.period, [...(byPeriod.get(source.period) || []), source])
    byId.set(source.id, [...(byId.get(source.id) || []), source])
  }
  const resolver = await projectResolver(configDir)
  const items: SessionSnapshot[] = []
  const seen = new Set<string>()
  for (const row of report.session) {
    if (row.agent !== 'codex') continue
    const candidates = byPeriod.get(row.period)
    if (!candidates || candidates.length !== 1 || byId.get(candidates[0].id)?.length !== 1) {
      skipped++
      continue
    }
    const source = candidates[0]
    const cwds = new Set<string>(source.cwd ? [source.cwd] : [])
    let ambiguous = false
    for await (const line of lines(source.file)) {
      if (!line) {
        ambiguous = true
        continue
      }
      if (!line.includes('turn_context') && !line.includes('session_meta')) continue
      try {
        const record = JSON.parse(line)
        if (
          ['turn_context', 'session_meta'].includes(record.type) &&
          typeof record.payload?.cwd === 'string'
        )
          cwds.add(record.payload.cwd)
        if (cwds.size > 256) {
          ambiguous = true
          break
        }
      } catch {
        ambiguous = true
      }
    }
    const projects: SessionProject[] = []
    const recorded = source.remote ? remoteProject(source.remote) : null
    for (const cwd of cwds) {
      const detected = await resolver.resolve(cwd)
      const project = cwd === source.cwd && recorded ? recorded : detected
      if (
        cwd === source.cwd &&
        recorded &&
        detected?.kind === 'git_remote' &&
        detected.key !== recorded.key
      )
        ambiguous = true
      if (!project) ambiguous = true
      else if (!projects.some((item) => item.key === project.key)) projects.push(project)
    }
    const project = !ambiguous && projects.length === 1 ? projects[0] : null
    if (!Array.isArray(row.modelBreakdowns)) throw Error('Missing session model breakdowns')
    let sessionTotal = 0
    for (const model of row.modelBreakdowns) {
      const counts = [
        model.inputTokens,
        model.outputTokens,
        model.cacheCreationTokens ?? 0,
        model.cacheReadTokens ?? 0
      ]
      if (
        typeof model.modelName !== 'string' ||
        !model.modelName.trim() ||
        counts.some((n) => !Number.isSafeInteger(n) || n < 0)
      )
        throw Error('Invalid session counters')
      const total = counts.reduce((a, b) => a + b, 0)
      if (!Number.isSafeInteger(total)) throw Error('Session total exceeds precision')
      sessionTotal += total
      const key = JSON.stringify([source.id, model.modelName])
      if (seen.has(key)) throw Error('Ambiguous duplicate engine session')
      seen.add(key)
      if (total)
        items.push({
          sessionId: source.id,
          model: model.modelName,
          input: counts[0],
          output: counts[1],
          cacheCreation: counts[2],
          cacheRead: counts[3],
          project
        })
    }
    if (row.totalTokens !== undefined && row.totalTokens !== sessionTotal)
      throw Error('Session totals disagree with model counters')
  }
  await resolver.save()
  return { items, skipped }
}
