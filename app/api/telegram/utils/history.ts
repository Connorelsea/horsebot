import db from '@/app/db'
import { messages, users } from '@/app/db/schema'
import { desc, eq } from 'drizzle-orm'

export type MessageAndUser = typeof messages.$inferSelect & {
  user: typeof users.$inferSelect
}

export async function getRecentMessages(
  chatUuid: string,
  count: number,
): Promise<MessageAndUser[]> {
  const recentMessages = await db.query.messages.findMany({
    where: eq(messages.chatId, chatUuid),
    orderBy: desc(messages.createdAt),
    with: {
      user: true,
    },
    limit: count,
  })

  return recentMessages.reverse()
}

export async function getRecentMessagesWithClaudeThreadId(
  claudeThreadId: string,
): Promise<MessageAndUser[]> {
  const recentMessages = await db.query.messages.findMany({
    where: eq(messages.claudeThreadId, claudeThreadId),
    orderBy: desc(messages.createdAt),
    with: {
      user: true,
    },
  })
  return recentMessages.reverse()
}

/**
 * Get recent messages that are NOT part of any Claude thread
 * Useful for providing additional context when starting a new thread
 */
export async function getRecentNonThreadMessages(
  chatUuid: string,
  count: number,
): Promise<MessageAndUser[]> {
  const recentMessages = await db.query.messages.findMany({
    where: (messages, { eq, and, isNull }) =>
      and(eq(messages.chatId, chatUuid), isNull(messages.claudeThreadId)),
    orderBy: desc(messages.createdAt),
    with: {
      user: true,
    },
    limit: count,
  })

  return recentMessages.reverse()
}

/**
 * Get combined history: thread messages + recent non-thread messages for context
 * Deduplicates and sorts chronologically
 */
export async function getCombinedHistory(
  claudeThreadId: string,
  chatUuid: string,
  nonThreadContextCount: number = 10,
): Promise<MessageAndUser[]> {
  const [threadMessages, nonThreadMessages] = await Promise.all([
    getRecentMessagesWithClaudeThreadId(claudeThreadId),
    getRecentNonThreadMessages(chatUuid, nonThreadContextCount),
  ])

  // Combine and deduplicate (in case there's overlap)
  const messageMap = new Map<string, MessageAndUser>()

  // Add thread messages first (they take priority)
  threadMessages.forEach((msg) => messageMap.set(msg.id, msg))

  // Add non-thread messages (won't overwrite thread messages due to Map)
  nonThreadMessages.forEach((msg) => messageMap.set(msg.id, msg))

  // Convert back to array and sort chronologically
  return Array.from(messageMap.values()).sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  )
}

export async function combineMessageArrays(messageArrays: MessageAndUser[][]) {
  return messageArrays
    .flat()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
}
