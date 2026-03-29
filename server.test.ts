import { describe, test, expect } from 'bun:test'
import {
  gate,
  assertOutboundAllowed,
  defaultAccess,
  fixSlackMrkdwn,
  extractMessageText,
  formatAuditLine,
  auditLog,
  buildPermalink,
  isDm,
  resolveThreadTs,
  parseSlackTimestamp,
  isStaleEvent,
  isEmptyMessage,
  EventDeduplicator,
  hasChannelsFlag,
  type Access,
  type AuditEntry,
  type GateOptions,
} from './lib/index.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccess(overrides: Partial<Access> = {}): Access {
  return { ...defaultAccess(), ...overrides }
}

function makeOpts(overrides: Partial<GateOptions> = {}): GateOptions {
  return {
    access: makeAccess(),
    botUserId: 'U_BOT',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// gate()
// ---------------------------------------------------------------------------

describe('gate', () => {
  test('drops messages from our own bot (user === botUserId)', () => {
    const result = gate(
      { user: 'U_BOT', channel_type: 'im', channel: 'D1' },
      makeOpts({ botUserId: 'U_BOT' }),
    )
    expect(result.action).toBe('drop')
  })

  test('drops message_changed subtype', () => {
    const result = gate(
      { subtype: 'message_changed', user: 'U123', channel: 'D1' },
      makeOpts(),
    )
    expect(result.action).toBe('drop')
  })

  test('drops message_deleted subtype', () => {
    const result = gate(
      { subtype: 'message_deleted', user: 'U123', channel: 'D1' },
      makeOpts(),
    )
    expect(result.action).toBe('drop')
  })

  test('drops channel_join subtype', () => {
    const result = gate(
      { subtype: 'channel_join', user: 'U123', channel: 'D1' },
      makeOpts(),
    )
    expect(result.action).toBe('drop')
  })

  test('allows file_share subtype through', () => {
    const access = makeAccess({ allowFrom: ['U123'] })
    const result = gate(
      { subtype: 'file_share', user: 'U123', channel: 'D1' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('deliver')
  })

  test('drops messages with no user field', () => {
    const result = gate(
      { channel: 'D1' },
      makeOpts(),
    )
    expect(result.action).toBe('drop')
  })

  // -- allowlist --

  test('delivers from allowlisted users', () => {
    const access = makeAccess({ allowFrom: ['U_ALLOWED'] })
    const result = gate(
      { user: 'U_ALLOWED', channel: 'D1' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('deliver')
    expect(result.access).toBeDefined()
  })

  test('drops from non-allowlisted users', () => {
    const access = makeAccess({ allowFrom: ['U_OTHER'] })
    const result = gate(
      { user: 'U_STRANGER', channel: 'D1' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('drop')
  })

  test('drops when allowlist is empty', () => {
    const result = gate(
      { user: 'U_ANYONE', channel: 'D1' },
      makeOpts(),
    )
    expect(result.action).toBe('drop')
  })

  test('delivers from allowlisted user in channel', () => {
    const access = makeAccess({ allowFrom: ['U_ALLOWED'] })
    const result = gate(
      { user: 'U_ALLOWED', channel: 'C_ANY', channel_type: 'channel' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('deliver')
  })

  test('drops from non-allowlisted user in channel', () => {
    const access = makeAccess({ allowFrom: ['U_VIP'] })
    const result = gate(
      { user: 'U_NOBODY', channel: 'C_ANY', channel_type: 'channel' },
      makeOpts({ access }),
    )
    expect(result.action).toBe('drop')
  })

  // -- bot_message --

  test('delivers bot_message from any channel', () => {
    const result = gate(
      { subtype: 'bot_message', bot_id: 'B_OTHER', channel: 'C_ANY' },
      makeOpts(),
    )
    expect(result.action).toBe('deliver')
  })

  test('delivers bot_message in DM', () => {
    const result = gate(
      { subtype: 'bot_message', bot_id: 'B_OTHER', channel: 'D1', channel_type: 'im' },
      makeOpts(),
    )
    expect(result.action).toBe('deliver')
  })

  test('allows other bot with user field if in allowlist', () => {
    const access = makeAccess({ allowFrom: ['U_OTHER_BOT'] })
    const result = gate(
      { bot_id: 'B_OTHER', user: 'U_OTHER_BOT', channel: 'D1' },
      makeOpts({ access, botUserId: 'U_BOT' }),
    )
    expect(result.action).toBe('deliver')
  })
})

// ---------------------------------------------------------------------------
// assertOutboundAllowed()
// ---------------------------------------------------------------------------

describe('assertOutboundAllowed', () => {
  test('allows delivered channels', () => {
    const delivered = new Set(['D_DELIVERED'])
    expect(() => assertOutboundAllowed('D_DELIVERED', delivered)).not.toThrow()
  })

  test('blocks unknown channels', () => {
    expect(() => assertOutboundAllowed('C_RANDO', new Set())).toThrow('Outbound gate')
  })

  test('blocks channels not delivered to', () => {
    const delivered = new Set(['D_DIFFERENT'])
    expect(() => assertOutboundAllowed('C_ATTACKER', delivered)).toThrow('Outbound gate')
  })
})

// ---------------------------------------------------------------------------
// defaultAccess()
// ---------------------------------------------------------------------------

describe('defaultAccess', () => {
  test('returns empty allowlist', () => {
    expect(defaultAccess().allowFrom).toEqual([])
  })

  test('has no ackReaction by default', () => {
    expect(defaultAccess().ackReaction).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// fixSlackMrkdwn()
// ---------------------------------------------------------------------------

describe('fixSlackMrkdwn', () => {
  test('inserts ZWS around bold', () => {
    expect(fixSlackMrkdwn('*hello*')).toBe('\u200B*hello*\u200B')
  })

  test('handles multiple bold patterns', () => {
    const result = fixSlackMrkdwn('*a* and *b*')
    expect(result).toBe('\u200B*a*\u200B and \u200B*b*\u200B')
  })

  test('leaves text without bold unchanged', () => {
    expect(fixSlackMrkdwn('no bold here')).toBe('no bold here')
  })

  test('handles empty string', () => {
    expect(fixSlackMrkdwn('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// auditLog
// ---------------------------------------------------------------------------

describe('formatAuditLine', () => {
  test('produces JSON with trailing newline', () => {
    const entry: AuditEntry = {
      ts: '2026-03-25T12:00:00.000Z',
      direction: 'inbound',
      userId: 'U123',
      chatId: 'C456',
      action: 'deliver',
    }
    const line = formatAuditLine(entry)
    expect(line.endsWith('\n')).toBe(true)
    expect(JSON.parse(line.trim())).toEqual(entry)
  })

  test('includes optional fields when present', () => {
    const entry: AuditEntry = {
      ts: '2026-03-25T12:00:00.000Z',
      direction: 'outbound',
      chatId: 'C456',
      action: 'reply',
      threadTs: '1234.5678',
      text: 'hello world',
    }
    const parsed = JSON.parse(formatAuditLine(entry).trim())
    expect(parsed.threadTs).toBe('1234.5678')
    expect(parsed.text).toBe('hello world')
    expect(parsed.userId).toBeUndefined()
  })

  test('omits undefined fields', () => {
    const entry: AuditEntry = {
      ts: '2026-03-25T12:00:00.000Z',
      direction: 'inbound',
      chatId: 'C456',
      action: 'drop',
    }
    const line = formatAuditLine(entry).trim()
    expect(line).not.toContain('userId')
    expect(line).not.toContain('threadTs')
    expect(line).not.toContain('"text"')
  })
})

describe('auditLog', () => {
  test('writes to audit directory without throwing', () => {
    const tmpDir = `/tmp/slack-audit-test-${Date.now()}`
    auditLog(tmpDir, {
      ts: '2026-03-25T12:00:00.000Z',
      direction: 'inbound',
      userId: 'U123',
      chatId: 'C456',
      action: 'deliver',
    })
    const { existsSync, readFileSync, rmSync } = require('fs')
    const { join } = require('path')
    const auditDir = join(tmpDir, 'audit')
    expect(existsSync(auditDir)).toBe(true)
    const files = require('fs').readdirSync(auditDir)
    expect(files.length).toBe(1)
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.jsonl$/)
    const content = readFileSync(join(auditDir, files[0]), 'utf-8')
    const parsed = JSON.parse(content.trim())
    expect(parsed.action).toBe('deliver')
    rmSync(tmpDir, { recursive: true })
  })

  test('throws on invalid path', () => {
    expect(() => {
      auditLog('/dev/null/impossible', {
        ts: '2026-03-25T12:00:00.000Z',
        direction: 'inbound',
        chatId: 'C456',
        action: 'drop',
      })
    }).toThrow()
  })
})

// ---------------------------------------------------------------------------
// extractMessageText()
// ---------------------------------------------------------------------------

describe('extractMessageText', () => {
  test('returns plain text from text field', () => {
    expect(extractMessageText({ text: 'hello world' })).toBe('hello world')
  })

  test('returns empty string for empty message', () => {
    expect(extractMessageText({})).toBe('')
  })

  test('parses rich_text blocks', () => {
    const msg = {
      blocks: [{
        type: 'rich_text',
        elements: [{
          elements: [
            { text: 'hello ' },
            { text: 'world' },
          ],
        }],
      }],
    }
    expect(extractMessageText(msg)).toBe('hello world')
  })

  test('parses section blocks', () => {
    const msg = {
      blocks: [{
        type: 'section',
        text: { text: 'Section content' },
      }],
    }
    expect(extractMessageText(msg)).toBe('Section content')
  })

  test('parses section with fields', () => {
    const msg = {
      blocks: [{
        type: 'section',
        fields: [{ text: 'Field 1' }, { text: 'Field 2' }],
      }],
    }
    expect(extractMessageText(msg)).toBe('Field 1 Field 2')
  })

  test('parses header blocks', () => {
    const msg = {
      blocks: [{ type: 'header', text: { text: 'My Header' } }],
    }
    expect(extractMessageText(msg)).toBe('*My Header*')
  })

  test('parses context blocks', () => {
    const msg = {
      blocks: [{
        type: 'context',
        elements: [{ text: 'Context 1' }, { text: 'Context 2' }],
      }],
    }
    expect(extractMessageText(msg)).toBe('Context 1 Context 2')
  })

  test('parses divider blocks', () => {
    const msg = {
      blocks: [
        { type: 'section', text: { text: 'Above' } },
        { type: 'divider' },
        { type: 'section', text: { text: 'Below' } },
      ],
    }
    expect(extractMessageText(msg)).toBe('Above\n---\nBelow')
  })

  test('parses image blocks', () => {
    const msg = {
      blocks: [{ type: 'image', alt_text: 'A chart' }],
    }
    expect(extractMessageText(msg)).toBe('A chart')
  })

  test('falls back to text when no blocks', () => {
    const msg = { text: 'fallback text', blocks: [] }
    expect(extractMessageText(msg)).toBe('fallback text')
  })

  test('parses attachments', () => {
    const msg = {
      attachments: [{
        pretext: 'Alert',
        title: 'CPU High',
        title_link: 'https://grafana.example.com',
        text: 'CPU usage > 90%',
      }],
    }
    expect(extractMessageText(msg)).toContain('Alert')
    expect(extractMessageText(msg)).toContain('<https://grafana.example.com|CPU High>')
    expect(extractMessageText(msg)).toContain('CPU usage > 90%')
  })

  test('parses attachment fields', () => {
    const msg = {
      attachments: [{
        fields: [
          { title: 'Status', value: 'Critical' },
          { title: 'Region', value: 'us-east-1' },
        ],
      }],
    }
    const result = extractMessageText(msg)
    expect(result).toContain('Status: Critical')
    expect(result).toContain('Region: us-east-1')
  })

  test('uses fallback when attachment has no content', () => {
    const msg = {
      attachments: [{ fallback: 'Fallback text' }],
    }
    expect(extractMessageText(msg)).toBe('Fallback text')
  })

  test('parses attachment with image_url', () => {
    const msg = {
      attachments: [{ image_url: 'https://example.com/img.png' }],
    }
    expect(extractMessageText(msg)).toBe('[image: https://example.com/img.png]')
  })

  test('parses blocks inside attachments', () => {
    const msg = {
      attachments: [{
        blocks: [{
          type: 'section',
          text: { text: 'Inner block content' },
        }],
      }],
    }
    expect(extractMessageText(msg)).toBe('Inner block content')
  })

  test('returns file descriptions for file-only messages', () => {
    const msg = {
      files: [
        { name: 'report.pdf' },
        { name: 'data.csv' },
      ],
    }
    expect(extractMessageText(msg)).toBe('[file: report.pdf], [file: data.csv]')
  })

  test('blocks take priority over text', () => {
    const msg = {
      text: 'plain text',
      blocks: [{ type: 'section', text: { text: 'block text' } }],
    }
    expect(extractMessageText(msg)).toBe('block text')
  })

  test('multiple block types combined', () => {
    const msg = {
      blocks: [
        { type: 'header', text: { text: 'Alert' } },
        { type: 'section', text: { text: 'Something broke' } },
        { type: 'context', elements: [{ text: 'via Grafana' }] },
      ],
    }
    const result = extractMessageText(msg)
    expect(result).toBe('*Alert*\nSomething broke\nvia Grafana')
  })
})

// ---------------------------------------------------------------------------
// buildPermalink()
// ---------------------------------------------------------------------------

describe('buildPermalink', () => {
  const workspace = 'msuniverse'

  test('root message permalink', () => {
    const result = buildPermalink(workspace, 'C09GDRYF3FF', '1774461389.128779')
    expect(result).toBe('https://msuniverse.slack.com/archives/C09GDRYF3FF/p1774461389128779')
  })

  test('thread reply permalink', () => {
    const result = buildPermalink(workspace, 'C09GDRYF3FF', '1774461419.933019', '1774461389.128779')
    expect(result).toBe('https://msuniverse.slack.com/archives/C09GDRYF3FF/p1774461419933019?thread_ts=1774461389.128779&cid=C09GDRYF3FF')
  })

  test('ts dot removal', () => {
    const result = buildPermalink(workspace, 'C123', '1234567890.123456')
    expect(result).toBe('https://msuniverse.slack.com/archives/C123/p1234567890123456')
  })
})

// ---------------------------------------------------------------------------
// isDm()
// ---------------------------------------------------------------------------

describe('isDm', () => {
  test('channel_type im is DM', () => {
    expect(isDm({ channel_type: 'im' })).toBe(true)
  })
  test('channel_type channel is not DM', () => {
    expect(isDm({ channel_type: 'channel' })).toBe(false)
  })
  test('no channel_type is not DM', () => {
    expect(isDm({})).toBe(false)
  })
  test('app_mention event (no channel_type) is not DM', () => {
    expect(isDm({ type: 'app_mention' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// resolveThreadTs()
// ---------------------------------------------------------------------------

describe('resolveThreadTs', () => {
  test('uses thread_ts when present', () => {
    expect(resolveThreadTs({ thread_ts: '111.222', ts: '333.444' })).toBe('111.222')
  })
  test('falls back to ts when thread_ts is missing', () => {
    expect(resolveThreadTs({ ts: '333.444' })).toBe('333.444')
  })
  test('falls back to ts when thread_ts is empty string', () => {
    expect(resolveThreadTs({ thread_ts: '', ts: '333.444' })).toBe('333.444')
  })
})

// ---------------------------------------------------------------------------
// parseSlackTimestamp()
// ---------------------------------------------------------------------------

describe('parseSlackTimestamp', () => {
  test('parses standard Slack timestamp', () => {
    const result = parseSlackTimestamp('1711500000.123456')
    expect(result).toBeInstanceOf(Date)
    expect(result!.getTime()).toBe(1711500000123)
  })

  test('returns null for invalid timestamp', () => {
    expect(parseSlackTimestamp('')).toBeNull()
    expect(parseSlackTimestamp('not-a-number')).toBeNull()
    expect(parseSlackTimestamp('123abc')).toBeNull()
    expect(parseSlackTimestamp('123')).toBeNull()
  })

  test('handles integer timestamp without fractional part', () => {
    const result = parseSlackTimestamp('1711500000.000000')
    expect(result).toBeInstanceOf(Date)
  })
})

// ---------------------------------------------------------------------------
// isStaleEvent()
// ---------------------------------------------------------------------------

describe('isStaleEvent', () => {
  test('returns true for event older than maxAge', () => {
    const oldTs = String((Date.now() / 1000) - 700) // 11+ minutes ago
    expect(isStaleEvent(oldTs, 600_000)).toBe(true)
  })

  test('returns false for recent event', () => {
    const recentTs = String(Date.now() / 1000) // now
    expect(isStaleEvent(recentTs, 600_000)).toBe(false)
  })

  test('returns false for unparseable timestamp', () => {
    expect(isStaleEvent('', 600_000)).toBe(false)
  })

  test('respects custom maxAge', () => {
    const ts = String((Date.now() / 1000) - 30) // 30 seconds ago
    expect(isStaleEvent(ts, 60_000)).toBe(false)  // 1 min threshold
    expect(isStaleEvent(ts, 20_000)).toBe(true)   // 20 sec threshold
  })
})

// ---------------------------------------------------------------------------
// isEmptyMessage()
// ---------------------------------------------------------------------------

describe('isEmptyMessage', () => {
  test('returns true for empty text', () => {
    expect(isEmptyMessage({ text: '' })).toBe(true)
  })

  test('returns true for whitespace-only text', () => {
    expect(isEmptyMessage({ text: '   \n\t  ' })).toBe(true)
  })

  test('returns true for no text field', () => {
    expect(isEmptyMessage({})).toBe(true)
  })

  test('returns false for message with text', () => {
    expect(isEmptyMessage({ text: 'hello' })).toBe(false)
  })

  test('returns false for message with files (no text)', () => {
    expect(isEmptyMessage({ files: [{ id: 'F1' }] })).toBe(false)
  })

  test('returns false for message with blocks (no text)', () => {
    expect(isEmptyMessage({ blocks: [{ type: 'section' }] })).toBe(false)
  })

  test('returns false for message with attachments', () => {
    expect(isEmptyMessage({ attachments: [{ text: 'alert' }] })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// EventDeduplicator
// ---------------------------------------------------------------------------

describe('EventDeduplicator', () => {
  test('first occurrence returns false (not duplicate)', () => {
    const dedup = new EventDeduplicator(60_000)
    expect(dedup.isDuplicate('C1', '1234.5678')).toBe(false)
  })

  test('second occurrence returns true (duplicate)', () => {
    const dedup = new EventDeduplicator(60_000)
    dedup.isDuplicate('C1', '1234.5678')
    expect(dedup.isDuplicate('C1', '1234.5678')).toBe(true)
  })

  test('different channels with same ts are not duplicates', () => {
    const dedup = new EventDeduplicator(60_000)
    dedup.isDuplicate('C1', '1234.5678')
    expect(dedup.isDuplicate('C2', '1234.5678')).toBe(false)
  })

  test('different ts in same channel are not duplicates', () => {
    const dedup = new EventDeduplicator(60_000)
    dedup.isDuplicate('C1', '1234.5678')
    expect(dedup.isDuplicate('C1', '1234.9999')).toBe(false)
  })

  test('entries expire after TTL', () => {
    const dedup = new EventDeduplicator(50) // 50ms TTL
    dedup.isDuplicate('C1', '1234.5678')
    // Wait for expiry
    const start = Date.now()
    while (Date.now() - start < 60) {} // busy wait 60ms
    expect(dedup.isDuplicate('C1', '1234.5678')).toBe(false)
  })

  test('cleanup removes expired entries', () => {
    const dedup = new EventDeduplicator(50, 1) // TTL 50ms, cleanup every call
    dedup.isDuplicate('C1', '1.0')
    dedup.isDuplicate('C1', '2.0')
    const start = Date.now()
    while (Date.now() - start < 60) {}
    dedup.isDuplicate('C1', '3.0') // triggers cleanup (interval=1)
    expect(dedup.size).toBe(1) // only '3.0' remains
  })
})

// ---------------------------------------------------------------------------
// hasChannelsFlag()
// ---------------------------------------------------------------------------

describe('hasChannelsFlag', () => {
  test('returns true for --dangerously-load-development-channels', () => {
    expect(hasChannelsFlag('claude --dangerously-load-development-channels server:slack-channel')).toBe(true)
  })

  test('returns true for --channels flag', () => {
    expect(hasChannelsFlag('claude --channels plugin:telegram@anthropic')).toBe(true)
  })

  test('returns false for plain claude', () => {
    expect(hasChannelsFlag('claude')).toBe(false)
  })

  test('returns false for other flags', () => {
    expect(hasChannelsFlag('claude --allow-dangerously-skip-permissions')).toBe(false)
  })

  test('returns false for empty string', () => {
    expect(hasChannelsFlag('')).toBe(false)
  })

  test('returns true when flag is among multiple args', () => {
    expect(hasChannelsFlag('claude --verbose --dangerously-load-development-channels server:slack-channel --model opus')).toBe(true)
  })

  test('does not match --channels as substring of another flag', () => {
    expect(hasChannelsFlag('claude --channelsFoo bar')).toBe(false)
  })

  test('matches --channels=value syntax', () => {
    expect(hasChannelsFlag('claude --channels=plugin:foo@bar')).toBe(true)
  })

  test('SLACK_FORCE_SOCKET_MODE=1 overrides detection', () => {
    const prev = process.env['SLACK_FORCE_SOCKET_MODE']
    try {
      process.env['SLACK_FORCE_SOCKET_MODE'] = '1'
      expect(hasChannelsFlag('')).toBe(true)
    } finally {
      if (prev === undefined) delete process.env['SLACK_FORCE_SOCKET_MODE']
      else process.env['SLACK_FORCE_SOCKET_MODE'] = prev
    }
  })
})

