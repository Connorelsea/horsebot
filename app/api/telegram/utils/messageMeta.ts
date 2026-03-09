import { hasClaudeIdentifier } from '@/app/ai/claudeIdentifier'
import TelegramBot from 'node-telegram-bot-api'

export type MessageMeta = {
  text: string
  hasText: boolean
  isReply: boolean
  isGroup: boolean
  isPrivate: boolean
  isChannel: boolean
  isSuperGroup: boolean
  messageId: number
  chatId?: number
  userId?: number
  hasUser: boolean
  hasClaudeIdentifier: boolean
}

export const extractMessageMeta = (
  message: TelegramBot.Message,
): MessageMeta => {
  return {
    text: message.text || '',
    hasText: !!message.text,
    isReply: !!message.reply_to_message,
    isGroup: message.chat.type === 'group',
    isPrivate: message.chat.type === 'private',
    isChannel: message.chat.type === 'channel',
    isSuperGroup: message.chat.type === 'supergroup',
    messageId: message.message_id,
    chatId: message.chat.id,
    userId: message.from?.id,
    hasUser: !!message.from,
    hasClaudeIdentifier: hasClaudeIdentifier(message.text || message.caption || ''),
  }
}

export type TelegramUpdateType =
  | 'message'
  | 'message_reply'
  | 'callback_query'
  | 'inline_query'
  | 'edited_message'
  | 'channel_post'
  | 'shipping_query'
  | 'pre_checkout_query'
  | 'poll'
  | 'chat_member'
  | 'chat_join_request'
  | 'chosen_inline_result'
  | 'unknown'

export const findTelegramUpdateType = (
  update: TelegramBot.Update,
): TelegramUpdateType => {
  if (update.message) {
    if (update.message.reply_to_message) {
      return 'message_reply'
    } else {
      return 'message'
    }
  }
  if (update.callback_query) {
    return 'callback_query'
  }
  if (update.inline_query) {
    return 'inline_query'
  }
  if (update.edited_message) {
    return 'edited_message'
  }
  if (update.channel_post) {
    return 'channel_post'
  }
  if (update.shipping_query) {
    return 'shipping_query'
  }
  if (update.pre_checkout_query) {
    return 'pre_checkout_query'
  }
  if (update.poll) {
    return 'poll'
  }
  if (update.chat_member) {
    return 'chat_member'
  }
  if (update.chat_join_request) {
    return 'chat_join_request'
  }
  if (update.inline_query) {
    return 'inline_query'
  }
  if (update.chosen_inline_result) {
    return 'chosen_inline_result'
  }
  return 'unknown'
}
