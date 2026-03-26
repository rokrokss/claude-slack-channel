export function isDm(event: Record<string, unknown>): boolean {
  return event['channel_type'] === 'im'
}

export function resolveThreadTs(event: Record<string, unknown>): string {
  return (event['thread_ts'] as string) || (event['ts'] as string) || ''
}

export function parseSlackTimestamp(ts: string): Date | null {
  if (!/^\d+\.\d+$/.test(ts)) return null
  const sec = parseFloat(ts)
  return new Date(sec * 1000)
}

/** Default: 10 minutes in milliseconds */
export const DEFAULT_STALE_THRESHOLD_MS = 10 * 60 * 1000

export function isStaleEvent(eventTs: string, maxAgeMs: number = DEFAULT_STALE_THRESHOLD_MS): boolean {
  const date = parseSlackTimestamp(eventTs)
  if (!date) return false
  return Date.now() - date.getTime() > maxAgeMs
}

export function isEmptyMessage(event: Record<string, unknown>): boolean {
  if (event['files'] && (event['files'] as unknown[]).length > 0) return false
  if (event['blocks'] && (event['blocks'] as unknown[]).length > 0) return false
  if (event['attachments'] && (event['attachments'] as unknown[]).length > 0) return false
  const text = (event['text'] as string) || ''
  return text.trim().length === 0
}
