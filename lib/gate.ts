export interface Access {
  allowFrom: string[]
  ackReaction?: string
  botOwner?: string
}

export interface GateResult {
  action: 'deliver' | 'drop'
  access?: Access
}

export interface GateOptions {
  access: Access
  botUserId: string
}

export function defaultAccess(): Access {
  return { allowFrom: [] }
}

export function gate(event: unknown, opts: GateOptions): GateResult {
  const ev = event as Record<string, unknown>

  if (ev['user'] && ev['user'] === opts.botUserId) return { action: 'drop' }
  if (ev['subtype'] && ev['subtype'] !== 'file_share' && ev['subtype'] !== 'bot_message') {
    return { action: 'drop' }
  }
  if (ev['subtype'] === 'bot_message') return { action: 'deliver', access: opts.access }
  if (!ev['user']) return { action: 'drop' }
  if (opts.access.botOwner && ev['user'] === opts.access.botOwner) {
    return { action: 'deliver', access: opts.access }
  }
  if (opts.access.allowFrom.includes(ev['user'] as string)) {
    return { action: 'deliver', access: opts.access }
  }
  return { action: 'drop' }
}
