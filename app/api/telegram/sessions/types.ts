import TelegramBot from 'node-telegram-bot-api'
import { MessageType, UserType } from '@/app/db/schema'

export type BufferedMessage = {
  savedMessage: MessageType
  telegramMessage: TelegramBot.Message
  user: UserType
}

export type ClassificationResult = {
  needs_response: boolean
  focus_indices: number[]
}
