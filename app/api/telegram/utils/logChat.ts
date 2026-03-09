import TelegramBot from 'node-telegram-bot-api'
import { log } from './log'

const CLASSIFIER_LOG_CHAT_ID = process.env.CLASSIFIER_LOG_CHAT_ID || ''

/**
 * Send a message to the classifier log chat (fire-and-forget).
 */
export function sendToLogChat(text: string) {
  if (!CLASSIFIER_LOG_CHAT_ID) return

  ;(async () => {
    try {
      const bot = new TelegramBot(process.env.TELEGRAM_TOKEN || '')
      await bot.sendMessage(CLASSIFIER_LOG_CHAT_ID, text)
    } catch (err) {
      log('logChat', 'send failed', { error: err })
    }
  })()
}
