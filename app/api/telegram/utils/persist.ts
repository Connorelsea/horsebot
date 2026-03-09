import { ChatType, messages, MessageType, UserType } from '@/app/db/schema'
import { ensureClaudeUserExists } from '../utils'
import db from '@/app/db'
import TelegramBot from 'node-telegram-bot-api'
import { log } from './log'

// Extract metadata for logging purposes from a newly created message returned from the database
function getMessageLogMetadata(message: MessageType) {
  return {
    messageDbId: message.id,
    text: message.text,
    chatId: message.chatId,
    claudeThreadId: message.claudeThreadId,
    sessionId: message.sessionId,
  }
}

/**
 * PERSIST USER MESSAGE
 *
 *  Persist a message to the database, given a chat and user that exist in the database, and a message that has been sent in telegram. Optionally include a claude thread id if the message is part of a claude thread.
 *
 * message - TelegramBot.Message object from the telegram api
 * chat - ChatType object from the database
 * user - UserType object from the database
 * claudeThreadId - Optional claude thread id
 *
 * @returns MessageType - Message database type
 */
export async function persistMessage({
  message,
  chat,
  user,
  claudeThreadId,
  sessionId,
}: {
  message: TelegramBot.Message
  chat: ChatType
  user: UserType
  claudeThreadId?: string
  sessionId?: string
}): Promise<MessageType> {
  if (!user || !chat) {
    throw new Error('User or chat not found in persistMessage')
  }

  let newMessage: MessageType[] | null = null

  try {
    newMessage = await db
      .insert(messages)
      .values({
        messageId: message.message_id,
        userId: user.id,
        text: message.text || '',
        chatId: chat.id,
        messageThreadId: message.message_thread_id,
        isReply: !!message.reply_to_message,
        replyToMessageId: message.reply_to_message?.message_id || null,
        claudeThreadId: claudeThreadId || null,
        sessionId: sessionId || null,
      })
      .returning()
  } catch (error) {
    log('persist', 'error', { error })
    throw new Error('failed to persist message')
  }

  if (!newMessage || newMessage.length === 0) {
    log('persist', 'insert returned empty')
    throw new Error('failed to persist message')
  }

  log('persist', 'saved', getMessageLogMetadata(newMessage[0]))

  return newMessage[0]
}

// TODO: generalize persistUserMessage even more, move over claude helper functions, use user type from schema etc.

/**
 * PERSIST CLAUDE MESSAGE
 *
 * Persist a Claude message to the database, given a text, message id, chat id, claude thread id, and message thread id.
 *
 * @param text - Text of the message
 * @param messageId - Message id
 * @param chatUuid - Chat id
 * @param claudeThreadId - Optional claude thread id
 * @param messageThreadId - Optional message thread id
 * @returns MessageType - Message database type
 */
export async function persistClaudeMessage({
  message,
  chat,
  claudeThreadId,
  sessionId,
}: {
  message: TelegramBot.Message
  chat: ChatType
  claudeThreadId?: string | null
  sessionId?: string | null
}): Promise<MessageType> {
  if (!message || !chat || !message.text) {
    throw new Error('message, chat, or text not found in persistClaudeMessage')
  }

  log('persist', `claude: "${message.text.substring(0, 40)}"`, {
    chatId: chat.id,
    claudeThreadId,
    text: message.text.substring(0, 100),
  })

  // Ensure Claude user exists
  const claudeUser = await ensureClaudeUserExists()
  if (!claudeUser) {
    log('persist', 'claude user missing')
    throw new Error('failed to ensure Claude user exists')
  }

  return persistMessage({
    message,
    chat,
    user: claudeUser,
    claudeThreadId: claudeThreadId || undefined,
    sessionId: sessionId || undefined,
  })
}
