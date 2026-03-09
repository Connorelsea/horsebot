import Anthropic from '@anthropic-ai/sdk'
import TelegramBot from 'node-telegram-bot-api'
import { log } from './utils/log'

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN || '')

// ─── Site command definitions ────────────────────────────────────────
// Add a new entry here to create a /command that searches a specific site.
// Everything else (search, fetch, filtering, response) is handled automatically.

type SiteCommandDef = {
  /** The slash command name without the slash, e.g. "cars" → /cars */
  command: string
  /** Short description shown in /help */
  description: string
  /** Domain(s) to restrict search + fetch to */
  domains: string[]
  /** URL to provide in the prompt so web_fetch can access it */
  url: string
  /** Optional extra instruction appended to the prompt */
  systemHint?: string
}

const siteCommands: SiteCommandDef[] = [
  {
    command: 'cars',
    description: 'Search Cars & Bids — /cars <query>',
    domains: ['carsandbids.com'],
    url: 'https://carsandbids.com',
    systemHint: 'Focus on current and recent auction listings, prices, and vehicle details.',
  },
]

// ─── Builder ─────────────────────────────────────────────────────────

type CommandDef = {
  handler: (ctx: {
    message: TelegramBot.Message
    chat: any
  }) => Promise<void>
  description: string
}

function buildSiteCommand(site: SiteCommandDef): CommandDef {
  return {
    description: site.description,
    handler: async ({ message }) => {
      const query = extractArgs(message.text)
      if (!query) {
        await bot.sendMessage(
          message.chat.id,
          `Usage: /${site.command} <query>`,
        )
        return
      }

      await bot.sendMessage(message.chat.id, `🔍 Searching ${site.domains[0]}...`)

      try {
        const client = new Anthropic({
          apiKey: process.env.ANTHROPIC_API_KEY,
        })

        const prompt = [
          `The user wants to know about: ${query}`,
          ``,
          `Search ${site.url} and fetch relevant pages to answer their question.`,
          `Be concise and include specific details (prices, dates, links) when available.`,
          site.systemHint || '',
          ``,
          `Site URL for reference: ${site.url}`,
        ]
          .filter(Boolean)
          .join('\n')

        const response = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          tools: [
            {
              type: 'web_search_20250305',
              name: 'web_search',
              max_uses: 3,
              allowed_domains: site.domains,
            } as any,
            {
              type: 'web_fetch_20250910',
              name: 'web_fetch',
              max_uses: 2,
              allowed_domains: site.domains,
              max_content_tokens: 20000,
            } as any,
          ],
          messages: [{ role: 'user', content: prompt }],
        })

        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')

        if (!text) {
          await bot.sendMessage(message.chat.id, 'No results found.')
          log('command', `/${site.command} — empty response`)
          return
        }

        // Telegram 4096 char limit
        const truncated =
          text.length > 4000
            ? text.substring(0, 4000) + '\n\n...(truncated)'
            : text
        await bot.sendMessage(message.chat.id, truncated)
        log('command', `/${site.command} — "${query.substring(0, 40)}"`)
      } catch (error) {
        log('command', `/${site.command} error`, { error })
        await bot.sendMessage(message.chat.id, 'Search failed — try again later.')
      }
    },
  }
}

function extractArgs(text?: string): string {
  if (!text) return ''
  return text.replace(/^\/\S+/, '').trim()
}

// ─── Export built commands ───────────────────────────────────────────

/** All site commands as a Record, ready to spread into the commands map. */
export const builtSiteCommands: Record<string, CommandDef> = {}
for (const site of siteCommands) {
  builtSiteCommands[`/${site.command}`] = buildSiteCommand(site)
}
