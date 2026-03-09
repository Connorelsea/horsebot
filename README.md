# Corehole Bot

A Telegram group chat bot powered by Claude that participates naturally in conversations. It uses session-based context management with intelligent message batching, a relevance classifier, and a sliding-window chunk system to maintain long-term memory across conversations.

## How It Works

1. Messages arrive via Telegram webhook
2. Media (images, stickers, voice) is enriched into text descriptions
3. Messages are batched via a debounce timer to handle rapid group chat streams
4. A Haiku classifier decides if Claude should respond to the batch
5. Claude responds through a tool loop (send messages, polls, stickers, voice, web search, etc.)
6. Older messages are compressed into chunk summaries to stay within token limits

Sessions auto-close after inactivity and are summarized. The bot remembers facts about users across sessions via a memory system.

See [docs/architecture.md](docs/architecture.md) for the full technical deep-dive.

## Features

- **Session-based conversations** — Context preserved across messages with auto-timeout and summaries
- **Smart batching** — Debounce system groups rapid messages before processing
- **Relevance classifier** — Haiku decides when Claude should respond vs. stay silent
- **Sliding window context** — Recent messages kept raw, older ones compressed into chunk summaries
- **Media support** — Images/stickers described via vision, voice/audio transcribed via Whisper
- **Tool use** — Claude can send formatted messages, polls, stickers, voice messages, and search the web
- **Per-user memory** — Persistent facts saved and recalled across sessions
- **Permission system** — Per-chat permission levels (`none` / `command` / `full`)
- **Site search commands** — Declarative framework for domain-specific search (e.g. `/cars`)
- **Claude Code integration** — Admin can spawn Claude Code CLI instances from the chat

## Prerequisites

You'll need accounts and API keys from:

| Service | Purpose | Link |
|---------|---------|------|
| **Anthropic** | Claude API (Sonnet for responses, Haiku for classification/summarization) | [console.anthropic.com](https://console.anthropic.com) |
| **Telegram** | Bot token via BotFather | [t.me/BotFather](https://t.me/BotFather) |
| **Supabase** | PostgreSQL database + connection pooling | [supabase.com](https://supabase.com) |
| **Groq** | Whisper speech-to-text for voice messages | [console.groq.com](https://console.groq.com) |
| **ElevenLabs** *(optional)* | Text-to-speech for voice message responses | [elevenlabs.io](https://elevenlabs.io) |

You'll also need [Node.js](https://nodejs.org) 18+ and [ngrok](https://ngrok.com) (or similar) for local development.

## Setup

### 1. Clone and install

```bash
git clone <repo-url>
cd corehole-bot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in your keys:

```env
# Required
ANTHROPIC_API_KEY=sk-ant-...        # From Anthropic Console
TELEGRAM_TOKEN=123456:ABC...        # From @BotFather
DATABASE_URL=postgresql://...       # Supabase connection string (use Transaction pooler URL)
ADMIN_TELEGRAM_ID=123456789         # Your Telegram user ID (use /info or @userinfobot)

# Optional
GROQ_API_KEY=gsk_...                # For voice transcription
ELEVENLABS_API_KEY=sk_...           # For TTS voice responses
ELEVENLABS_VOICE_ID=...             # ElevenLabs voice to use
CLASSIFIER_LOG_CHAT_ID=-100...      # Telegram chat to send debug logs to
```

See `.env.example` for all available options including session timing, history window size, and random participation chance.

### 3. Set up the database

Create a new project on [Supabase](https://supabase.com). Copy the connection string from Settings > Database > Connection string > Transaction pooler (port 6543). Use this as your `DATABASE_URL`.

Then run migrations:

```bash
npm run gen_migrate      # Generate migration files
npm run apply_migrate    # Apply to database
```

If you need to push schema changes directly (skipping migration files):

```bash
npx drizzle-kit push
```

### 4. Create the Claude bot user

The bot needs a user record in the database to persist its own messages:

```bash
npm run setup_claude
```

### 5. Set up the Telegram webhook

Start your dev server and expose it:

```bash
npm run dev              # Start Next.js on port 3000
npm run local_forward    # ngrok tunnel (or use your own)
```

Then register your webhook URL with Telegram:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://<your-domain>/api/telegram"}'
```

### 6. Allow your chat

New chats default to `none` permission (bot ignores them). Add the bot to your Telegram group, then send:

```
/allow full
```

This requires your Telegram user ID to match `ADMIN_TELEGRAM_ID`.

## Deployment

Deploy anywhere that runs Next.js. The bot uses a single webhook endpoint at `/api/telegram`.

**Vercel** works out of the box — just set your environment variables in the dashboard and update the webhook URL to your Vercel domain.

## Commands

| Command | Description | Admin |
|---------|-------------|-------|
| `/help` | List commands | |
| `/sessions` | Show active and recent sessions | |
| `/chunks` | Show recent chunk summaries | |
| `/memory` | Show saved memories (reply to filter by user) | |
| `/web <query>` | Search the web | |
| `/cars <query>` | Search carsandbids.com | |
| `/allow <level>` | Set chat permission: `none`, `command`, `full` | Yes |
| `/stop` | Close active session with summary | Yes |
| `/pause` | Toggle pause (persist messages, skip Claude) | Yes |
| `/info` | Dump message JSON (reply to inspect) | Yes |
| `/chat` | Show chat/DB IDs | Yes |
| `/regen` | Regenerate all chunk summaries | Yes |
| `/fixtime` | Repair chunk timestamps | Yes |

## Project Structure

```
app/
  api/telegram/
    route.ts                 # Webhook entry point
    commands.ts              # Command definitions and dispatcher
    tools.ts                 # Claude tool implementations
    siteCommands.ts          # Site-specific search command framework
    pauseState.ts            # Global pause toggle
    sessions/
      debounce.ts            # Message batching
      classifier.ts          # Haiku relevance classifier
      sessionDb.ts           # Session CRUD and timeout
      sessionPrompt.ts       # Prompt construction
      chunks.ts              # Chunk creation and summarization
      summarize.ts           # Session/chunk summarization
      config.ts              # HISTORY_WINDOW constant
    messageHandlers/
      newSessionMessage.ts   # Session-mode message routing
    utils/
      persist.ts             # Message persistence
      history.ts             # Message history queries
      describeImage.ts       # Vision-based image description
      transcribeVoice.ts     # Groq Whisper transcription
      log.ts                 # Logging
      assertExists.ts        # User/chat upsert
  ai/
    claudeIdentifier.ts      # "claude" mention detection
  db/
    schema.ts                # Drizzle ORM schema
    index.ts                 # Database connection
docs/
  architecture.md            # Detailed architecture documentation
drizzle/                     # Migration files
```

## License

MIT
