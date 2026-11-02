export const SESSION_ENGINE_VERSION = '20.0.47'
export interface SessionProject {
  key: string
  name: string
  kind: 'git_remote' | 'local'
}
export interface SessionSnapshot {
  sessionId: string
  model: string
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
  project: SessionProject | null
}
export interface SessionSyncPayload {
  installationId: string
  deviceName: string
  windowStart: string
  engineVersion: string
  items: SessionSnapshot[]
}
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key))
const uuid = (value: unknown) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const label = (value: unknown, max: number) =>
  typeof value === 'string' &&
  value.trim() === value &&
  value.length > 0 &&
  value.length <= max &&
  !/[\x00-\x1f\x7f/\\]/.test(value)
export function isSessionSyncPayload(value: unknown): value is SessionSyncPayload {
  if (
    !object(value) ||
    !exact(value, ['installationId', 'deviceName', 'windowStart', 'engineVersion', 'items']) ||
    !uuid(value.installationId) ||
    !label(value.deviceName, 80) ||
    value.engineVersion !== SESSION_ENGINE_VERSION ||
    typeof value.windowStart !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.windowStart) ||
    !Number.isFinite(Date.parse(value.windowStart)) ||
    new Date(value.windowStart).toISOString().slice(0, 10) !== value.windowStart ||
    !Array.isArray(value.items) ||
    value.items.length > 500
  )
    return false
  const keys = new Set<string>()
  let payloadTotal = 0
  return value.items.every((item) => {
    if (
      !object(item) ||
      !exact(item, [
        'sessionId',
        'model',
        'input',
        'output',
        'cacheCreation',
        'cacheRead',
        'project'
      ]) ||
      !uuid(item.sessionId) ||
      typeof item.model !== 'string' ||
      !item.model.trim() ||
      item.model.length > 200 ||
      /[\x00-\x1f\x7f]/.test(item.model)
    )
      return false
    const counts = [item.input, item.output, item.cacheCreation, item.cacheRead]
    if (
      counts.some((count) => !Number.isSafeInteger(count) || Number(count) < 0) ||
      !Number.isSafeInteger(counts.reduce<number>((sum, count) => sum + Number(count), 0))
    )
      return false
    payloadTotal += counts.reduce<number>((sum, count) => sum + Number(count), 0)
    if (!Number.isSafeInteger(payloadTotal)) return false
    if (
      item.project !== null &&
      (!object(item.project) ||
        !exact(item.project, ['key', 'name', 'kind']) ||
        typeof item.project.key !== 'string' ||
        !/^[a-f0-9]{64}$/.test(item.project.key) ||
        !label(item.project.name, 80) ||
        !['git_remote', 'local'].includes(String(item.project.kind)))
    )
      return false
    const key = JSON.stringify([String(item.sessionId).toLowerCase(), item.model])
    if (keys.has(key)) return false
    keys.add(key)
    return true
  })
}
