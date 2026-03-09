import Anthropic from '@anthropic-ai/sdk'
import TelegramBot from 'node-telegram-bot-api'
import { persistClaudeMessage } from './utils/persist'
import { assertChatExistsOrCreate } from './utils/assertExists'
import {
  spawnClaudeCodeInstance,
  getClaudeCodeInstance,
  listClaudeCodeInstances,
} from './utils/claudeCodeInstances'
import { log } from './utils/log'
import db from '@/app/db'
import { memories, users } from '@/app/db/schema'
import { eq, and, desc, gte, or, ilike } from 'drizzle-orm'

// ─── Sticker registry ────────────────────────────────────────────────
// Add stickers here. Use /info (reply to a sticker) to get the file_id.
// The name + description are shown to Claude so it can pick the right one.

type StickerEntry = { fileId: string; description: string }

const stickerRegistry: Record<string, StickerEntry> = {
  judging_cat: {
    fileId: 'AAMCAgADHQJuzNZVAAEDMdppqcR2hJtISJzdOgnVmvkHhtSoEgAC0GoAAmFWmEmyfRJ_x5_v4gEAB20AAzoE',
    description: 'Cat stares blankly and wide-eyed, judging. Use for: absurdity, loss of words, a message that warrants no response',
  },
  patrick_bateman: {
    fileId: 'AAMCAgADIQUABOH5eDkAAgVYaaycOEhGWCl1zN4rkoNG2EcKLqsAAqxuAAImIphJOPFijbayJ8UBAAdtAAM6BA',
    description: 'American Psycho scene, Patrick Bateman shakily drops card. Use for: bewildered/shocked/amazed/astounded by unique content',
  },
  spray_bottle: {
    fileId: 'CAACAgQAAyEFAATh-Xg5AAIFXWmsnZv1K-hFKjfGhOekmQgxH1uIAAJgDQAC0f8AAVCTfyI2tYHupDoE',
    description: 'Spraying water with the text "no." Use for: response to bad messages, when you wish the user would stop',
  },
  orange_cat: {
    fileId: 'CAACAgEAAyEFAATh-Xg5AAIFYWmsnhWtXbZ1Lz6QIuTNeFRmhxbeAAIEAwAC0pPhRGIByGwc2FONOgQ',
    description: 'Cute orange cat named Mimir. Use for: random cat content, general happiness',
  },
}

// Build the sticker list string for the tool description
function buildStickerList(): string {
  const entries = Object.entries(stickerRegistry)
  if (entries.length === 0) return 'No stickers configured yet.'
  return entries.map(([name, s]) => `- "${name}": ${s.description}`).join('\n')
}

// Relative time helper for memory display
function getRelativeTime(date: Date): string {
  const minutes = (Date.now() - date.getTime()) / (1000 * 60)
  if (minutes < 60) return `${Math.round(minutes)}m ago`
  const hours = minutes / 60
  if (hours < 24) return `${Math.round(hours)}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function safeParseJson(str: string): any {
  try { return JSON.parse(str) } catch { return str }
}

// Context type for tool execution
export type ToolContext = {
  chat: any
  claudeThreadId?: string
  sessionId?: string
  user: any
}

// Create bot instance for tool use
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN || '')

// Define your custom tool functions
export const toolFunctions = {
  // Send multiple messages to a Telegram chat with entity-based formatting
  send_messages: async (
    params: {
      chat_id: string
      messages: Array<{
        text: string
        entities?: Array<{
          target: string
          type: 'bold' | 'italic' | 'code' | 'pre' | 'underline' | 'strikethrough'
        }>
        link?: {
          text: string
          url: string
        }
      }>
    },
    context?: ToolContext,
  ) => {
    try {
      const results = []

      for (let i = 0; i < params.messages.length; i++) {
        const message = params.messages[i]

        // Build full text — append link text on its own line if present
        let fullText = message.text
        const telegramEntities: TelegramBot.MessageEntity[] = []

        // Resolve target-based entities to offset/length by finding the target string in the text
        if (message.entities) {
          for (const entity of message.entities) {
            const idx = fullText.indexOf(entity.target)
            if (idx !== -1) {
              telegramEntities.push({
                type: entity.type,
                offset: idx,
                length: entity.target.length,
              })
            }
          }
        }

        // Append link as a button-style text_link on a new line
        if (message.link) {
          const linkOffset = fullText.length + 1 // +1 for newline
          fullText += `\n${message.link.text}`
          telegramEntities.push({
            type: 'text_link',
            offset: linkOffset,
            length: message.link.text.length,
            url: message.link.url,
          })
        }

        // Send message to Telegram
        const result = await bot.sendMessage(
          params.chat_id,
          fullText,
          telegramEntities.length > 0
            ? { entities: telegramEntities }
            : undefined,
        )

        // Ensure chat exists in database (or use context chat if available)
        const chat = context?.chat || (await assertChatExistsOrCreate(result))

        await persistClaudeMessage({
          message: result,
          chat: chat,
          claudeThreadId: context?.claudeThreadId || null,
          sessionId: context?.sessionId || null,
        })

        results.push({
          message_id: result.message_id,
          sent_at: new Date(result.date * 1000).toISOString(),
          entities_applied: telegramEntities.length,
        })

        // Small delay between messages for natural feel
        if (i < params.messages.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }

      return {
        success: true,
        messages_sent: results.length,
        results: results,
      }
    } catch (error) {
      log('tools', 'send_messages error', { error })
      throw error
    }
  },
  send_poll: async (
    params: {
      chat_id: string
      question: string
      options: string[]
    },
    context?: ToolContext,
  ) => {
    const result = await bot.sendPoll(
      params.chat_id,
      params.question,
      params.options,
    )

    // Ensure chat exists in database (or use context chat if available)
    const chat = context?.chat || (await assertChatExistsOrCreate(result))

    const pollString =
      'Sent a poll: ' +
      params.question +
      ' with options: ' +
      params.options.join(', ')

    // Add text to result for persistence (polls don't have text by default)
    const messageWithText = { ...result, text: pollString }

    await persistClaudeMessage({
      message: messageWithText as TelegramBot.Message,
      chat: chat,
      claudeThreadId: context?.claudeThreadId || null,
    })

    return {
      success: true,
      message: pollString,
      results: {
        status: 'Poll sent successfully!',
        message_id: result.message_id,
        sent_at: new Date(result.date * 1000).toISOString(),
        options: params.options,
        question: params.question,
      },
    }
  },

  // Send a sticker from the pre-selected registry
  send_sticker: async (
    params: {
      chat_id: string
      sticker_name: string
    },
    context?: ToolContext,
  ) => {
    const entry = stickerRegistry[params.sticker_name]
    if (!entry) {
      return {
        success: false,
        error: `Unknown sticker "${params.sticker_name}". Available: ${Object.keys(stickerRegistry).join(', ')}`,
      }
    }

    try {
      const result = await bot.sendSticker(params.chat_id, entry.fileId)

      const chat = context?.chat || (await assertChatExistsOrCreate(result))
      const messageWithText = { ...result, text: `[Sticker: ${params.sticker_name}]` }

      await persistClaudeMessage({
        message: messageWithText as TelegramBot.Message,
        chat: chat,
        claudeThreadId: context?.claudeThreadId || null,
        sessionId: context?.sessionId || null,
      })

      return {
        success: true,
        message_id: result.message_id,
        sticker_name: params.sticker_name,
      }
    } catch (error) {
      log('tools', 'send_sticker error', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  },

  // Send a voice message using ElevenLabs TTS
  send_voice: async (
    params: {
      chat_id: string
      text: string
    },
    context?: ToolContext,
  ) => {
    try {
      const apiKey = process.env.ELEVENLABS_API_KEY
      if (!apiKey) {
        return { success: false, error: 'ELEVENLABS_API_KEY not configured' }
      }

      const voiceId = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb'

      // Call ElevenLabs TTS API
      const ttsResponse = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: params.text,
            model_id: 'eleven_multilingual_v2',
            output_format: 'mp3_44100_128',
          }),
        },
      )

      if (!ttsResponse.ok) {
        const err = await ttsResponse.text()
        log('tools', 'elevenlabs TTS failed', { status: ttsResponse.status, err })
        return { success: false, error: `ElevenLabs API error: ${ttsResponse.status}` }
      }

      const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer())

      // Send as voice message to Telegram
      const result = await bot.sendVoice(params.chat_id, audioBuffer, {}, {
        filename: 'voice.mp3',
        contentType: 'audio/mpeg',
      })

      // Persist with the text content
      const chat = context?.chat || (await assertChatExistsOrCreate(result))
      const messageWithText = { ...result, text: `[Voice message: "${params.text}"]` }

      await persistClaudeMessage({
        message: messageWithText as TelegramBot.Message,
        chat: chat,
        claudeThreadId: context?.claudeThreadId || null,
        sessionId: context?.sessionId || null,
      })

      return {
        success: true,
        message_id: result.message_id,
        sent_at: new Date(result.date * 1000).toISOString(),
        text_spoken: params.text,
      }
    } catch (error) {
      log('tools', 'send_voice error', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  },

  // Save a concise memory about a user
  save_memory: async (
    params: {
      user_name: string
      memory: string
    },
    context?: ToolContext,
  ) => {
    try {
      if (!context?.chat?.id) {
        return { success: false, error: 'No chat context available' }
      }

      // Look up user by firstName or username (case-insensitive)
      const user = await db.query.users.findFirst({
        where: or(
          ilike(users.firstName, params.user_name),
          ilike(users.username, params.user_name),
        ),
      })

      if (!user) {
        return { success: false, error: `User "${params.user_name}" not found` }
      }

      // Insert memory
      await db.insert(memories).values({
        userId: user.id,
        chatId: context.chat.id,
        memory: params.memory,
      })

      // Fire-and-forget notification
      const displayName = user.firstName || user.username || params.user_name
      bot.sendMessage(
        context.chat.chatId,
        `💾 Remembered about ${displayName}: ${params.memory}`,
      ).catch((err) => log('tools', 'memory notification send failed', { error: err }))

      return { success: true, message: `Memory saved for ${displayName}` }
    } catch (error) {
      log('tools', 'save_memory error', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  },

  // Read saved memories about users
  read_memory: async (
    params: {
      user_name?: string
      time_range?: 'recent' | 'today' | 'all'
    },
    context?: ToolContext,
  ) => {
    try {
      if (!context?.chat?.id) {
        return { success: false, error: 'No chat context available' }
      }

      const range = params.time_range || 'recent'

      // If "all" requires a user_name
      if (range === 'all' && !params.user_name) {
        return { success: false, error: '"all" time_range requires a user_name' }
      }

      let userId: string | undefined
      let displayName: string | undefined

      if (params.user_name) {
        const user = await db.query.users.findFirst({
          where: or(
            ilike(users.firstName, params.user_name),
            ilike(users.username, params.user_name),
          ),
        })
        if (!user) {
          return { success: false, error: `User "${params.user_name}" not found` }
        }
        userId = user.id
        displayName = user.firstName || user.username || params.user_name
      }

      // Build conditions
      const conditions = [eq(memories.chatId, context.chat.id)]
      if (userId) {
        conditions.push(eq(memories.userId, userId))
      }
      if (range === 'today') {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
        conditions.push(gte(memories.createdAt, twentyFourHoursAgo))
      }

      const limit = range === 'recent' ? 50 : undefined

      const results = await db
        .select({
          memory: memories.memory,
          createdAt: memories.createdAt,
          firstName: users.firstName,
          username: users.username,
        })
        .from(memories)
        .innerJoin(users, eq(memories.userId, users.id))
        .where(and(...conditions))
        .orderBy(desc(memories.createdAt))
        .limit(limit ?? 1000)

      if (results.length === 0) {
        return {
          success: true,
          memories: [],
          message: userId
            ? `No memories found for ${displayName}`
            : 'No memories found for this chat',
        }
      }

      // Format with relative time
      const formatted = results.map((r) => {
        const name = r.firstName || r.username || 'Unknown'
        const ago = getRelativeTime(r.createdAt)
        return `- [${name}] ${r.memory} (${ago})`
      })

      return {
        success: true,
        count: results.length,
        memories: formatted,
      }
    } catch (error) {
      log('tools', 'read_memory error', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  },

  // Signal that Claude is done with his conversational turn
  stop_turn: async (_params?: any, _context?: ToolContext) => {
    return {
      success: true,
      message: 'Turn ended',
    }
  },

  // Run a new Claude Code instance
  run_claude_code: async (
    params: {
      directory: string
      input: string
    },
    context?: ToolContext,
  ) => {
    const ALLOWED_USER_ID = Number(process.env.ADMIN_TELEGRAM_ID)
    const userTelegramId = context?.user?.telegramId

    if (userTelegramId !== ALLOWED_USER_ID) {
      log('tools', 'unauthorized claude-code attempt', { userId: userTelegramId })
      return {
        success: false,
        error: 'Unauthorized: This tool is restricted to the bot owner only.',
      }
    }

    try {
      const { id, instance } = await spawnClaudeCodeInstance(
        params.directory,
        params.input,
      )

      return {
        success: true,
        instance_id: id,
        status: instance.status,
        message: `Claude Code instance #${id} started successfully and is running in the background. IMMEDIATELY call stop_turn now. Do NOT call run_claude_code again. Do NOT call any other tools. Just tell the user it started and call stop_turn.`,
        pid: instance.pid,
      }
    } catch (error) {
      log('tools', 'run_claude_code error', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  },

  // Check status of a Claude Code instance
  check_claude_code_instance: async (
    params: {
      instance_id: number
    },
    context?: ToolContext,
  ) => {
    const ALLOWED_USER_ID = Number(process.env.ADMIN_TELEGRAM_ID)
    const userTelegramId = context?.user?.telegramId

    if (userTelegramId !== ALLOWED_USER_ID) {
      log('tools', 'unauthorized claude-code attempt', { userId: userTelegramId })
      return {
        success: false,
        error: 'Unauthorized: This tool is restricted to the bot owner only.',
      }
    }

    try {
      const instance = await getClaudeCodeInstance(params.instance_id)

      if (!instance) {
        return {
          success: false,
          error: `Instance #${params.instance_id} not found`,
        }
      }

      return {
        success: true,
        instance_id: instance.id,
        status: instance.status,
        directory: instance.directory,
        input: instance.input,
        output: instance.output.substring(0, 2000), // Limit output size
        error: instance.error,
        created_at: instance.createdAt,
        completed_at: instance.completedAt,
        output_truncated: instance.output.length > 2000,
      }
    } catch (error) {
      log('tools', 'check_instance error', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  },

  // List all Claude Code instances
  list_claude_code_instances: async (
    params?: any,
    context?: ToolContext,
  ) => {
    const ALLOWED_USER_ID = Number(process.env.ADMIN_TELEGRAM_ID)
    const userTelegramId = context?.user?.telegramId

    if (userTelegramId !== ALLOWED_USER_ID) {
      log('tools', 'unauthorized claude-code attempt', { userId: userTelegramId })
      return {
        success: false,
        error: 'Unauthorized: This tool is restricted to the bot owner only.',
      }
    }

    try {
      const instances = await listClaudeCodeInstances()

      return {
        success: true,
        count: instances.length,
        instances: instances.map((inst) => ({
          id: inst.id,
          status: inst.status,
          directory: inst.directory,
          input: inst.input.substring(0, 100),
          created_at: inst.createdAt,
          completed_at: inst.completedAt,
        })),
      }
    } catch (error) {
      log('tools', 'list_instances error', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  },
}

// Tool function definitions - the actual tool schema descriptions below are what Claude sees

// Define the tool schemas that Claude needs to understand
export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'send_messages',
    description:
      'Send multiple rapid-fire messages to a Telegram chat. Most messages should be plain text. Use entities sparingly for emphasis (bold, italic, code). Use the link field to attach a URL below the message as a tappable button — great for sources, references, or "read more" links.',
    input_schema: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'string',
          description: 'The Telegram chat ID to send messages to',
        },
        messages: {
          type: 'array',
          description: 'Array of messages to send in rapid succession',
          items: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description: 'The message text content',
              },
              entities: {
                type: 'array',
                description:
                  'Optional formatting entities. Specify the exact text to format and the style — offsets are resolved automatically. Only use when formatting adds real value.',
                items: {
                  type: 'object',
                  properties: {
                    target: {
                      type: 'string',
                      description: 'The exact substring in the message text to format (must match text exactly)',
                    },
                    type: {
                      type: 'string',
                      enum: ['bold', 'italic', 'code', 'pre', 'underline', 'strikethrough'],
                      description: 'The formatting style to apply',
                    },
                  },
                  required: ['target', 'type'],
                },
              },
              link: {
                type: 'object',
                description:
                  'Optional link to append below the message as a tappable block. Use for sources, references, articles.',
                properties: {
                  text: {
                    type: 'string',
                    description: 'The display text for the link (e.g. "Source", "Read more", "Latest update")',
                  },
                  url: {
                    type: 'string',
                    description: 'The URL to link to',
                  },
                },
                required: ['text', 'url'],
              },
            },
            required: ['text'],
          },
        },
      },
      required: ['chat_id', 'messages'],
    },
  },
  {
    name: 'send_voice',
    description:
      'Send a voice message to a Telegram chat using text-to-speech. Use this when you want to speak out loud instead of typing — for dramatic effect, jokes, impressions, roasts, or whenever a voice message would hit harder than text. The voice will sound like a natural human voice.',
    input_schema: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'string',
          description: 'The Telegram chat ID to send the voice message to',
        },
        text: {
          type: 'string',
          description:
            'The text to speak aloud. Write it naturally as spoken words — no formatting, no emojis, just what you want to say out loud.',
        },
      },
      required: ['chat_id', 'text'],
    },
  },
  {
    name: 'send_poll',
    description:
      'Create and send a poll to a Telegram chat. Users can vote by selecting from the provided options.',
    input_schema: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'string',
          description: 'The Telegram chat ID to send the poll to',
        },
        question: {
          type: 'string',
          description: 'The poll question or prompt',
        },
        options: {
          type: 'array',
          description: 'Array of poll options that users can vote for',
          items: {
            type: 'string',
            description: 'Individual poll option text',
          },
          minItems: 2,
          maxItems: 10,
        },
      },
      required: ['chat_id', 'question', 'options'],
    },
  },
  {
    name: 'send_sticker',
    description: `Send a sticker to the chat. Pick the sticker that best matches the mood or reaction you want to express. Available stickers:\n${buildStickerList()}`,
    input_schema: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'string',
          description: 'The Telegram chat ID to send the sticker to',
        },
        sticker_name: {
          type: 'string',
          description: 'The name of the sticker to send (must match one from the available list)',
          enum: Object.keys(stickerRegistry),
        },
      },
      required: ['chat_id', 'sticker_name'],
    },
  },
  {
    name: 'save_memory',
    description:
      'Save a concise fact about someone in the chat. Use for things worth remembering long-term — preferences, life events, habits, opinions, running jokes. You can also save things you deduce or infer about someone, not just things they say explicitly. If you pick up on patterns, personality traits, interests, or context clues, save those too. Anything you wouldn\'t want to forget across sessions. Keep memories extremely concise (one bullet point). Don\'t save trivial or transient things.',
    input_schema: {
      type: 'object',
      properties: {
        user_name: {
          type: 'string',
          description: 'The first name or username of the person this memory is about',
        },
        memory: {
          type: 'string',
          description: 'A concise fact to remember (one bullet point)',
        },
      },
      required: ['user_name', 'memory'],
    },
  },
  {
    name: 'read_memory',
    description:
      'Recall saved memories about people in the chat. Omit user_name to browse recent memories across all users.',
    input_schema: {
      type: 'object',
      properties: {
        user_name: {
          type: 'string',
          description: 'Optional: first name or username to filter memories for a specific person',
        },
        time_range: {
          type: 'string',
          enum: ['recent', 'today', 'all'],
          description: 'Time range for memories. "recent" = last 50, "today" = last 24h, "all" = everything (requires user_name). Default: "recent"',
        },
      },
      required: [],
    },
  },
  {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 5,
  } as any,
  {
    name: 'stop_turn',
    description:
      'End your conversational turn. You can use multiple tools in sequence during your turn, but you must eventually call stop_turn to finish. Without this call, you will continue indefinitely in a loop. Call this when you have completed everything you want to say or do in this turn.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'run_claude_code',
    description:
      'Run a new instance of Claude Code (the AI coding CLI tool) on the local computer. This spawns a detached process that will continue running even after this conversation ends. Use check_claude_code_instance to monitor progress. RESTRICTED: Only available to the bot admin.',
    input_schema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description:
            'The directory path where Claude Code should run. IMPORTANT: Pass the path EXACTLY as the user provided it - do not expand ~, do not convert to absolute paths, do not reconstruct or modify in any way. The tool handles all path expansion. Examples: if user says "~/Projects/foo", pass "~/Projects/foo" exactly; if user says "/Users/name/dir", pass that exactly.',
        },
        input: {
          type: 'string',
          description:
            'The input prompt/message to send to Claude Code. This is what Claude Code will work on.',
        },
      },
      required: ['directory', 'input'],
    },
  },
  {
    name: 'check_claude_code_instance',
    description:
      'Check the status and output of a running or completed Claude Code instance. Returns current output, status (running/completed/error), and other details. RESTRICTED: Only available to the bot admin.',
    input_schema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'number',
          description:
            'The instance ID number returned when you ran run_claude_code.',
        },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'list_claude_code_instances',
    description:
      'List all Claude Code instances (running and completed). Shows ID, status, directory, and timestamps for each instance. RESTRICTED: Only available to the bot admin.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
]

// Helper function to execute a tool
export async function executeTool(
  toolName: string,
  parameters: any,
  context?: ToolContext,
) {
  const toolFunction = toolFunctions[toolName as keyof typeof toolFunctions]

  if (!toolFunction) {
    throw new Error(`Unknown tool: ${toolName}`)
  }

  try {
    const result = await toolFunction(parameters, context)
    return result
  } catch (error) {
    log('tools', `${toolName} error`, { error })
    throw error
  }
}

// Function to handle tool use in Claude conversation
export async function handleClaudeWithTools(
  client: Anthropic,
  messages: Anthropic.MessageParam[],
  context: ToolContext,
): Promise<boolean> {
  log('toolLoop', 'starting tool loop')

  let response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages,
    tools: toolDefinitions,
    tool_choice: { type: 'auto' },
  })

  // Loop until Claude calls stop_turn or we hit a safety limit
  let turnComplete = false
  let iterationCount = 0
  const maxIterations = 10 // Safety net
  let _usedTools = false

  while (
    !turnComplete &&
    response.content.some((content) => content.type === 'tool_use') &&
    iterationCount < maxIterations
  ) {
    iterationCount++
    const toolUses = response.content.filter(
      (content) => content.type === 'tool_use',
    )
    const toolResults: Anthropic.ToolResultBlockParam[] = []

    log('toolLoop', `iter ${iterationCount}: ${toolUses.map(t => t.name).join(', ')}`, {
      iter: iterationCount,
      tools: toolUses.map(t => t.name),
      thinking: response.content
        .filter((c): c is Anthropic.TextBlock => c.type === 'text')
        .map(c => c.text)
        .join(' '),
    })

    for (const content of toolUses) {

      // Check if Claude is ending his turn
      if (content.name === 'stop_turn') {
        turnComplete = true
        _usedTools = true

        // Still process the stop_turn tool for consistency
        try {
          const result = await executeTool(content.name, content.input, context)
          toolResults.push({
            type: 'tool_result',
            tool_use_id: content.id,
            content: JSON.stringify(result),
          })
        } catch (error) {
          log('toolLoop', 'tool error', { tool: content.name, error })
          toolResults.push({
            type: 'tool_result',
            tool_use_id: content.id,
            content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
            is_error: true,
          })
        }
        break // Stop processing other tools this iteration
      }

      // Execute other tools normally
      if (content.name === 'send_messages' || content.name === 'send_voice') {
        _usedTools = true
      }

      try {
        const result = await executeTool(content.name, content.input, context)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: content.id,
          content: JSON.stringify(result),
        })
      } catch (error) {
        log('toolLoop', 'tool error', { tool: content.name, error })
        toolResults.push({
          type: 'tool_result',
          tool_use_id: content.id,
          content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
          is_error: true,
        })
      }
    }

    // If turn is complete, break the loop
    if (turnComplete) {
      break
    }

    // Get Claude's next response in the conversation
    const newMessages: Anthropic.MessageParam[] = [
      ...messages,
      { role: 'assistant', content: response.content },
      { role: 'user', content: toolResults },
    ]

    log('toolLoop', `continuing (${newMessages.length} msgs in history)`, {
      iter: iterationCount,
      totalMessages: newMessages.length,
      messageRoles: newMessages.map(m => m.role),
      lastToolResult: toolResults.length > 0 ? safeParseJson(toolResults[0].content as string) : null,
    })

    response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: newMessages,
      tools: toolDefinitions,
      tool_choice: { type: 'auto' },
    })

    // CRITICAL: Update messages for next iteration so conversation history accumulates
    messages = newMessages
  }

  log('toolLoop', `done (${iterationCount} iterations)`)
  return true
}
