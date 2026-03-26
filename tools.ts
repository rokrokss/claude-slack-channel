import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { WebClient } from '@slack/web-api'
import { z } from 'zod'
import { auditLog, fixSlackMrkdwn, extractMessageText } from './lib/index.ts'

export interface ToolDependencies {
  mcp: McpServer
  web: WebClient
  stateDir: string
  defaultColor: string
  assertOutboundAllowed: (chatId: string) => void
  lastInboundMessageId: Map<string, string>
  pendingAckReactions: Map<string, { channel: string; ts: string; emoji: string }>
  resolveUserName: (userId: string) => Promise<string>
}

export function registerTools(deps: ToolDependencies): void {
  const { mcp, web, stateDir, defaultColor, assertOutboundAllowed, lastInboundMessageId, pendingAckReactions, resolveUserName } = deps

  mcp.registerTool('reply', {
    description: 'Send a message to a Slack channel or DM.',
    inputSchema: {
      chat_id: z.string().describe('Slack channel or DM ID'),
      text: z.string().describe('Message text (mrkdwn supported)'),
      thread_ts: z.string().optional().describe('Thread timestamp to reply in-thread (optional)'),
      color: z.string().optional().describe('attachment 색상 hex (기본: #e5da9a)'),
    },
  }, async (args) => {
    console.error(`[slack] reply called: chat_id=${args.chat_id} thread_ts=${args.thread_ts ?? '(none)'} text_len=${args.text?.length ?? 0}`)
    auditLog(stateDir, {
      ts: new Date().toISOString(),
      direction: 'outbound',
      chatId: args.chat_id,
      action: 'reply',
      threadTs: args.thread_ts || undefined,
      text: args.text,
      replyTo: args.thread_ts ? lastInboundMessageId.get(args.thread_ts) : undefined,
    })

    assertOutboundAllowed(args.chat_id)

    const color = args.color || defaultColor

    const res = await web.chat.postMessage({
      channel: args.chat_id,
      thread_ts: args.thread_ts,
      attachments: [{
        color,
        text: fixSlackMrkdwn(args.text),
        mrkdwn_in: ['text'],
      }],
      unfurl_links: false,
      unfurl_media: false,
    })
    const lastTs = (res.ts as string) || ''
    console.error(`[slack] reply sent: chat_id=${args.chat_id} ts=${lastTs}`)

    // Auto-remove ack reaction after reply
    const ackKey = args.thread_ts
    const pendingAck = ackKey ? pendingAckReactions.get(ackKey) : undefined
    if (pendingAck) {
      pendingAckReactions.delete(ackKey!)
      try {
        await web.reactions.remove({
          channel: pendingAck.channel,
          timestamp: pendingAck.ts,
          name: pendingAck.emoji,
        })
        console.error(`[slack] reply ack reaction removed: ${pendingAck.emoji}`)
      } catch (err) { console.error('[slack] ack reaction auto-remove failed:', err) }
    }

    return {
      content: [{
        type: 'text' as const,
        text: `Sent message to ${args.chat_id}${lastTs ? ` [ts: ${lastTs}]` : ''}`,
      }],
    }
  })

  mcp.registerTool('react', {
    description: 'Add an emoji reaction to a Slack message.',
    inputSchema: {
      chat_id: z.string().describe('Channel ID'),
      message_id: z.string().describe('Message timestamp (ts)'),
      emoji: z.string().describe('Emoji name without colons (e.g. "thumbsup")'),
    },
  }, async (args) => {
    console.error(`[slack] react called: chat_id=${args.chat_id} message_id=${args.message_id} emoji=${args.emoji}`)
    auditLog(stateDir, {
      ts: new Date().toISOString(),
      direction: 'outbound',
      chatId: args.chat_id,
      action: 'react',
      replyTo: lastInboundMessageId.get(args.message_id),
    })

    await web.reactions.add({
      channel: args.chat_id,
      timestamp: args.message_id,
      name: args.emoji,
    })
    console.error(`[slack] react done: :${args.emoji}: on ${args.message_id}`)
    return {
      content: [{ type: 'text' as const, text: `Reacted :${args.emoji}: to ${args.message_id}` }],
    }
  })

  mcp.registerTool('delete_bot_message', {
    description: "Delete a previously sent message (bot's own messages only).",
    inputSchema: {
      chat_id: z.string().describe('Channel ID'),
      message_id: z.string().describe('Message timestamp (ts)'),
    },
  }, async (args) => {
    console.error(`[slack] delete_bot_message called: chat_id=${args.chat_id} message_id=${args.message_id}`)
    auditLog(stateDir, {
      ts: new Date().toISOString(),
      direction: 'outbound',
      chatId: args.chat_id,
      action: 'delete_bot_message',
      replyTo: lastInboundMessageId.get(args.message_id),
    })

    await web.chat.delete({ channel: args.chat_id, ts: args.message_id })
    console.error(`[slack] delete_bot_message done: ${args.message_id}`)
    return { content: [{ type: 'text' as const, text: `Deleted message ${args.message_id}` }] }
  })

  mcp.registerTool('fetch_dm_thread', {
    description: 'DM permalink 수신 시에만 사용. 봇 토큰으로만 접근 가능한 DM 스레드를 읽기 위한 용도. 다른 용도로 사용 금지.',
    inputSchema: {
      channel: z.string().describe('DM channel ID'),
      thread_ts: z.string().describe('Thread timestamp'),
    },
  }, async (args) => {
    console.error(`[slack] fetch_dm_thread called: channel=${args.channel} thread_ts=${args.thread_ts}`)
    auditLog(stateDir, {
      ts: new Date().toISOString(),
      direction: 'outbound',
      chatId: args.channel,
      action: 'fetch_dm_thread',
      threadTs: args.thread_ts,
      replyTo: lastInboundMessageId.get(args.thread_ts),
    })

    const res = await web.conversations.replies({
      channel: args.channel,
      ts: args.thread_ts,
    })
    const messages = res.messages || []

    const formatted = await Promise.all(
      messages.map(async (m: any) => {
        const userName = m.user ? await resolveUserName(m.user) : (m.bot_profile?.name || m.username || 'bot')
        return {
          ts: m.ts,
          user: userName,
          user_id: m.user || m.bot_id,
          text: extractMessageText(m),
          thread_ts: m.thread_ts,
        }
      }),
    )

    console.error(`[slack] fetch_dm_thread done: ${formatted.length} message(s)`)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }],
    }
  })
}
