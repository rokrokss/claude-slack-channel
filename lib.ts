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
  // Check allowlist
  if (opts.access.allowFrom.includes(ev['user'] as string)) {
    return { action: 'deliver', access: opts.access }
  }
  return { action: 'drop' }
}
