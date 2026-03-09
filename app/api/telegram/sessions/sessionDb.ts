import db from '@/app/db'
import { chats, claudeSessions, messages } from '@/app/db/schema'
import { eq, and, desc } from 'drizzle-orm'
import { log } from '../utils/log'
import { MessageAndUser } from '../utils/history'
import { summarizeSession } from './summarize'
import { maybeCreateChunks } from './chunks'
import TelegramBot from 'node-telegram-bot-api'

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN || '')

const SESSION_TIMEOUT_MINUTES = parseInt(
  process.env.SESSION_TIMEOUT_MINUTES || '10',
)

/**
 * Find an active session for a chat.
 * If the session has timed out, close it (with summary) and return null.
 */
export async function getActiveSession(chatDbId: string) {
  const session = await db.query.claudeSessions.findFirst({
    where: and(
      eq(claudeSessions.chatId, chatDbId),
      eq(claudeSessions.status, 'active'),
    ),
    orderBy: desc(claudeSessions.createdAt),
  })

  if (!session) return null

  const minutesSinceActivity =
    (Date.now() - session.lastActivityAt.getTime()) / (1000 * 60)

  if (minutesSinceActivity > SESSION_TIMEOUT_MINUTES) {
    // Close stale session async — don't block the webhook
    closeSessionWithSummary(session.id).catch((err) =>
      log('session', 'stale close error', { error: err }),
    )
    return null
  }

  return session
}

/**
 * Close a session and generate a Haiku summary if there are enough messages.
 */
async function closeSessionWithSummary(sessionId: string) {
  const sessionMsgs = await getSessionMessages(sessionId)
  let summary: string | null = null
  if (sessionMsgs.length > 3) {
    try {
      summary = await summarizeSession(sessionMsgs)
    } catch (err) {
      log('session', 'summary failed', { error: err })
    }
  }
  await closeSession(sessionId, summary)

  // Fire-and-forget: check if chunks need to be created
  const session = await db.query.claudeSessions.findFirst({
    where: eq(claudeSessions.id, sessionId),
  })
  if (session) {
    maybeCreateChunks(session.chatId).catch((err) =>
      log('chunks', 'maybeCreateChunks error on session close', { error: err }),
    )
  }

  if (summary) {
    sendSessionSummaryToChat(sessionId, summary).catch((err) =>
      log('session', 'summary send failed', { error: err }),
    )
  }
}

async function sendSessionSummaryToChat(sessionId: string, summary: string) {
  const session = await db.query.claudeSessions.findFirst({
    where: eq(claudeSessions.id, sessionId),
  })
  if (!session) return

  const chat = await db.query.chats.findFirst({
    where: eq(chats.id, session.chatId),
  })
  if (!chat) return

  await bot.sendMessage(chat.chatId, `📝 Session summary:\n${summary}`)
}

export async function createSession(
  chatDbId: string,
  triggerMessageId?: string,
) {
  const newSession = await db
    .insert(claudeSessions)
    .values({
      chatId: chatDbId,
      status: 'active',
      triggerMessageId: triggerMessageId || null,
    })
    .returning()

  log('session', `created ${newSession[0].id.substring(0, 8)}`)
  return newSession[0]
}

export async function touchSession(sessionId: string) {
  await db
    .update(claudeSessions)
    .set({ lastActivityAt: new Date() })
    .where(eq(claudeSessions.id, sessionId))
}

export async function closeSession(
  sessionId: string,
  summary?: string | null,
) {
  await db
    .update(claudeSessions)
    .set({
      status: 'closed',
      closedAt: new Date(),
      summary: summary || null,
    })
    .where(eq(claudeSessions.id, sessionId))

  log('session', `closed ${sessionId.substring(0, 8)}${summary ? ' (summarized)' : ''}`)
}

export async function addMessageToSession(
  messageDbId: string,
  sessionId: string,
) {
  await db
    .update(messages)
    .set({ sessionId })
    .where(eq(messages.id, messageDbId))
}

export async function getRecentSessionSummaries(
  chatDbId: string,
  count: number = 5,
) {
  const sessions = await db.query.claudeSessions.findMany({
    where: and(
      eq(claudeSessions.chatId, chatDbId),
      eq(claudeSessions.status, 'closed'),
    ),
    orderBy: desc(claudeSessions.closedAt),
    limit: count,
  })

  return sessions.reverse() // chronological order
}

export async function getRecentSessions(chatDbId: string, count: number = 10) {
  return db.query.claudeSessions.findMany({
    where: eq(claudeSessions.chatId, chatDbId),
    orderBy: desc(claudeSessions.createdAt),
    limit: count,
  })
}

export async function getSessionMessages(
  sessionId: string,
): Promise<MessageAndUser[]> {
  const sessionMessages = await db.query.messages.findMany({
    where: eq(messages.sessionId, sessionId),
    orderBy: messages.createdAt,
    with: { user: true },
  })

  return sessionMessages
}

/**
 * Update the text of an existing message (for edited messages).
 * Returns the updated message or null if not found.
 */
export async function updateMessageText(
  telegramMessageId: number,
  chatDbId: string,
  newText: string,
) {
  const updated = await db
    .update(messages)
    .set({ text: newText })
    .where(
      and(
        eq(messages.messageId, telegramMessageId),
        eq(messages.chatId, chatDbId),
      ),
    )
    .returning()

  if (updated.length > 0) {
    log('session', 'msg text updated', {
      messageId: updated[0].id,
      newText: newText.substring(0, 50),
    })
    return updated[0]
  }
  return null
}

/**
 * Check if a telegram message ID belongs to Claude (for reply detection).
 */
export async function isReplyToClaudeMessage(
  telegramMessageId: number,
  chatDbId: string,
): Promise<boolean> {
  const msg = await db.query.messages.findFirst({
    where: and(
      eq(messages.messageId, telegramMessageId),
      eq(messages.chatId, chatDbId),
    ),
    with: { user: true },
  })

  return msg?.user?.telegramId === 0
}
