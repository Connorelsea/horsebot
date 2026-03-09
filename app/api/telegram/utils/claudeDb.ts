import db from '@/app/db'
import { ChatType, claudeThreads, messages } from '@/app/db/schema'
import { eq, and } from 'drizzle-orm'
import { log } from './log'

// Creates a new claude thread in the database
// Messages in a shared "thread" between the user and the claude bot all have the same thread ID
// This is so they can be pulled from the database, but also if the user responds to a message in the chat, it can be checked if it was already part of a thread
export async function createNewClaudeThread({ chat }: { chat: ChatType }) {
  const newThread = await db
    .insert(claudeThreads)
    .values({ chatId: chat.id })
    .returning()

  return newThread[0]
}

/**
 * Find a message in the database by its Telegram message ID and chat
 * @param telegramMessageId - The message_id from Telegram
 * @param chat - The chat object from database
 * @returns The message if found, null otherwise
 */
export async function findMessageByTelegramId(
  telegramMessageId: number,
  chat: ChatType,
) {
  const message = await db.query.messages.findFirst({
    where: and(
      eq(messages.messageId, telegramMessageId),
      eq(messages.chatId, chat.id),
    ),
  })

  return message || null
}

/**
 * Update a message to add it to a Claude thread (retroactively)
 * @param messageId - The UUID of the message in our database
 * @param claudeThreadId - The UUID of the Claude thread
 */
export async function addMessageToThread(
  messageId: string,
  claudeThreadId: string,
) {
  const updated = await db
    .update(messages)
    .set({ claudeThreadId })
    .where(eq(messages.id, messageId))
    .returning()

  log('thread', 'msg added', { messageId, claudeThreadId })

  return updated[0]
}

/**
 * Get or create a Claude thread based on a reply
 *
 * Logic:
 * - If the replied-to message already has a claudeThreadId, return that thread
 * - If the replied-to message does NOT have a claudeThreadId, create a new thread
 *   and retroactively assign it to the replied-to message
 *
 * @param repliedToTelegramMessageId - The Telegram message_id being replied to
 * @param chat - The chat object
 * @returns Object with thread info and whether it was newly created
 */
export async function getOrCreateThreadFromReply(
  repliedToTelegramMessageId: number,
  chat: ChatType,
): Promise<{
  threadId: string
  isNewThread: boolean
  repliedToMessage: any
}> {
  // Find the message being replied to
  const repliedToMessage = await findMessageByTelegramId(
    repliedToTelegramMessageId,
    chat,
  )

  if (!repliedToMessage) {
    log('thread', 'reply target not in DB, new thread', {
      repliedToTelegramMessageId,
      chatId: chat.id,
    })
    // Message not in our database - create new thread
    const newThread = await createNewClaudeThread({ chat })
    return {
      threadId: newThread.id,
      isNewThread: true,
      repliedToMessage: null,
    }
  }

  // Check if the replied-to message already has a thread
  if (repliedToMessage.claudeThreadId) {
    log('thread', `reusing ${repliedToMessage.claudeThreadId.substring(0, 8)}`)
    return {
      threadId: repliedToMessage.claudeThreadId,
      isNewThread: false,
      repliedToMessage,
    }
  }

  // Message exists but has no thread - create new thread and add the message to it
  log('thread', 'new thread from reply', {
    repliedToMessageId: repliedToMessage.id,
  })

  const newThread = await createNewClaudeThread({ chat })
  await addMessageToThread(repliedToMessage.id, newThread.id)

  return {
    threadId: newThread.id,
    isNewThread: true,
    repliedToMessage,
  }
}
