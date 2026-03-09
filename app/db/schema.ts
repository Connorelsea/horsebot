import { relations } from 'drizzle-orm'
import {
  pgTable,
  text,
  timestamp,
  integer,
  uuid,
  bigint,
  boolean,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export const claudeThreads = pgTable('claude_threads', {
  id: uuid('id').primaryKey().defaultRandom(),
  chatId: uuid('chat_id')
    .references(() => chats.id)
    .notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const claudeThreadRelations = relations(
  claudeThreads,
  ({ one, many }) => ({
    chat: one(chats, {
      fields: [claudeThreads.chatId],
      references: [chats.id],
    }),
    messages: many(messages),
  }),
)

export const claudeSessions = pgTable('claude_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  chatId: uuid('chat_id')
    .references(() => chats.id)
    .notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastActivityAt: timestamp('last_activity_at').defaultNow().notNull(),
  status: text('status').notNull().default('active'),
  summary: text('summary'),
  closedAt: timestamp('closed_at'),
  triggerMessageId: uuid('trigger_message_id'),
})

export const claudeSessionRelations = relations(
  claudeSessions,
  ({ one, many }) => ({
    chat: one(chats, {
      fields: [claudeSessions.chatId],
      references: [chats.id],
    }),
    messages: many(messages),
    triggerMessage: one(messages, {
      fields: [claudeSessions.triggerMessageId],
      references: [messages.id],
    }),
  }),
)

export const chats = pgTable('chats', {
  id: uuid('id').primaryKey().defaultRandom(),
  chatId: bigint('chat_id', { mode: 'number' }).notNull().unique(),
  title: text('title'),
  username: text('username'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  permission: text('permission').notNull().default('none'), // 'none' | 'command' | 'full'
})

export const chatRelations = relations(chats, ({ one, many }) => ({
  claudeThreads: one(claudeThreads, {
    fields: [chats.id],
    references: [claudeThreads.chatId],
  }),
  claudeSessions: many(claudeSessions),
  messages: many(messages),
  messageChunks: many(messageChunks),
}))

export const messageChunks = pgTable(
  'message_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: uuid('chat_id')
      .references(() => chats.id)
      .notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    startMessageId: uuid('start_message_id').notNull(),
    endMessageId: uuid('end_message_id').notNull(),
    messageCount: integer('message_count').notNull(),
    summary: text('summary'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    summarizedAt: timestamp('summarized_at'),
  },
  (table) => ({
    chatChunkIdx: uniqueIndex('chunk_chat_index_idx').on(table.chatId, table.chunkIndex),
  }),
)

export const messageChunkRelations = relations(
  messageChunks,
  ({ one, many }) => ({
    chat: one(chats, {
      fields: [messageChunks.chatId],
      references: [chats.id],
    }),
    messages: many(messages),
  }),
)

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  telegramId: bigint('telegram_id', { mode: 'number' }).notNull().unique(),
  username: text('username'),
  firstName: text('first_name'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: integer('message_id').notNull(),
  userId: uuid('user_id')
    .references(() => users.id)
    .notNull(),
  text: text('text').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  messageThreadId: integer('message_thread_id'),
  isReply: boolean('is_reply').default(false).notNull(),
  replyToMessageId: integer('reply_to_message_id'),
  chatId: uuid('chat_id')
    .references(() => chats.id)
    .notNull(),
  claudeThreadId: uuid('claude_thread_id').references(() => claudeThreads.id),
  sessionId: uuid('session_id').references(() => claudeSessions.id),
  chunkId: uuid('chunk_id').references(() => messageChunks.id),
})

export const messageRelations = relations(messages, ({ one }) => ({
  user: one(users, {
    fields: [messages.userId],
    references: [users.id],
  }),
  chat: one(chats, {
    fields: [messages.chatId],
    references: [chats.id],
  }),
  claudeThread: one(claudeThreads, {
    fields: [messages.claudeThreadId],
    references: [claudeThreads.id],
  }),
  claudeSession: one(claudeSessions, {
    fields: [messages.sessionId],
    references: [claudeSessions.id],
  }),
  chunk: one(messageChunks, {
    fields: [messages.chunkId],
    references: [messageChunks.id],
  }),
}))

export const memories = pgTable('memories', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .references(() => users.id)
    .notNull(),
  chatId: uuid('chat_id')
    .references(() => chats.id)
    .notNull(),
  memory: text('memory').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})

export const memoryRelations = relations(memories, ({ one }) => ({
  user: one(users, {
    fields: [memories.userId],
    references: [users.id],
  }),
  chat: one(chats, {
    fields: [memories.chatId],
    references: [chats.id],
  }),
}))

export type UserType = typeof users.$inferSelect
export type MessageType = typeof messages.$inferSelect
export type ChatType = typeof chats.$inferSelect
export type SessionType = typeof claudeSessions.$inferSelect
export type MessageChunkType = typeof messageChunks.$inferSelect
export type MemoryType = typeof memories.$inferSelect
