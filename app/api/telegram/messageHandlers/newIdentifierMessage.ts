import { MessageHandlerInput } from './types'
import { log } from '../utils/log'
import {
  createNewClaudeThread,
  getOrCreateThreadFromReply,
} from '../utils/claudeDb'
import { persistMessage } from '../utils/persist'
import { getCombinedHistory } from '../utils/history'
import { generatePrompt } from '@/app/ai/prompt'
import Anthropic from '@anthropic-ai/sdk'
import { handleClaudeWithTools } from '../tools'

const handleNewIdentifierMessage = async (input: MessageHandlerInput) => {
  const { message, messageMeta, user, chat } = input

  log('thread', 'start', {
    messageId: message.message_id,
    userId: user.telegramId,
    chatId: chat.chatId,
  })

  // Determine thread: if replying, use/create thread from reply; otherwise create new thread
  let threadId: string
  let isNewThread: boolean
  let isReplyToExistingThread: boolean = false

  if (messageMeta.isReply && message.reply_to_message) {
    const threadInfo = await getOrCreateThreadFromReply(
      message.reply_to_message.message_id,
      chat,
    )
    threadId = threadInfo.threadId
    isNewThread = threadInfo.isNewThread
    // If we found an existing thread, this is a reply to that thread
    isReplyToExistingThread = !isNewThread || !!threadInfo.repliedToMessage?.claudeThreadId
    log('thread', `from reply ${threadId.substring(0, 8)}`, {
      threadId,
      isNew: isNewThread,
      isReplyToThread: isReplyToExistingThread,
    })
  } else {
    const newThread = await createNewClaudeThread({ chat })
    threadId = newThread.id
    isNewThread = true
    log('thread', `new ${threadId.substring(0, 8)}`)
  }

  await persistMessage({
    message,
    chat,
    user,
    claudeThreadId: threadId,
  })

  // Decide whether to invoke Claude:
  // - If message has "claude" identifier → YES
  // - If replying to existing Claude thread → YES
  // - Otherwise → NO (just persist and return)
  const shouldInvokeClaude = messageMeta.hasClaudeIdentifier || isReplyToExistingThread

  if (!shouldInvokeClaude) {
    log('thread', 'skip — no identifier/thread match')
    return
  }

  // 1. Fetch message history: thread messages + recent non-thread messages for context
  const historyMessages = await getCombinedHistory(threadId, chat.id, 10)

  // 2. Generate prompt with context
  const prompt = generatePrompt({
    historyMessages,
    chatId: chat.chatId.toString(),
  })

  // 3. Create Anthropic client and call tool loop
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  })

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: prompt,
    },
  ]

  // 4. Run the tool calling loop with context
  await handleClaudeWithTools(client, messages, {
    chat,
    claudeThreadId: threadId,
    user,
  })

  log('thread', 'done')
}

export default handleNewIdentifierMessage
