import TelegramBot from 'node-telegram-bot-api'
import {
  assertChatExistsOrCreate,
  assertUserExistsOrCreate,
} from './utils/assertExists'
import { extractMessageMeta, findTelegramUpdateType } from './utils/messageMeta'
import handleNewIdentifierMessage from './messageHandlers/newIdentifierMessage'
import { log } from './utils/log'
import handleNewChatMessage from './messageHandlers/newChatMessage'
import handleSessionMessage from './messageHandlers/newSessionMessage'
import { handleCommand } from './commands'
import { isPaused } from './pauseState'
import { persistMessage } from './utils/persist'
import { enrichMessageWithImageDescription } from './utils/describeImage'
import { enrichMessageWithVoiceTranscription } from './utils/transcribeVoice'

const CONVERSATION_MODE = process.env.CONVERSATION_MODE || 'thread'

const SKIP_PROCESSING = process.env.SKIP_PROCESSING === 'true'

export async function POST(request: Request) {
  // Early return if kill switch is enabled - clears Telegram retry queue
  if (SKIP_PROCESSING) {
    log('webhook', 'SKIPPED (kill switch enabled)')
    return Response.json({ res: 'ok' })
  }

  let response = null

  try {
    response = await request.json()
  } catch (error) {
    log('webhook', 'parse error', { error })
    return Response.json({ res: 'ok' })
  }

  const update = response as TelegramBot.Update
  const updateType = findTelegramUpdateType(update)

  // In session mode, treat edited_message as a regular message update
  // so typo corrections get re-evaluated by the classifier
  const message =
    updateType === 'edited_message' && CONVERSATION_MODE === 'session'
      ? update.edited_message
      : update.message

  const hasValidUpdateType =
    updateType === 'message_reply' ||
    updateType === 'message' ||
    (updateType === 'edited_message' && CONVERSATION_MODE === 'session')

  if (!hasValidUpdateType) {
    log('webhook', `ignored update type: ${updateType}`, { updateType })
    return Response.json({ res: 'ok' })
  }

  if (!message || !message.from) {
    log('webhook', 'missing message/from', { updateType })
    return Response.json({ res: 'ok' })
  }

  // Skip shared location messages (including live location updates via edited_message)
  if (message.location) {
    log('webhook', 'ignored location message', { from: message.from.first_name })
    return Response.json({ res: 'ok' })
  }

  /**
   * PROCESS: message metadata and database relationships
   */
  let messageMeta = null
  let foundChat = null
  let foundUser = null

  try {
    messageMeta = extractMessageMeta(message)

    const [chat, user] = await Promise.all([
      assertChatExistsOrCreate(message),
      assertUserExistsOrCreate(message.from),
    ])
    foundChat = chat
    foundUser = user

    const from = user.firstName || user.username || '?'
    const text = message.text?.substring(0, 40) || ''
    log('webhook', `${from}: "${text}"`, {
      from: user.firstName,
      chat: chat.title || 'DM',
      text: message.text?.substring(0, 100),
      hasClaudeId: messageMeta.hasClaudeIdentifier,
      isReply: messageMeta.isReply,
      isEdit: updateType === 'edited_message',
    })
  } catch (error) {
    log('webhook', 'metadata error', { error })
    return Response.json({ res: 'ok' })
  }

  /**
   * PERMISSION GATE: Check chat permission level.
   * /allow bypasses so an admin can upgrade a 'none' chat.
   */
  const isAllowCommand = message.text?.trim().match(/^\/allow(\s|@|$)/)
  const permission = foundChat.permission ?? 'none'

  if (permission === 'none' && !isAllowCommand) {
    log('webhook', 'blocked by permission=none', { chat: foundChat.title || 'DM' })
    return Response.json({ res: 'ok' })
  }

  /**
   * MEDIA ENRICHMENT: Convert non-text messages to text descriptions
   * so everything downstream (persist, classifier, session) sees text.
   */
  const hasMedia = message.photo || message.sticker
    || message.voice || message.audio || (message as any).video_note
  if (hasMedia) {
    if (message.photo || message.sticker) {
      await enrichMessageWithImageDescription(message)
    } else {
      await enrichMessageWithVoiceTranscription(message)
    }
    // Re-extract meta now that message.text is set
    messageMeta = extractMessageMeta(message)
  }

  /**
   * COMMANDS: Handle bot commands before normal routing.
   * Commands are not persisted or passed to Claude.
   */
  if (await handleCommand(message, foundChat)) {
    return Response.json({ res: 'ok' })
  }

  /**
   * PERMISSION GATE (command-only): If permission is 'command', stop here.
   * Commands were already handled above; skip session/classifier routing.
   */
  if (permission === 'command') {
    log('webhook', 'permission=command, skipping session routing', { chat: foundChat.title || 'DM' })
    return Response.json({ res: 'ok' })
  }

  /**
   * PAUSE: Persist message but skip all session/classifier/response routing.
   */
  if (isPaused()) {
    try {
      await persistMessage({ message, chat: foundChat, user: foundUser })
    } catch (error) {
      log('webhook', 'persist error (paused)', { error })
    }
    return Response.json({ res: 'ok' })
  }

  /**
   * ROUTING LOGIC:
   * 1. If message has "claude" identifier → handleNewIdentifierMessage (handles replies too)
   * 2. Else if message is a reply to a Claude thread → handleNewIdentifierMessage
   * 3. Else → handleNewChatMessage (regular message)
   */

  try {
    if (CONVERSATION_MODE === 'session') {
      await handleSessionMessage({
        message,
        messageMeta,
        user: foundUser,
        chat: foundChat,
      })
    } else {
      if (messageMeta.hasClaudeIdentifier) {
        await handleNewIdentifierMessage({
          message,
          messageMeta,
          user: foundUser,
          chat: foundChat,
        })
      } else if (messageMeta.isReply && message.reply_to_message) {
        await handleNewIdentifierMessage({
          message,
          messageMeta,
          user: foundUser,
          chat: foundChat,
        })
      } else {
        await handleNewChatMessage({
          message,
          messageMeta,
          user: foundUser,
          chat: foundChat,
        })
      }
    }
  } catch (error) {
    log('webhook', 'handler error', { error })
  }

  return Response.json({ res: 'ok' })
}
