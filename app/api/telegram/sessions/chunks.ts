import db from '@/app/db'
import { messages, messageChunks } from '@/app/db/schema'
import { eq, and, isNull, asc, desc, count, max, sql } from 'drizzle-orm'
import { log } from '../utils/log'
import { summarizeChunkMessages } from './summarize'
import { HISTORY_WINDOW } from './config'

/**
 * Count messages in a chat that haven't been assigned to a chunk yet.
 */
export async function countUnchunkedMessages(
  chatDbId: string,
): Promise<number> {
  const result = await db
    .select({ count: count() })
    .from(messages)
    .where(and(eq(messages.chatId, chatDbId), isNull(messages.chunkId)))

  return result[0].count
}

/**
 * Get the next chunk index for a chat (max existing + 1, or 0).
 */
export async function getNextChunkIndex(chatDbId: string): Promise<number> {
  const result = await db
    .select({ maxIndex: max(messageChunks.chunkIndex) })
    .from(messageChunks)
    .where(eq(messageChunks.chatId, chatDbId))

  return (result[0].maxIndex ?? -1) + 1
}

/**
 * Create a chunk from the oldest 100 unchunked messages in a chat.
 * Uses a transaction to ensure atomicity.
 */
export async function createChunk(chatDbId: string): Promise<string | null> {
  try {
    return await db.transaction(async (tx) => {
      // Get oldest 100 unchunked messages
      const oldest = await tx.query.messages.findMany({
        where: and(eq(messages.chatId, chatDbId), isNull(messages.chunkId)),
        orderBy: asc(messages.createdAt),
        limit: HISTORY_WINDOW,
      })

      if (oldest.length < HISTORY_WINDOW) return null

      const chunkIndex = await getNextChunkIndex(chatDbId)
      const startMessage = oldest[0]
      const endMessage = oldest[oldest.length - 1]

      // Insert chunk row
      const [chunk] = await tx
        .insert(messageChunks)
        .values({
          chatId: chatDbId,
          chunkIndex,
          startMessageId: startMessage.id,
          endMessageId: endMessage.id,
          messageCount: oldest.length,
        })
        .returning()

      // Set chunkId on all these messages
      const messageIds = oldest.map((m) => m.id)
      await tx
        .update(messages)
        .set({ chunkId: chunk.id })
        .where(
          sql`${messages.id} IN (${sql.join(
            messageIds.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        )

      log('chunks', `created chunk ${chunkIndex} (${oldest.length} msgs)`, {
        chunkId: chunk.id,
        chatId: chatDbId,
      })

      return chunk.id
    })
  } catch (err: any) {
    // Handle unique constraint violation (race condition)
    if (err?.code === '23505') {
      log('chunks', 'duplicate chunk (race condition), skipping')
      return null
    }
    throw err
  }
}

/**
 * Summarize a chunk's messages using Haiku.
 */
export async function summarizeChunk(chunkId: string): Promise<void> {
  const chunkMessages = await db.query.messages.findMany({
    where: eq(messages.chunkId, chunkId),
    orderBy: asc(messages.createdAt),
    with: { user: true },
  })

  if (chunkMessages.length === 0) {
    log('chunks', 'no messages found for chunk', { chunkId })
    return
  }

  try {
    const summary = await summarizeChunkMessages(chunkMessages)

    await db
      .update(messageChunks)
      .set({ summary, summarizedAt: new Date() })
      .where(eq(messageChunks.id, chunkId))

    log('chunks', 'chunk summarized', {
      chunkId,
      summaryLength: summary.length,
    })
  } catch (err) {
    log('chunks', 'chunk summary failed', { chunkId, error: err })
  }
}

/**
 * Check if chunks need to be created and summarized.
 * Loops to handle backlog (e.g. if 300 unchunked messages exist).
 */
export async function maybeCreateChunks(chatDbId: string): Promise<void> {
  let unchunked = await countUnchunkedMessages(chatDbId)

  while (unchunked >= HISTORY_WINDOW) {
    const chunkId = await createChunk(chatDbId)
    if (!chunkId) break

    // Summarize async (don't block chunk creation loop)
    summarizeChunk(chunkId).catch((err) =>
      log('chunks', 'summarize error', { error: err }),
    )

    unchunked = await countUnchunkedMessages(chatDbId)
  }
}

/**
 * Get the most recent N summarized chunks for a chat.
 */
export async function getRecentChunkSummaries(
  chatDbId: string,
  count: number = 10,
) {
  const chunks = await db.query.messageChunks.findMany({
    where: eq(messageChunks.chatId, chatDbId),
    orderBy: desc(messageChunks.chunkIndex),
    limit: count,
  })

  return chunks.reverse() // chronological order
}

/**
 * Get all unchunked messages for a chat, ordered by createdAt.
 */
export async function getUnchunkedMessages(chatDbId: string) {
  return db.query.messages.findMany({
    where: and(eq(messages.chatId, chatDbId), isNull(messages.chunkId)),
    orderBy: asc(messages.createdAt),
    with: { user: true },
  })
}

/**
 * Get chunks that intersect a range of chunk indices (inclusive).
 */
export async function getChunksByIndexRange(
  chatDbId: string,
  fromIndex: number,
  toIndex: number,
) {
  const chunks = await db.query.messageChunks.findMany({
    where: and(
      eq(messageChunks.chatId, chatDbId),
      sql`${messageChunks.chunkIndex} >= ${fromIndex}`,
      sql`${messageChunks.chunkIndex} <= ${toIndex}`,
    ),
    orderBy: asc(messageChunks.chunkIndex),
  })

  return chunks
}

// Track active regen jobs per chat (survives hot reloads)
const g = globalThis as typeof globalThis & {
  __regenRunning?: Map<string, { done: number; total: number }>
}
if (!g.__regenRunning) g.__regenRunning = new Map()
const regenRunning = g.__regenRunning

/**
 * Fix chunk timestamps by replacing createdAt with the startMessage's createdAt.
 */
export async function fixChunkTimestamps(chatDbId: string): Promise<number> {
  const allChunks = await db.query.messageChunks.findMany({
    where: eq(messageChunks.chatId, chatDbId),
    orderBy: asc(messageChunks.chunkIndex),
  })

  let fixed = 0
  for (const chunk of allChunks) {
    const startMsg = await db.query.messages.findFirst({
      where: eq(messages.id, chunk.startMessageId),
    })
    if (startMsg) {
      await db
        .update(messageChunks)
        .set({ createdAt: startMsg.createdAt })
        .where(eq(messageChunks.id, chunk.id))
      fixed++
    }
  }

  log('chunks', `fixed timestamps on ${fixed}/${allChunks.length} chunks`)
  return fixed
}

/** Check if a regen is already running for this chat. Returns progress or null. */
export function getRegenStatus(chatDbId: string): { done: number; total: number } | null {
  return regenRunning.get(chatDbId) ?? null
}

/**
 * Wipe all chunk summaries for a chat and regenerate them sequentially.
 * Returns the number of chunks regenerated.
 */
export async function regenerateAllChunkSummaries(
  chatDbId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const allChunks = await db.query.messageChunks.findMany({
    where: eq(messageChunks.chatId, chatDbId),
    orderBy: asc(messageChunks.chunkIndex),
  })

  if (allChunks.length === 0) return 0

  // Clear all summaries
  await db
    .update(messageChunks)
    .set({ summary: null, summarizedAt: null })
    .where(eq(messageChunks.chatId, chatDbId))

  log('chunks', `cleared ${allChunks.length} chunk summaries for regen`)

  regenRunning.set(chatDbId, { done: 0, total: allChunks.length })

  try {
    // Regenerate sequentially to avoid rate limits
    for (let i = 0; i < allChunks.length; i++) {
      await summarizeChunk(allChunks[i].id)
      regenRunning.set(chatDbId, { done: i + 1, total: allChunks.length })
      onProgress?.(i + 1, allChunks.length)
    }
  } finally {
    regenRunning.delete(chatDbId)
  }

  return allChunks.length
}

/**
 * Find the chunkId for a specific message (or null if unchunked).
 */
export async function getMessageChunkIndex(
  messageId: string,
): Promise<number | null> {
  const msg = await db.query.messages.findFirst({
    where: eq(messages.id, messageId),
  })

  if (!msg?.chunkId) return null

  const chunk = await db.query.messageChunks.findFirst({
    where: eq(messageChunks.id, msg.chunkId),
  })

  return chunk?.chunkIndex ?? null
}
