/**
 * lib.ts — Pure, testable functions for the Slack Channel MCP server.
 * All functions are side-effect-free or accept dependencies as parameters.
 */

import { resolve, join } from 'path'
import { appendFileSync, mkdirSync } from 'fs'

// Types

export interface Access {
  allowFrom: string[]
  ackReaction?: string
  botOwner?: string
}

export type GateAction = 'deliver' | 'drop'

export interface GateResult {
  action: GateAction
  access?: Access
}

export interface GateOptions {
  access: Access
  botUserId: string
}

// Access helpers

export function defaultAccess(): Access {
  return { allowFrom: [] }
}

// Formatting

export function fixSlackMrkdwn(text: string): string {
  return text.replace(/\*([^*]+)\*/g, '\u200B*$1*\u200B')
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[\[\]\n\r;]/g, '_').replace(/\.\./g, '_')
}

// Block Kit parsing

export function extractMessageText(msg: Record<string, any>): string {
  const parts: string[] = []

  if (msg.blocks) {
    for (const block of msg.blocks) {
      if (block.type === 'rich_text' && block.elements) {
        for (const elem of block.elements) {
          if (elem.elements) {
            parts.push(elem.elements.map((e: any) => e.text ?? '').join(''))
          }
        }
      } else if (block.type === 'section') {
        if (block.text?.text) parts.push(block.text.text)
        if (block.fields) {
          parts.push(block.fields.map((f: any) => f.text ?? '').join(' '))
        }
      } else if (block.type === 'header') {
        if (block.text?.text) parts.push(`*${block.text.text}*`)
      } else if (block.type === 'context' && block.elements) {
        const texts = block.elements.map((e: any) => e.text ?? '').filter(Boolean)
        if (texts.length) parts.push(texts.join(' '))
      } else if (block.type === 'divider') {
        parts.push('---')
      } else if (block.type === 'image') {
        parts.push(block.alt_text || block.title?.text || '[image]')
      } else if (block.text?.text) {
        parts.push(block.text.text)
      }
    }
  }

  if (parts.length > 0) return parts.join('\n')

  if (msg.text) return msg.text

  if (msg.attachments) {
    for (const att of msg.attachments) {
      const attParts: string[] = []
      if (att.blocks) {
        const inner = extractMessageText({ blocks: att.blocks })
        if (inner) attParts.push(inner)
      }
      if (att.pretext) attParts.push(att.pretext)
      if (att.title && att.title_link) {
        attParts.push(`<${att.title_link}|${att.title}>`)
      } else if (att.title) {
        attParts.push(att.title)
      }
      if (att.text) attParts.push(att.text)
      if (att.fields) {
        for (const f of att.fields) {
          if (f.title || f.value) attParts.push(`${f.title ?? ''}: ${f.value ?? ''}`)
        }
      }
      if (att.image_url) attParts.push(`[image: ${att.image_url}]`)
      if (attParts.length === 0 && att.from_url) attParts.push(att.from_url)
      if (attParts.length === 0 && att.fallback) attParts.push(att.fallback)
      if (attParts.length > 0) parts.push(attParts.join('\n'))
    }
  }

  if (parts.length > 0) return parts.join('\n')

  if (msg.files) {
    return msg.files.map((f: any) => `[file: ${f.name || f.title || f.id}]`).join(', ')
  }

  return msg.text || ''
}

// Audit

export interface AuditEntry {
  ts: string
  direction: 'inbound' | 'outbound'
  userId?: string
  chatId: string
  action: string // 'deliver' | 'drop' | tool name
  threadTs?: string
  text?: string
  replyTo?: string // inbound message_id this outbound is responding to
}

export function formatAuditLine(entry: AuditEntry): string {
  return JSON.stringify(entry) + '\n'
}

export function auditLog(stateDir: string, entry: AuditEntry): void {
  const dir = join(stateDir, 'audit')
  mkdirSync(dir, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  appendFileSync(join(dir, `${date}.jsonl`), formatAuditLine(entry))
}

// Security

export function assertSendable(filePath: string, stateDir: string, inboxDir: string): void {
  const resolved = resolve(filePath)
  if (resolved.startsWith(stateDir) && !resolved.startsWith(inboxDir)) {
    throw new Error(
      `Blocked: cannot send files from state directory (${stateDir}). Only files in inbox/ are sendable.`,
    )
  }
}

export function assertOutboundAllowed(
  chatId: string,
  deliveredChannels: ReadonlySet<string>,
): void {
  if (deliveredChannels.has(chatId)) return
  throw new Error(
    `Outbound gate: channel ${chatId} has not received any inbound messages.`,
  )
}

// Permalink

export function buildPermalink(workspace: string, channel: string, ts: string, threadTs?: string): string {
  const tsNoDot = ts.replace('.', '')
  const base = `https://${workspace}.slack.com/archives/${channel}/p${tsNoDot}`
  if (threadTs) {
    return `${base}?thread_ts=${threadTs}&cid=${channel}`
  }
  return base
}

// Event helpers

export function isDm(event: Record<string, unknown>): boolean {
  return event['channel_type'] === 'im'
}

export function resolveThreadTs(event: Record<string, unknown>): string {
  return (event['thread_ts'] as string) || (event['ts'] as string) || ''
}

// Stale event filtering

export function parseSlackTimestamp(ts: string): Date | null {
  if (!/^\d+\.\d+$/.test(ts)) return null
  const sec = parseFloat(ts)
  return new Date(sec * 1000)
}

/** Default: 10 minutes in milliseconds */
export const DEFAULT_STALE_THRESHOLD_MS = 10 * 60 * 1000

export function isStaleEvent(eventTs: string, maxAgeMs: number = DEFAULT_STALE_THRESHOLD_MS): boolean {
  const date = parseSlackTimestamp(eventTs)
  if (!date) return false // can't determine age → don't drop
  return Date.now() - date.getTime() > maxAgeMs
}

// Event deduplication

export class EventDeduplicator {
  private seen = new Map<string, number>() // key → timestamp
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

// Rate limiting (per-channel sliding window)

export class RateLimiter {
  private windows = new Map<string, number[]>() // channel → timestamps
  private readonly maxEvents: number
  private readonly windowMs: number

  constructor(maxEvents: number, windowMs: number) {
    this.maxEvents = maxEvents
    this.windowMs = windowMs
  }

  /** Returns true if the event should be rate-limited (dropped). */
  isRateLimited(channel: string): boolean {
    const now = Date.now()
    const cutoff = now - this.windowMs

    let timestamps = this.windows.get(channel)
    if (!timestamps) {
      timestamps = []
      this.windows.set(channel, timestamps)
    }

    // Remove expired entries
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift()
    }

    if (timestamps.length >= this.maxEvents) {
      return true
    }

    timestamps.push(now)
    return false
  }
}

// Empty message filtering

export function isEmptyMessage(event: Record<string, unknown>): boolean {
  // Has files, blocks, or attachments → not empty
  if (event['files'] && (event['files'] as unknown[]).length > 0) return false
  if (event['blocks'] && (event['blocks'] as unknown[]).length > 0) return false
  if (event['attachments'] && (event['attachments'] as unknown[]).length > 0) return false
  // Check text
  const text = (event['text'] as string) || ''
  return text.trim().length === 0
}

// Gate

export function gate(event: unknown, opts: GateOptions): GateResult {
  const ev = event as Record<string, unknown>

  // Skip our own bot's messages (prevent infinite loops)
  if (ev['user'] && ev['user'] === opts.botUserId) return { action: 'drop' }
  // Allow file_share and bot_message subtypes, drop others
  if (ev['subtype'] && ev['subtype'] !== 'file_share' && ev['subtype'] !== 'bot_message') {
    return { action: 'drop' }
  }
  // Bot messages are always delivered (no user to check)
  if (ev['subtype'] === 'bot_message') return { action: 'deliver', access: opts.access }
  // Require user
  if (!ev['user']) return { action: 'drop' }
  // Check owner
  if (opts.access.botOwner && ev['user'] === opts.access.botOwner) {
    return { action: 'deliver', access: opts.access }
  }
  // Check allowlist
  if (opts.access.allowFrom.includes(ev['user'] as string)) {
    return { action: 'deliver', access: opts.access }
  }
  return { action: 'drop' }
}
