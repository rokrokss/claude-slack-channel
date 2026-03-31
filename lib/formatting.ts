export function fixSlackMrkdwn(text: string): string {
  return text.replace(/\*([^*]+)\*/g, '\u200B*$1*\u200B')
}

function richTextElementToString(e: any): string {
  switch (e.type) {
    case 'link': return e.text || e.url || ''
    case 'user': return `<@${e.user_id}>`
    case 'channel': return `<#${e.channel_id}>`
    case 'usergroup': return `<!subteam^${e.usergroup_id}>`
    case 'emoji': return e.unicode ? String.fromCodePoint(...e.unicode.split('-').map((h: string) => parseInt(h, 16))) : `:${e.name}:`
    case 'broadcast': return `<!${e.range}>`
    case 'color': return e.value ?? ''
    case 'date': return e.fallback ?? `<!date^${e.timestamp}^${e.format}>`
    case 'team': return `<!team^${e.team_id}>`
    default: return e.text ?? ''
  }
}

export function extractMessageText(msg: Record<string, any>): string {
  const parts: string[] = []

  if (msg.blocks) {
    for (const block of msg.blocks) {
      if (block.type === 'rich_text' && block.elements) {
        for (const elem of block.elements) {
          if (elem.elements) {
            parts.push(elem.elements.map(richTextElementToString).join(''))
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
        const texts = block.elements.map((e: any) => {
          if (e.type === 'image') return e.alt_text || '[image]'
          return e.text ?? ''
        }).filter(Boolean)
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
