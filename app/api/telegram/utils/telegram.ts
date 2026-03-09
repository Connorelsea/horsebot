import { ChatType, MessageType } from '@/app/db/schema'
import TelegramBot from 'node-telegram-bot-api'
import { log } from './log'

export type SendTelegramMessageProps = {
  text: string
  sendToChat: ChatType
  // Todo: maybe needs to be just message ID in the future
  replyToMessage?: MessageType
}

export async function sendTelegramTextMessage({
  text,
  sendToChat,
  replyToMessage,
}: SendTelegramMessageProps) {
  if (!sendToChat) {
    log('telegram', 'sendToChat required')
    throw new Error('sendToChat is required in sendTelegramTextMessage')
  }

  try {
    const bot = new TelegramBot(process.env.TELEGRAM_TOKEN || '')

    const replyMessageProps = replyToMessage
      ? {
          reply_to_message_id: replyToMessage.messageId,
        }
      : {}

    const sentMessage = await bot.sendMessage(sendToChat.chatId, text, {
      parse_mode: 'Markdown',
      ...replyMessageProps,
    })

    return sentMessage
  } catch (error) {
    log('telegram', 'send failed', { error })
    throw new Error('failed to send telegram text message')
  }
}
