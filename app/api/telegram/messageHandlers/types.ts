import { ChatType, UserType } from '@/app/db/schema'
import TelegramBot from 'node-telegram-bot-api'
import { MessageMeta } from '../utils/messageMeta'

export type MessageHandlerInput = {
  message: TelegramBot.Message
  messageMeta: MessageMeta
  user: UserType
  chat: ChatType
}
