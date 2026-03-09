import TelegramBot from 'node-telegram-bot-api'
import db from '@/app/db'
import { users, claudeThreads, messages } from '@/app/db/schema'
import { eq } from 'drizzle-orm'
import { log } from './utils/log'

export type SendTelegramMessageProps = {
  text: string
  id?: number
  messageId?: number
}

export async function sendTelegramMessage({
  text,
  id = MONITOR_CHAT_ID,
  messageId,
}: SendTelegramMessageProps) {
  const bot = new TelegramBot(process.env.TELEGRAM_TOKEN || '')

  const replyMessageProps = messageId
    ? {
        reply_to_message_id: messageId,
      }
    : {}

  const sentMessage = await bot.sendMessage(id, text, {
    parse_mode: 'Markdown',
    ...replyMessageProps,
  })

  return sentMessage
}

// This function is now replaced by persistUserMessage in route.ts
// Keeping for backward compatibility but marked as deprecated
export async function persistMessage(_message: TelegramBot.Message) {
  log('persist', 'deprecated call')
  // This function is no longer used as message persistence is now handled
  // by persistUserMessage in route.ts with Claude thread support
}

export const MONITOR_CHAT_ID = -4212359986

// Special Telegram ID for Claude (must match route.ts constants)
// Using 0 because no real Telegram user can have ID 0
const CLAUDE_TELEGRAM_ID = 0
const CLAUDE_USERNAME = 'claude_ai_bot'
const CLAUDE_FIRST_NAME = 'Claude'

// Function to ensure Claude user exists in database
export async function ensureClaudeUserExists() {
  try {
    // Check if Claude user already exists
    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.telegramId, CLAUDE_TELEGRAM_ID))
      .limit(1)

    if (existingUser.length > 0) {
      return existingUser[0]
    }

    // Create Claude user if it doesn't exist
    const newUser = await db
      .insert(users)
      .values({
        telegramId: CLAUDE_TELEGRAM_ID,
        username: CLAUDE_USERNAME,
        firstName: CLAUDE_FIRST_NAME,
      })
      .returning()

    log('setup', 'claude user created')
    return newUser[0]
  } catch (error) {
    log('setup', 'claude user error', { error })
    return null
  }
}

// Setup function to manually create Claude user (useful for initialization)
export async function setupClaudeUser() {
  log('setup', 'setupClaudeUser')

  try {
    const claudeUser = await ensureClaudeUserExists()

    if (claudeUser) {
      log('setup', 'claude user ready')
      return claudeUser
    } else {
      log('setup', 'claude user setup failed')
      return null
    }
  } catch (error) {
    log('setup', 'claude user setup error', { error })
    return null
  }
}

// Helper function to check if a user ID belongs to Claude
export function isClaudeUser(userId: string, user?: any) {
  // Check by database UUID if provided
  if (user && user.telegramId === CLAUDE_TELEGRAM_ID) {
    return true
  }

  // You can add additional checks here if needed
  return false
}

// Get Claude's special Telegram ID (for external use)
export function getClaudeTelegramId() {
  return CLAUDE_TELEGRAM_ID
}

// Claude Thread Management Functions

// Helper function to create a new Claude thread
export async function createClaudeThread(chatId: string) {
  const newThread = await db
    .insert(claudeThreads)
    .values({ chatId })
    .returning()

  return newThread[0]
}

// Helper function to update message with Claude thread ID
export async function updateMessageWithClaudeThread(
  messageId: number,
  claudeThreadId: string,
) {
  await db
    .update(messages)
    .set({ claudeThreadId })
    .where(eq(messages.messageId, messageId))
}
