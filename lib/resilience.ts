import { DEFAULT_STALE_THRESHOLD_MS } from './event.ts'

export class EventDeduplicator {
  private seen = new Map<string, number>()
  private readonly ttlMs: number
  private readonly cleanupInterval: number

  private callCount = 0

  constructor(ttlMs: number = DEFAULT_STALE_THRESHOLD_MS, cleanupInterval: number = 100) {
    this.ttlMs = ttlMs
    this.cleanupInterval = cleanupInterval
  }

  /** Returns true if this event was already seen (duplicate). */
  isDuplicate(channel: string, ts: string): boolean {
    const key = `${channel}:${ts}`
    const now = Date.now()

    // Periodic cleanup
    if (++this.callCount % this.cleanupInterval === 0) {
      this.cleanup(now)
    }

    const existing = this.seen.get(key)
    if (existing !== undefined && now - existing < this.ttlMs) {
      return true
    }

    this.seen.set(key, now)
    return false
  }

  private cleanup(now: number): void {
    for (const [key, timestamp] of this.seen) {
      if (now - timestamp >= this.ttlMs) {
        this.seen.delete(key)
      }
    }
  }

  get size(): number {
    return this.seen.size
  }
}
