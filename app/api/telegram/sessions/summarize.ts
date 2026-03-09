import Anthropic from '@anthropic-ai/sdk'
import { MessageAndUser } from '../utils/history'
import { log } from '../utils/log'

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

function formatMessagesForSummary(msgs: MessageAndUser[]): string {
  return msgs
    .map((m) => {
      const name =
        m.user.username === 'claude_ai_bot'
          ? 'Claude'
          : m.user.firstName || m.user.username || 'Unknown'
      return `${name}: "${m.text}"`
    })
    .join('\n')
}

/**
 * Summarize a session's messages. Enhanced: 3-6 sentences, richer detail.
 */
export async function summarizeSession(
  sessionMessages: MessageAndUser[],
): Promise<string> {
  const formatted = formatMessagesForSummary(sessionMessages)

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [
      {
        role: 'user',
        content: `Summarize this group chat conversation in 3-6 sentences. Include:
- All major topics discussed
- Key participants and their roles in the conversation
- Any decisions made or actions taken
- The overall tone/mood of the conversation

Be concise but comprehensive.\n\n${formatted}`,
      },
    ],
  })

  const text =
    response.content[0].type === 'text' ? response.content[0].text : ''
  log('summarize', 'session summary generated', {
    summary: text.substring(0, 100),
  })
  return text
}

/**
 * Summarize a chunk of ~100 messages. One dense sentence — compress, don't narrate.
 */
export async function summarizeChunkMessages(
  chunkMessages: MessageAndUser[],
): Promise<string> {
  const formatted = formatMessagesForSummary(chunkMessages)

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 120,
    messages: [
      {
        role: 'user',
        content: `Compress these ~${chunkMessages.length} group chat messages into ONE dense sentence. Pack in all key topics, names, and events — sacrifice grammar for information density. This is a compressed log entry, not a narrative. No preamble.\n\n${formatted}`,
      },
    ],
  })

  const text =
    response.content[0].type === 'text' ? response.content[0].text : ''
  log('summarize', 'chunk summary generated', {
    messageCount: chunkMessages.length,
    summary: text.substring(0, 100),
  })
  return text
}
