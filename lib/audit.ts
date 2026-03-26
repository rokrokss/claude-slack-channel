import { join } from 'path'
import { appendFileSync, mkdirSync } from 'fs'

export interface AuditEntry {
  ts: string
  direction: 'inbound' | 'outbound'
  userId?: string
  chatId: string
  action: string
  threadTs?: string
  text?: string
  replyTo?: string
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
