import fs from 'fs'
import path from 'path'
import { ChatType, MessageChunkType, memories, users } from '@/app/db/schema'
import db from '@/app/db'
import { eq, and, desc, inArray } from 'drizzle-orm'
import { MessageAndUser } from '../utils/history'
import { getSessionMessages, getRecentSessionSummaries } from './sessionDb'
import { getUnchunkedMessages, getRecentChunkSummaries } from './chunks'
import { BufferedMessage } from './types'
import { HISTORY_WINDOW } from './config'

const PROMPTS_DIR = path.join(process.cwd(), 'logs', 'prompts')
const MAX_PROMPT_FILES = 20

function savePromptLog(prompt: string, sessionId: string, isFirstPrompt: boolean) {
  try {
    fs.mkdirSync(PROMPTS_DIR, { recursive: true })

    // Build filename: datetime + session snippet
    const now = new Date()
    const ts = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      '_',
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('')
    const tag = isFirstPrompt ? 'first' : 'cont'
    const filename = `${ts}_${tag}_${sessionId.substring(0, 8)}.txt`

    fs.writeFileSync(path.join(PROMPTS_DIR, filename), prompt)

    // Enforce cap: delete oldest files if over limit
    const files = fs
      .readdirSync(PROMPTS_DIR)
      .filter((f) => f.endsWith('.txt'))
      .sort()

    if (files.length > MAX_PROMPT_FILES) {
      const toDelete = files.slice(0, files.length - MAX_PROMPT_FILES)
      for (const f of toDelete) {
        fs.unlinkSync(path.join(PROMPTS_DIR, f))
      }
    }
  } catch {
    // Silent fail — don't let logging break the app
  }
}

function formatMessages(
  msgs: MessageAndUser[],
  allMessages?: MessageAndUser[],
): string {
  // Build a lookup from telegram messageId → user name for reply resolution
  const messageIdToName = new Map<number, string>()
  const source = allMessages || msgs
  for (const m of source) {
    const name =
      m.user.username === 'claude_ai_bot'
        ? 'Claude'
        : m.user.firstName || m.user.username || 'Unknown'
    messageIdToName.set(m.messageId, name)
  }

  return msgs
    .map((m) => {
      const name =
        m.user.username === 'claude_ai_bot'
          ? 'Claude'
          : m.user.firstName || m.user.username || 'Unknown'
      const time = m.createdAt.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      })
      const replyToName = m.replyToMessageId
        ? messageIdToName.get(m.replyToMessageId) || null
        : null
      const replyTag = replyToName ? ` (replying to ${replyToName})` : ''
      return `[${time}] ${name}${replyTag} said "${m.text}"`
    })
    .join('\n')
}

function getTimeAgo(date: Date): string {
  const minutes = (Date.now() - date.getTime()) / (1000 * 60)
  if (minutes < 60) return `${Math.round(minutes)}m ago`
  const hours = minutes / 60
  if (hours < 24) return `${Math.round(hours)}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function formatChunkSummaries(chunks: MessageChunkType[]): string {
  return chunks
    .filter((c) => c.summary)
    .map(
      (c) =>
        `[Chunk ${c.chunkIndex} — ${c.messageCount} msgs, ${getTimeAgo(c.createdAt)}] ${c.summary}`,
    )
    .join('\n')
}

function formatNewBatch(newBatch: BufferedMessage[]): string {
  return newBatch
    .map((b) => {
      const name = b.user.firstName || b.user.username || 'Unknown'
      const time = b.savedMessage.createdAt.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      })
      const replyTo = b.telegramMessage?.reply_to_message
      const replyToName = replyTo?.from
        ? replyTo.from.first_name || replyTo.from.username || null
        : null
      const replyTag = replyToName ? ` (replying to ${replyToName})` : ''
      return `[${time}] ${name}${replyTag} said "${b.savedMessage.text}"`
    })
    .join('\n')
}

async function getParticipantMemories(
  chatDbId: string,
  participantUserIds: string[],
): Promise<string> {
  if (participantUserIds.length === 0) return ''

  // Fetch last 5 memories per participant in a single query, then slice per user
  const results = await db
    .select({
      memory: memories.memory,
      userId: memories.userId,
      firstName: users.firstName,
      username: users.username,
    })
    .from(memories)
    .innerJoin(users, eq(memories.userId, users.id))
    .where(
      and(
        eq(memories.chatId, chatDbId),
        inArray(memories.userId, participantUserIds),
      ),
    )
    .orderBy(desc(memories.createdAt))

  if (results.length === 0) return ''

  // Group by userId, keep only last 5 per user
  const grouped = new Map<string, { name: string; mems: string[] }>()
  for (const r of results) {
    const name = r.firstName || r.username || 'Unknown'
    if (!grouped.has(r.userId)) grouped.set(r.userId, { name, mems: [] })
    const entry = grouped.get(r.userId)!
    if (entry.mems.length < 5) entry.mems.push(r.memory)
  }

  const lines = Array.from(grouped.values()).map(
    ({ name, mems }) => `  ${name}: ${mems.join(', ')}`,
  )

  return lines.join('\n')
}

function buildSystemPrompt(chat: ChatType): string {
  return `<system_prompt>
  You're Claude, an active participant in a group chat with friends.

  CRITICAL: Messages in <chat_history> have ALREADY been seen and addressed by you.
  Do NOT re-respond to, repeat, or re-address anything in chat history.
  ONLY respond to the messages in <new_messages>.

  - Keep it chill and conversational, matching the energy of the chat
  - Be genuinely helpful when they need info, but don't be overly formal
  - TEXT LIKE A HUMAN: Send multiple rapid-fire messages naturally
  - Use send_messages to plan and send all your messages at once
  - Break thoughts into natural message chunks instead of one long response
  - Do not mention that you are an AI
  - Do not ask follow up questions unless REALLY needed
  - If the new messages don't seem to need your input, just call stop_turn
</system_prompt>

<tool_use_instructions>
  send_messages:
    - The current chat ID is: ${chat.chatId}
    - Plan all your messages upfront and send them together
    - For formatting, specify what text to make bold, italic, etc.

  web_search:
    - Search for current information when needed
    - Include links to sources when using search results

  send_voice:
    - If users are sending voice messages, you should typically respond with voice too — match the medium
    - The current chat ID is: ${chat.chatId}

  send_poll:
    - The current chat ID is: ${chat.chatId}
    - Stop your turn after sending a poll

  save_memory:
    - Save a concise fact about someone for long-term recall
    - Keep it to one bullet point — preferences, life events, habits, opinions, running jokes
    - You can save things you deduce or infer, not just what's said explicitly
    - Patterns, personality traits, interests, context clues — anything you'd want to remember next session
    - Don't save trivial or transient things

  read_memory:
    - Recall saved memories about people in the chat
    - Recent memories for active participants are already provided above — use this for deeper lookups

  stop_turn:
    - REQUIRED to end every conversational turn
    - Call this after completing your response
    - Also call this if you decide you don't need to respond
</tool_use_instructions>
`
}

/**
 * Unified session prompt builder.
 *
 * Structure: system → session_intro (first only) → summarized_recent_history → chat_history → new_messages
 *
 * W = HISTORY_WINDOW, Mc = session messages already addressed
 * - Session messages shown = min(Mc, W)
 * - Pre-session messages shown = W - sessionSlice.length
 * - Chunk count: Mc > W → ceil((Mc - W) / W), else 3
 */
export async function buildSessionPrompt(
  sessionId: string,
  newBatch: BufferedMessage[],
  chat: ChatType,
): Promise<string> {
  const W = HISTORY_WINDOW

  // 1. Fetch session history, separate previous vs batch
  const sessionHistory = await getSessionMessages(sessionId)
  const batchMessageIds = new Set(newBatch.map((b) => b.savedMessage.id))
  const previousMessages = sessionHistory.filter(
    (m) => !batchMessageIds.has(m.id),
  )

  const Mc = previousMessages.length
  const isFirstPrompt = Mc === 0

  // 2. Get all unchunked messages for this chat
  const allUnchunked = await getUnchunkedMessages(chat.id)

  // 3. Compute chat_history slices
  const unchunkedPrevious = previousMessages.filter((m) => !m.chunkId)
  const sessionSlice = unchunkedPrevious.slice(-Math.min(Mc, W))

  const sessionMsgIds = new Set(sessionHistory.map((m) => m.id))
  const preSessionUnchunked = allUnchunked.filter(
    (m) => !sessionMsgIds.has(m.id) && !batchMessageIds.has(m.id),
  )
  const preSessionSlice = preSessionUnchunked.slice(-(W - sessionSlice.length))

  const chatHistory = [...preSessionSlice, ...sessionSlice]

  // 4. Compute chunk count
  const chunkCount = Mc > W ? Math.ceil((Mc - W) / W) : 3

  // 5. Build prompt
  let prompt = buildSystemPrompt(chat)

  // Session intro — only on first prompt
  if (isFirstPrompt) {
    const summaries = await getRecentSessionSummaries(chat.id, 5)
    const summaryLines = summaries
      .filter((s) => s.summary)
      .map((s) => {
        const ago = getTimeAgo(s.closedAt || s.createdAt)
        return `- [${ago}] ${s.summary}`
      })
      .join('\n')

    prompt += `
<session_intro>
  You are starting a new conversation session.`

    if (summaryLines) {
      prompt += `
  Recent past sessions:
  ${summaryLines}`
    }

    prompt += `
</session_intro>
`
  }

  // Summarized recent history — chunk summaries
  const chunks = await getRecentChunkSummaries(chat.id, chunkCount)
  const chunkText = formatChunkSummaries(chunks)
  if (chunkText) {
    prompt += `
<summarized_recent_history>
  Compressed history from older messages:
  ${chunkText}
</summarized_recent_history>
`
  }

  // Participant memories — last 5 per user present in the prompt messages
  const participantUserIds = new Set<string>()
  for (const m of chatHistory) participantUserIds.add(m.userId)
  for (const b of newBatch) participantUserIds.add(b.savedMessage.userId)
  const participantMemories = await getParticipantMemories(
    chat.id,
    Array.from(participantUserIds),
  )
  if (participantMemories) {
    prompt += `
<memories>
${participantMemories}
</memories>
`
  }

  // Chat history — combined pre-session + session messages
  if (chatHistory.length > 0) {
    prompt += `
<chat_history already_addressed="true">
  These messages have already been seen. Do NOT repeat or re-address these:
  ${formatMessages(chatHistory, allUnchunked)}
</chat_history>
`
  }

  // New messages
  prompt += `
<new_messages>
  These messages just came in. Respond to THESE only:
  ${formatNewBatch(newBatch)}
</new_messages>`

  savePromptLog(prompt, sessionId, isFirstPrompt)

  return prompt
}
