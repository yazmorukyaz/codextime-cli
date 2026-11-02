import type { UsageRequestPayload } from './usage-payload.js'

export function partitionUpload(payload: UsageRequestPayload, maxBytes = 90 * 1024): UsageRequestPayload[] {
  const batches: UsageRequestPayload[] = []
  let days: UsageRequestPayload['data']['daily'] = []
  const withDays = (daily: typeof days) => ({ ...payload, data: { ...payload.data, daily } })
  for (const day of payload.data.daily) {
    const candidate = withDays([...days, day])
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > maxBytes) {
      if (!days.length) throw new Error('One usage day exceeds the upload size limit. No records from that day were sent.')
      batches.push(withDays(days))
      days = []
      if (Buffer.byteLength(JSON.stringify(withDays([day])), 'utf8') > maxBytes) throw new Error('One usage day exceeds the upload size limit.')
    }
    days.push(day)
  }
  if (days.length) batches.push(withDays(days))
  return batches
}
