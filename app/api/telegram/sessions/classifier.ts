import Anthropic from '@anthropic-ai/sdk'
import { MessageAndUser } from '../utils/history'
import { BufferedMessage, ClassificationResult } from './types'
import { log, logVerbose } from '../utils/log'
import { sendToLogChat } from '../utils/logChat'

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

function extractMentions(telegramMessage: any): string[] {
  if (!telegramMessage?.entities) return []
  const text = telegramMessage.text || ''
  return telegramMessage.entities
    .filter((e: any) => e.type === 'mention' || e.type === 'text_mention')
    .map((e: any) => {
      if (e.type === 'text_mention' && e.user) {
        return e.user.first_name || e.user.username || null
      }
      return text.substring(e.offset, e.offset + e.length)
    })
    .filter(Boolean)
}

function formatMessageForClassifier(
  user: { firstName: string | null; username: string | null },
  text: string,
  index: number,
  replyToName?: string | null,
  mentions?: string[],
): string {
  const name = user.firstName || user.username || 'Unknown'
  const replyTag = replyToName ? ` (replying to ${replyToName})` : ''
  const mentionTag =
    mentions && mentions.length > 0
      ? ` (@mentions: ${mentions.join(', ')})`
      : ''
  return `${index}. [${name}]${replyTag}${mentionTag}: "${text}"`
}

export async function classifyBatch(
  sessionMessages: MessageAndUser[],
  newBatch: BufferedMessage[],
): Promise<ClassificationResult> {
  // Exclude new batch messages from session context to avoid duplicates
  const batchMessageIds = new Set(newBatch.map((b) => b.savedMessage.id))
  const filteredSession = sessionMessages.filter(
    (m) => !batchMessageIds.has(m.id),
  )

  // Build a lookup from telegram messageId → user name for reply resolution
  const messageIdToName = new Map<number, string>()
  for (const m of sessionMessages) {
    const name =
      m.user.username === 'claude_ai_bot'
        ? 'Claude'
        : m.user.firstName || m.user.username || 'Unknown'
    messageIdToName.set(m.messageId, name)
  }

  // Build context from recent session messages (last 20)
  const recentSession = filteredSession.slice(-20)
  const sessionContext =
    recentSession.length > 0
      ? recentSession
          .map((m) => {
            const name =
              m.user.username === 'claude_ai_bot'
                ? 'Claude'
                : m.user.firstName || m.user.username || 'Unknown'
            const replyToName = m.replyToMessageId
              ? messageIdToName.get(m.replyToMessageId) || null
              : null
            const replyTag = replyToName ? ` (replying to ${replyToName})` : ''
            return `[${name}]${replyTag}: "${m.text}"`
          })
          .join('\n')
      : '(session just started)'

  // Identify session participants (people who have talked in this session)
  const sessionParticipants = Array.from(
    new Set(
      sessionMessages
        .filter((m) => m.user.username !== 'claude_ai_bot')
        .map((m) => m.user.firstName || m.user.username || 'Unknown'),
    ),
  )

  const batchFormatted = newBatch
    .map((m, i) => {
      // Extract reply-to name if this is a reply
      const replyTo = m.telegramMessage?.reply_to_message
      const replyToName = replyTo?.from
        ? replyTo.from.first_name || replyTo.from.username || null
        : null
      const mentions = extractMentions(m.telegramMessage)
      return formatMessageForClassifier(
        m.user,
        m.savedMessage.text,
        i,
        replyToName,
        mentions,
      )
    })
    .join('\n')

  const participantsList =
    sessionParticipants.length > 0
      ? `\nPeople already in this conversation with Claude: ${sessionParticipants.join(', ')}`
      : ''

  const prompt = `You are a classifier for a group chat that includes an AI named Claude.
Claude is in an active conversation with multiple friends. Determine if Claude should respond to these new messages.

Recent conversation context:
${sessionContext}

New messages that just arrived together:
${batchFormatted}
${participantsList}

Decide:
- needs_response: Should Claude say something? true/false
- focus_indices: Which messages should Claude focus its response on? (0-based indices)

Rules:
- Conversations can span multiple topics - that's fine
- If someone is talking TO Claude, continuing from something Claude discussed, or could benefit from Claude's input → needs_response true
- If someone is responding to a topic that Claude previously discussed or interacted with, → needs_response true
- If someone is following up on something previously discussed by claude, → needs_response true
- Side conversations between others that don't involve Claude → needs_response false
- A brand new topic from someone who was NOT already talking to Claude → needs_response false, unless it is a direct reply to or is mentioning claude in some way, then needs_response true
- IMPORTANT: If a message @mentions a specific person who is NOT Claude (e.g. "@elsea", "@someone"), it is directed at that person. Claude should NOT respond unless also explicitly addressed.
- If a message is a reply to someone other than Claude, it's likely directed at that person, not Claude, but if it is relevant to something you discussed with that person, then needs_response true
- When humans are having a 1-on-1 exchange (asking each other questions, replying to each other), Claude should NOT interject even if the topic is interesting
- When genuinely ambiguous, lean toward needs_response true

First, write a brief witty commentary (1-2 sentences) about what's happening in these messages and why you're making your decision. Then on a new line respond with JSON: {"needs_response": true, "focus_indices": [0, 1]}`

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    })

    const text =
      response.content[0].type === 'text' ? response.content[0].text : ''

    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      log('classifier', 'parse failed, defaulting respond', { text })
      return {
        needs_response: true,
        focus_indices: newBatch.map((_, i) => i),
      }
    }

    const parsed = JSON.parse(jsonMatch[0])
    const result = {
      needs_response: parsed.needs_response,
      focus_indices: parsed.focus_indices || newBatch.map((_, i) => i),
    }

    const label = result.needs_response
      ? `ACCEPTED — focus: [${result.focus_indices}]`
      : 'SKIPPED'
    logVerbose(
      'classifier',
      label,
      `=== CLASSIFIER PROMPT ===\n${prompt}\n=== CLASSIFIER RESPONSE ===\n${text}`,
    )

    // Send to classifier log chat (fire-and-forget)
    sendClassifierLog(batchFormatted, text, result)

    return result
  } catch (error) {
    log('classifier', 'error, defaulting respond', { error })
    return {
      needs_response: true,
      focus_indices: newBatch.map((_, i) => i),
    }
  }
}

function sendClassifierLog(
  batchFormatted: string,
  haikuResponse: string,
  result: ClassificationResult,
) {
  const emoji = result.needs_response ? '🟢' : '🔴'
  const verdict = result.needs_response
    ? `RESPOND (focus: [${result.focus_indices}])`
    : 'SKIP'

  // Strip the JSON from haiku's response to get just the commentary
  const commentary = haikuResponse.replace(/\{[\s\S]*\}/, '').trim()

  const msg = [
    `${emoji} ${verdict}`,
    '',
    commentary ? commentary : '(no commentary)',
    '',
    `Messages:`,
    batchFormatted,
  ].join('\n')

  sendToLogChat(msg)
}
