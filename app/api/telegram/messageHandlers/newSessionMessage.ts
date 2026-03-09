import { MessageHandlerInput } from './types'
import { log } from '../utils/log'
import { persistMessage } from '../utils/persist'
import {
  getActiveSession,
  createSession,
  addMessageToSession,
  isReplyToClaudeMessage,
  updateMessageText,
} from '../sessions/sessionDb'
import { addToDebounceBuffer } from '../sessions/debounce'
import { maybeCreateChunks } from '../sessions/chunks'

const handleSessionMessage = async (input: MessageHandlerInput) => {
  const { message, messageMeta, user, chat } = input

  // Detect if this is an edited message (edit_date is set by Telegram on edits)
  const isEdit = !!(message as any).edit_date

  log('session', `${isEdit ? 'edit' : 'msg'} from ${user.firstName}`, {
    text: message.text?.substring(0, 50),
    hasClaudeId: messageMeta.hasClaudeIdentifier,
    isReply: messageMeta.isReply,
    isEdit,
  })

  // 1. Persist or update message
  let savedMessage
  if (isEdit) {
    // Update existing message text in DB
    const updated = await updateMessageText(
      message.message_id,
      chat.id,
      message.text || '',
    )
    if (updated) {
      savedMessage = updated
      log('session', 'updated edited msg', { messageId: updated.id })
    } else {
      // Message wasn't in DB yet (edge case) — persist as new
      savedMessage = await persistMessage({ message, chat, user })
    }
  } else {
    savedMessage = await persistMessage({ message, chat, user })
  }

  // 2. Fire-and-forget: check if chunks need to be created
  maybeCreateChunks(chat.id).catch((err) =>
    log('chunks', 'maybeCreateChunks error', { error: err }),
  )

  // 3. Check for active session
  let session = await getActiveSession(chat.id)

  // 4. Route based on session state
  if (session) {
    // Active session — add message to session and debounce buffer
    if (!savedMessage.sessionId) {
      await addMessageToSession(savedMessage.id, session.id)
    }
    addToDebounceBuffer(
      chat.id,
      session.id,
      savedMessage,
      message,
      user,
      chat,
      false, // active session — always classify normally, even if "claude" is mentioned
    )
    log('session', `buffered → ${session.id.substring(0, 8)}`, {
      sessionId: session.id,
      isEdit,
    })
  } else if (messageMeta.hasClaudeIdentifier) {
    // No active session + explicit Claude trigger → start new session
    session = await createSession(chat.id, savedMessage.id)
    await addMessageToSession(savedMessage.id, session.id)
    addToDebounceBuffer(
      chat.id,
      session.id,
      savedMessage,
      message,
      user,
      chat,
      true,
    )
    log('session', `new session (trigger) ${session.id.substring(0, 8)}`, {
      sessionId: session.id,
    })
  } else if (messageMeta.isReply && message.reply_to_message) {
    // No active session + reply — check if replying to Claude's message
    const isClaudeReply = await isReplyToClaudeMessage(
      message.reply_to_message.message_id,
      chat.id,
    )
    if (isClaudeReply) {
      session = await createSession(chat.id, savedMessage.id)
      await addMessageToSession(savedMessage.id, session.id)
      addToDebounceBuffer(
        chat.id,
        session.id,
        savedMessage,
        message,
        user,
        chat,
        true,
      )
      log('session', `new session (reply) ${session.id.substring(0, 8)}`, {
        sessionId: session.id,
      })
    } else {
      rollRandomSession(message, user, chat, savedMessage)
    }
  } else {
    rollRandomSession(message, user, chat, savedMessage)
  }
}

const RANDOM_CHANCE = parseFloat(process.env.CLAUDE_RANDOM_CHANCE || '0')

function rollRandomSession(
  message: any,
  user: any,
  chat: any,
  savedMessage: any,
) {
  const roll = Math.random()
  log('random', `roll ${roll.toFixed(3)}/${RANDOM_CHANCE}`)

  if (roll >= RANDOM_CHANCE) return

  log('random', 'triggered! starting session')

  // Fire-and-forget: create session and buffer the message
  ;(async () => {
    try {
      const session = await createSession(chat.id, savedMessage.id)
      await addMessageToSession(savedMessage.id, session.id)
      addToDebounceBuffer(
        chat.id,
        session.id,
        savedMessage,
        message,
        user,
        chat,
        true, // skip classifier — we already decided to respond
      )
      log('session', `new session (random) ${session.id.substring(0, 8)}`)
    } catch (err) {
      log('random', 'session creation failed', { error: err })
    }
  })()
}

export default handleSessionMessage
