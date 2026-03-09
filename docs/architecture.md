# Architecture

## End-to-End Message Flow

```
Telegram Webhook POST
  |
  v
route.ts
  |- Extract message metadata (hasClaudeIdentifier, isReply, etc.)
  |- Create/get user & chat DB records
  |- Media enrichment (blocking):
  |    |- Image/sticker -> Sonnet vision description
  |    |- Voice/audio -> Groq Whisper transcription
  |- Permission gate (none → ignore, command → commands only, full → all)
  |- Command interception (if applicable)
  |- Route to handler:
       |- newSessionMessage.ts (session mode)
            |- Persist message to DB
            |- maybeCreateChunks() (fire-and-forget)
            |- Check for active session
            |- Add to debounce buffer OR create new session
            |
            v
       Debounce timer fires (DEBOUNCE_MS)
            |- classifyBatch() via Haiku (unless explicit Claude trigger)
            |- buildSessionPrompt() with chunk summaries + sliding window
            |- handleClaudeWithTools() via Sonnet
            |    |- Tool loop: send_messages, web_search, send_poll, etc.
            |    |- Persist Claude responses to DB
            |    |- Loop until stop_turn or max iterations
            v
       Session timeout (10 min inactivity)
            |- closeSession() with Haiku summary
            |- maybeCreateChunks() (fire-and-forget)
```

## Debounce System

Messages arrive rapidly in group chats. The debounce system batches them:

1. First message creates a buffer with a timer (`DEBOUNCE_MS`, default 14 seconds)
2. Each subsequent message resets the timer and adds to the buffer
3. When the timer fires, `processBuffer()` runs:
   - If `hasClaudeTrigger` is set (explicit mention or reply-to-Claude), skip classification
   - Otherwise, run the Haiku classifier to decide if a response is needed
   - Build the session prompt and call Claude with tools
4. Buffer is deleted immediately on processing to prevent race conditions

The buffer is stored in a global Map keyed by `chatDbId`, surviving Next.js hot reloads in development.

## Classifier Pipeline

The Haiku relevance classifier (`classifier.ts`) decides whether Claude should respond to a batch of messages. It receives:

- Recent session context (last 20 messages)
- The new message batch with sender names and reply relationships

It returns:
- `needs_response: boolean` - whether Claude should engage
- `focus_indices: number[]` - which messages in the batch to prioritize

If `needs_response` is false, the entire batch is silently skipped. This prevents Claude from responding to unrelated side conversations in group chats.

The classifier is bypassed when a user explicitly triggers Claude (mentions "claude", replies to Claude's message, or random roll succeeds).

## History Management (Chunk Architecture)

### Sliding Window

The system maintains a sliding window of raw (unchunked) messages controlled by `HISTORY_WINDOW` (default 50). When that many unchunked messages accumulate in a chat, the oldest batch is grouped into a chunk and summarized.

- **Unchunked messages**: `messages.chunk_id IS NULL` - always the most recent N messages
- **Chunked messages**: assigned to a `message_chunks` row, compressed into a summary
- **Chunk creation**: triggered fire-and-forget after every `persistMessage()` and on session close

### Chunk Creation Flow

```
maybeCreateChunks(chatDbId)
  |- Count unchunked messages
  |- While count >= HISTORY_WINDOW:
       |- createChunk(): transaction that:
       |    |- Selects oldest HISTORY_WINDOW unchunked messages
       |    |- Creates a message_chunks row
       |    |- Sets chunk_id on those messages
       |- summarizeChunk(): async Haiku call
       |    |- Fetches chunk messages with user info
       |    |- Generates 3-5 sentence summary
       |    |- Stores summary + summarizedAt on chunk row
       |- Re-count unchunked (loop for backlog)
```

Race conditions are handled via a unique constraint on `(chat_id, chunk_index)`. Duplicate creation attempts are caught and silently skipped.

### First Prompt vs Continuation Prompt

**First prompt** (no previously-addressed messages in the session):

```xml
<system_prompt>       -- Chat personality and rules
<tool_use_instructions>
<session_intro>       -- "You are starting a new conversation session"
                      -- Last 5 closed session summaries
<chunk_summaries>     -- Last 10 chunk summaries (broad historical context)
<recent_messages>     -- Up to HISTORY_WINDOW unchunked messages (pre-session context)
<new_messages>        -- The debounced batch to respond to
```

**Continuation prompt** (session already underway):

```xml
<system_prompt>
<tool_use_instructions>
<chunk_summaries>     -- Chunks spanning the session's lifetime (see below)
<pre_session_context> -- Unchunked non-session messages to fill the window
<session_history>     -- Unchunked session messages already addressed
<new_messages>        -- The debounced batch
```

### Session-Aware Chunk Selection

On continuation prompts, chunks are selected based on the session's full span:

1. Find the chunk containing the session's trigger message (or earliest session message)
2. Find the latest chunk that exists for the chat
3. Include ALL chunks in that range (by `chunkIndex`)

This ensures Claude always has compressed context for the entire session, even when early session messages have been chunked away during a long conversation.

### Long Session Behavior

As a session grows, chunking fires periodically, compressing older messages into chunk summaries. The prompt shows those summaries plus the most recent raw unchunked messages, so Claude retains full context via summaries while staying within token budget.

## Session Lifecycle

### Creation Triggers

Sessions are created when:
1. **Claude mention**: message contains "claude" (or configured identifier) with no active session
2. **Reply-to-Claude**: user replies to a Claude message with no active session
3. **Random roll**: configurable probability (`CLAUDE_RANDOM_CHANCE`) triggers a session on any message

Each creation stores a `triggerMessageId` on the session for chunk selection.

### Active Session Handling

When an active session exists, all incoming messages are:
1. Persisted to DB
2. Associated with the session (`messages.session_id`)
3. Added to the debounce buffer

### Timeout and Close

- Sessions auto-close after 10 minutes of no classifier-accepted activity
- `getActiveSession()` checks timeout on every call
- On close: generates a 3-6 sentence Haiku summary, stores it, sends it to chat
- Also triggers `maybeCreateChunks()` as a secondary check

## Points of Persistence

| What | Where | When |
|------|-------|------|
| User messages | `route.ts` -> `persistMessage()` | On webhook receipt, after media enrichment |
| Claude messages | `tools.ts` -> `persistClaudeMessage()` | After each tool loop iteration |
| Edited messages | `sessionDb.ts` -> `updateMessageText()` | On `edited_message` webhook |
| Session summaries | `sessionDb.ts` -> `closeSession()` | On session timeout/close |
| Chunk summaries | `chunks.ts` -> `summarizeChunk()` | After chunk creation |
| Session-message links | `sessionDb.ts` -> `addMessageToSession()` | When message joins a session |
| Chunk-message links | `chunks.ts` -> `createChunk()` | When HISTORY_WINDOW messages are chunked |

## Media Enrichment

Media enrichment happens **before** routing, blocking the webhook handler. After enrichment, the message's `text` field contains the media description, and all downstream systems treat it as regular text.

### Image Handling

**File:** `utils/describeImage.ts`

1. Detect photo or sticker attachment on the Telegram message
2. Download the file from Telegram API using the file ID
3. Convert to base64
4. Send to Claude Sonnet with vision capability
5. Receive 2-5 sentence description
6. Mutate `message.text` to include the description (prefixed with context like "[Sent an image]")

### Voice Handling

**File:** `utils/transcribeVoice.ts`

1. Detect voice, audio, or video_note attachment
2. Download the file from Telegram API
3. Send to Groq Whisper API for speech-to-text transcription
4. Mutate `message.text` to include the transcription with duration info
5. Auto-send the transcription back to the chat as a caption (so other users can read it)

Both enrichment steps produce log output to the configured log chat for debugging.

## Permission System

Each chat has a `permission` column: `none`, `command`, or `full` (default `none`).

- **`none`** — Bot ignores the chat entirely. Only `/allow` bypasses this gate so an admin can upgrade the chat.
- **`command`** — Bot commands work, but no session/classifier/response routing.
- **`full`** — Full behavior: commands + sessions + Claude responses.

The `/allow` admin command sets the level: `/allow full`, `/allow command`, `/allow none`.

## Tool System

Claude responds via a tool loop (`handleClaudeWithTools`). Available tools:

| Tool | Description |
|------|-------------|
| `send_messages` | Send one or more messages with entity formatting and links |
| `send_sticker` | Send a sticker from a pre-configured registry |
| `send_voice` | Text-to-speech via ElevenLabs, sent as Telegram voice message |
| `send_poll` | Create a poll in the chat |
| `web_search` | Built-in Claude web search |
| `save_memory` / `read_memory` | Persistent per-user memories |
| `run_claude_code` | Spawn a Claude Code CLI instance (admin-only) |
| `check_claude_code_instance` / `list_claude_code_instances` | Monitor Claude Code instances (admin-only) |
| `stop_turn` | Required — ends Claude's turn (without it, the loop continues) |

## Site Commands

A declarative framework for domain-restricted search commands (`siteCommands.ts`). Each entry defines a slash command, target domain(s), and optional system hint. The framework handles the search-fetch-respond flow automatically using Haiku with `web_search` and `web_fetch` tools.
