import TelegramBot from 'node-telegram-bot-api'
import Anthropic from '@anthropic-ai/sdk'
import { ChatType, chats, memories, users } from '@/app/db/schema'
import db from '@/app/db'
import { eq, and, desc } from 'drizzle-orm'
import { log } from './utils/log'
import {
  getActiveSession,
  closeSession,
  getRecentSessions,
  getSessionMessages,
} from './sessions/sessionDb'
import { summarizeSession } from './sessions/summarize'
import { getRecentChunkSummaries, regenerateAllChunkSummaries, getRegenStatus, fixChunkTimestamps } from './sessions/chunks'
import { HISTORY_WINDOW } from './sessions/config'
import { isPaused, setPaused } from './pauseState'
import { builtSiteCommands } from './siteCommands'

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN || '')

const ADMIN_TELEGRAM_ID = Number(process.env.ADMIN_TELEGRAM_ID)

type CommandContext = {
  message: TelegramBot.Message
  chat: ChatType
}

type CommandHandler = (ctx: CommandContext) => Promise<void>

type CommandDef = {
  handler: CommandHandler
  description: string
  admin?: boolean
}

function isAdmin(message: TelegramBot.Message): boolean {
  return message.from?.id === ADMIN_TELEGRAM_ID
}

// ─── Command definitions ─────────────────────────────────────────────
// Add new commands here. They auto-appear in /help and bypass the
// classifier → tool loop entirely (intercepted in route.ts).
// Set admin: true to restrict a command to the admin user.

const commands: Record<string, CommandDef> = {
  // Site-specific search commands (defined in siteCommands.ts)
  ...builtSiteCommands,

  // ─── Public commands ───────────────────────────────────────────────

  '/help': {
    description: 'Show available commands',
    handler: async ({ message }) => {
      const publicLines: string[] = []
      const adminLines: string[] = []

      for (const [cmd, def] of Object.entries(commands)) {
        const line = `${cmd} — ${def.description}`
        if (def.admin) {
          adminLines.push(line)
        } else {
          publicLines.push(line)
        }
      }

      let text = `Commands:\n\n${publicLines.join('\n')}`
      if (isAdmin(message) && adminLines.length > 0) {
        text += `\n\nAdmin:\n\n${adminLines.join('\n')}`
      }

      await bot.sendMessage(message.chat.id, text)
      log('command', '/help')
    },
  },

  '/info': {
    description: 'Dump message/user/chat info (reply to a msg to inspect it)',
    admin: true,
    handler: async ({ message }) => {
      const target = message.reply_to_message || message
      const json = JSON.stringify(target, null, 2)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      const truncated = json.length > 4000 ? json.substring(0, 4000) + '\n...' : json
      await bot.sendMessage(message.chat.id, `<pre>${truncated}</pre>`, {
        parse_mode: 'HTML',
      })
      log('command', `/info — msg ${target.message_id}`)
    },
  },

  '/stop': {
    description: 'Close the active session (with summary)',
    admin: true,
    handler: async ({ message, chat }) => {
      const session = await getActiveSession(chat.id)
      if (session) {
        let summary: string | null = null
        const sessionMsgs = await getSessionMessages(session.id)
        if (sessionMsgs.length > 3) {
          try {
            summary = await summarizeSession(sessionMsgs)
          } catch (err) {
            log('command', '/stop summary failed', { error: err })
          }
        }
        await closeSession(session.id, summary)
        const text = summary
          ? `📝 Session summary:\n${summary}`
          : 'Session closed.'
        await bot.sendMessage(message.chat.id, text)
        log('command', `/stop closed ${session.id.substring(0, 8)}`)
      } else {
        await bot.sendMessage(message.chat.id, 'No active session.')
        log('command', '/stop — no active session')
      }
    },
  },

  '/sessions': {
    description: 'List active and recent sessions',
    handler: async ({ message, chat }) => {
      const activeSession = await getActiveSession(chat.id)
      const recentSessions = await getRecentSessions(chat.id, 10)

      let text = ''

      if (activeSession) {
        const msgs = await getSessionMessages(activeSession.id)
        const ago = formatAgo(activeSession.lastActivityAt)
        const duration = formatDuration(
          activeSession.createdAt,
          activeSession.lastActivityAt,
        )
        text += `🟢 Active session\n`
        text += `  Started: ${formatTime(activeSession.createdAt)}\n`
        text += `  Last activity: ${ago}\n`
        text += `  Duration: ${duration}\n`
        text += `  Messages: ${msgs.length}\n\n`
      } else {
        text += `⚪ No active session\n\n`
      }

      const closedSessions = recentSessions.filter(
        (s) => s.status === 'closed' && s.id !== activeSession?.id,
      )

      if (closedSessions.length > 0) {
        text += `Recent sessions:\n`
        for (const s of closedSessions) {
          const time = formatTime(s.createdAt)
          const duration = s.closedAt
            ? formatDuration(s.createdAt, s.closedAt)
            : '?'
          const summary = s.summary || '(no summary)'
          text += `\n${time} (${duration})\n  ${summary}\n`
        }
      } else {
        text += 'No past sessions found.'
      }

      await bot.sendMessage(message.chat.id, text)
      log('command', `/sessions — ${closedSessions.length} listed`)
    },
  },

  '/chunks': {
    description: 'Show the 5 most recent chunk summaries',
    handler: async ({ message, chat }) => {
      const chunks = await getRecentChunkSummaries(chat.id, 5)

      if (chunks.length === 0) {
        await bot.sendMessage(message.chat.id, 'No chunks yet.')
        log('command', '/chunks — none')
        return
      }

      let text = `📦 Message chunks (${chunks.length}, window=${HISTORY_WINDOW}):\n`
      for (const c of chunks) {
        const time = formatTime(c.createdAt)
        const status = c.summary ? '' : ' ⏳ summarizing...'
        const summary = c.summary || '(pending)'
        text += `\n#${c.chunkIndex} — ${c.messageCount} msgs, ${time}${status}\n  ${summary}\n`
      }

      await bot.sendMessage(message.chat.id, text)
      log('command', `/chunks — ${chunks.length} listed`)
    },
  },

  '/memory': {
    description: 'Show recent memories (reply to a user to filter)',
    handler: async ({ message, chat }) => {
      const conditions = [eq(memories.chatId, chat.id)]

      // If replying to someone, filter to that user
      const replyUser = message.reply_to_message?.from
      if (replyUser) {
        const dbUser = await db.query.users.findFirst({
          where: eq(users.telegramId, replyUser.id),
        })
        if (dbUser) {
          conditions.push(eq(memories.userId, dbUser.id))
        } else {
          await bot.sendMessage(message.chat.id, `No memories found for ${replyUser.first_name || replyUser.username || 'that user'}.`)
          log('command', '/memory — user not in db')
          return
        }
      }

      const results = await db
        .select({
          memory: memories.memory,
          createdAt: memories.createdAt,
          firstName: users.firstName,
          username: users.username,
        })
        .from(memories)
        .innerJoin(users, eq(memories.userId, users.id))
        .where(and(...conditions))
        .orderBy(desc(memories.createdAt))
        .limit(20)

      if (results.length === 0) {
        const target = replyUser
          ? replyUser.first_name || replyUser.username || 'that user'
          : 'this chat'
        await bot.sendMessage(message.chat.id, `No memories for ${target}.`)
        log('command', '/memory — none')
        return
      }

      const lines = results.map((r) => {
        const name = r.firstName || r.username || 'Unknown'
        const ago = formatAgo(r.createdAt)
        return `${name}: ${r.memory} (${ago})`
      })

      const header = replyUser
        ? `💾 Memories about ${replyUser.first_name || replyUser.username}:`
        : `💾 Recent memories:`

      await bot.sendMessage(message.chat.id, `${header}\n\n${lines.join('\n')}`)
      log('command', `/memory — ${results.length} shown`)
    },
  },

  '/web': {
    description: 'Search the web — /web <query>',
    handler: async ({ message }) => {
      const query = extractArgs(message.text)
      if (!query) {
        await bot.sendMessage(message.chat.id, 'Usage: /web <query>')
        return
      }

      await bot.sendMessage(message.chat.id, `🔍 Searching...`)

      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 5,
          } as any,
        ],
        messages: [
          {
            role: 'user',
            content: `Search the web and answer this question concisely. Include source URLs where relevant.\n\n${query}`,
          },
        ],
      })

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')

      if (!text) {
        await bot.sendMessage(message.chat.id, 'No results found.')
        log('command', '/web — empty response')
        return
      }

      const truncated =
        text.length > 4000 ? text.substring(0, 4000) + '\n\n...(truncated)' : text
      await bot.sendMessage(message.chat.id, truncated)
      log('command', `/web — "${query.substring(0, 40)}"`)
    },
  },

  // ─── Admin commands ────────────────────────────────────────────────

  '/pause': {
    description: 'Toggle pause — persist messages but skip Claude',
    admin: true,
    handler: async ({ message }) => {
      const nowPaused = !isPaused()
      setPaused(nowPaused)
      const text = nowPaused
        ? '⏸ Bot paused. Messages will be saved but Claude won\'t respond.\nUse /pause again to resume.'
        : '▶️ Bot resumed.'
      await bot.sendMessage(message.chat.id, text)
      log('command', `/pause → ${nowPaused ? 'paused' : 'resumed'}`)
    },
  },

  '/regen': {
    description: 'Regenerate all chunk summaries from scratch',
    admin: true,
    handler: async ({ message, chat }) => {
      const status = getRegenStatus(chat.id)
      if (status) {
        await bot.sendMessage(
          message.chat.id,
          `♻️ Still regenerating... ${status.done}/${status.total} chunks done.`,
        )
        return
      }

      await bot.sendMessage(message.chat.id, '♻️ Regenerating all chunk summaries...')

      // Fire-and-forget so the webhook returns immediately
      regenerateAllChunkSummaries(chat.id, (done, total) => {
        if (done % 10 === 0 || done === total) {
          log('command', `/regen progress ${done}/${total}`)
        }
      })
        .then((count) => {
          bot.sendMessage(message.chat.id, `✅ Regenerated ${count} chunk summaries.`)
          log('command', `/regen — ${count} chunks`)
        })
        .catch((err) => {
          bot.sendMessage(message.chat.id, '❌ Regen failed.')
          log('command', '/regen error', { error: err })
        })
    },
  },

  '/fixtime': {
    description: 'Repair chunk timestamps from message times',
    admin: true,
    handler: async ({ message, chat }) => {
      const fixed = await fixChunkTimestamps(chat.id)
      await bot.sendMessage(message.chat.id, `✅ Fixed ${fixed} chunk timestamps.`)
      log('command', `/fixtime — ${fixed} fixed`)
    },
  },

  '/allow': {
    description: 'Set chat permission — /allow none|command|full',
    admin: true,
    handler: async ({ message, chat }) => {
      const arg = extractArgs(message.text).toLowerCase()
      const validLevels = ['none', 'command', 'full'] as const
      if (!arg || !validLevels.includes(arg as any)) {
        await bot.sendMessage(
          message.chat.id,
          'Usage: /allow none | command | full\n\n• none — bot ignores this chat\n• command — commands only\n• full — commands + Claude responses',
        )
        return
      }
      await db
        .update(chats)
        .set({ permission: arg })
        .where(eq(chats.id, chat.id))
      await bot.sendMessage(message.chat.id, `Permission set to: ${arg}`)
      log('command', `/allow → ${arg} for chat ${chat.id.substring(0, 8)}`)
    },
  },

  '/chat': {
    description: 'Show chat info (IDs, title, type)',
    admin: true,
    handler: async ({ message, chat }) => {
      const tgChat = message.chat
      const lines = [
        `Chat info:`,
        `  Telegram ID: ${tgChat.id}`,
        `  DB ID: ${chat.id}`,
        `  Title: ${tgChat.title || '(none)'}`,
        `  Type: ${tgChat.type}`,
        `  Username: ${tgChat.username || '(none)'}`,
      ]
      await bot.sendMessage(message.chat.id, lines.join('\n'))
      log('command', `/chat — ${tgChat.id}`)
    },
  },
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Extract everything after the /command (and optional @botname). */
function extractArgs(text?: string): string {
  if (!text) return ''
  return text.replace(/^\/\S+/, '').trim()
}

function formatTime(date: Date): string {
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
}

function formatAgo(date: Date): string {
  const mins = Math.round((Date.now() - date.getTime()) / (1000 * 60))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

function formatDuration(start: Date, end: Date): string {
  const mins = Math.round((end.getTime() - start.getTime()) / (1000 * 60))
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`
}

// ─── Dispatcher ──────────────────────────────────────────────────────

/**
 * Check if a message is a bot command and handle it.
 * Returns true if the message was a command (handled or not), false otherwise.
 * Commands bypass the classifier → tool loop entirely.
 */
export async function handleCommand(
  message: TelegramBot.Message,
  chat: ChatType,
): Promise<boolean> {
  const text = message.text?.trim()
  if (!text || !text.startsWith('/')) return false

  // Strip @botname suffix (e.g. "/stop@claude_ai_bot" → "/stop")
  const command = text.split('@')[0].split(' ')[0]

  const def = commands[command]
  if (!def) return false

  // Admin gate
  if (def.admin && !isAdmin(message)) {
    log('command', `${command} denied — not admin (${message.from?.id})`)
    return true // swallow the command silently
  }

  try {
    await def.handler({ message, chat })
  } catch (error) {
    log('command', `${command} error`, { error })
  }

  return true
}
