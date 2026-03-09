import { ChatType, MessageType, UserType } from '@/app/db/schema'
import { log } from '../utils/log'
import { classifyBatch } from './classifier'
import { buildSessionPrompt } from './sessionPrompt'
import { getSessionMessages, touchSession } from './sessionDb'
import { BufferedMessage } from './types'
import Anthropic from '@anthropic-ai/sdk'
import { handleClaudeWithTools } from '../tools'

const DEBOUNCE_MS = parseInt(process.env.DEBOUNCE_MS || '10000')

type DebounceBuffer = {
  timer: ReturnType<typeof setTimeout>
  messages: BufferedMessage[]
  sessionId: string
  chat: ChatType
  hasClaudeTrigger: boolean
}

// Survive hot reloads in dev
const globalForDebounce = globalThis as typeof globalThis & {
  debounceBuffers?: Map<string, DebounceBuffer>
}

if (!globalForDebounce.debounceBuffers) {
  globalForDebounce.debounceBuffers = new Map()
}

const debounceBuffers = globalForDebounce.debounceBuffers

export function addToDebounceBuffer(
  chatDbId: string,
  sessionId: string,
  savedMessage: MessageType,
  telegramMessage: any,
  user: UserType,
  chat: ChatType,
  hasClaudeTrigger: boolean = false,
) {
  const existing = debounceBuffers.get(chatDbId)

  if (existing) {
    clearTimeout(existing.timer)
    existing.messages.push({ savedMessage, telegramMessage, user })
    if (hasClaudeTrigger) existing.hasClaudeTrigger = true
    existing.timer = setTimeout(() => processBuffer(chatDbId), DEBOUNCE_MS)
    log('debounce', `+1 (${existing.messages.length} buffered)`, {
      chatDbId: chatDbId.substring(0, 8),
    })
  } else {
    const buffer: DebounceBuffer = {
      timer: setTimeout(() => processBuffer(chatDbId), DEBOUNCE_MS),
      messages: [{ savedMessage, telegramMessage, user }],
      sessionId,
      chat,
      hasClaudeTrigger,
    }
    debounceBuffers.set(chatDbId, buffer)
    log('debounce', 'new buffer', {
      chatDbId: chatDbId.substring(0, 8),
    })
  }
}

async function processBuffer(chatDbId: string) {
  const buffer = debounceBuffers.get(chatDbId)
  if (!buffer || buffer.messages.length === 0) return

  // Remove buffer immediately to prevent race conditions
  debounceBuffers.delete(chatDbId)

  const {
    messages: bufferedMessages,
    sessionId,
    chat,
    hasClaudeTrigger,
  } = buffer

  log('debounce', `firing ${bufferedMessages.length} msgs`, {
    sessionId: sessionId.substring(0, 8),
    hasClaudeTrigger,
  })

  try {
    // If someone used a Claude trigger, skip classification — always respond
    let classification = {
      needs_response: true,
      focus_indices: bufferedMessages.map((_, i) => i),
    }

    if (!hasClaudeTrigger) {
      const sessionMessages = await getSessionMessages(sessionId)
      classification = await classifyBatch(sessionMessages, bufferedMessages)
      log('classifier', `result: ${classification.needs_response ? 'respond' : 'skip'}`, classification)
    }

    if (!classification.needs_response) return

    await touchSession(sessionId)

    const prompt = await buildSessionPrompt(
      sessionId,
      bufferedMessages,
      chat,
    )

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const apiMessages: Anthropic.MessageParam[] = [
      { role: 'user', content: prompt },
    ]

    await handleClaudeWithTools(client, apiMessages, {
      chat,
      sessionId,
      user: bufferedMessages[0].user,
    })

    await touchSession(sessionId)
  } catch (error) {
    log('debounce', 'error', { error })
  }
}
