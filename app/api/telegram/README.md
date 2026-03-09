# Telegram Claude Bot API

This directory contains the implementation of a Telegram bot that enables threaded conversations with Claude AI, maintaining conversation history and context across messages.

## 🚀 Features

### Core Functionality

- **Threaded Conversations**: Automatic creation and management of Claude conversation threads
- **Conversation History**: Full context preservation across message exchanges
- **Retroactive Thread Assignment**: Smart thread creation when replying to existing messages
- **Multiple Claude Identifiers**: Flexible ways to invoke Claude responses
- **Random Participation**: Claude occasionally joins regular conversations spontaneously

### Message Flow Logic

#### 1. New Messages with Claude Identifier

```
User: "hey claude, what's the weather?"
→ Creates new Claude thread
→ Stores user message with thread ID
→ Sends to Claude API (no history)
→ Stores and sends Claude response
```

#### 2. Replies to Claude Thread Messages

```
User: "what about tomorrow?" (replying to Claude's weather response)
→ Detects existing Claude thread
→ Builds full conversation history
→ Sends to Claude API with context
→ Continues threaded conversation
```

#### 3. Replies with Claude Identifier to Regular Messages

```
User 1: "This code isn't working"
User 2: "claude, can you help debug this?" (replying to User 1)
→ Creates new Claude thread
→ Retroactively assigns thread to original message
→ Builds history from both messages
→ Sends to Claude API with full context
```

#### 4. Regular Messages

```
User: "Just a normal chat message"
→ Stores message without Claude processing
→ Randomly (5% chance by default): Claude joins conversation naturally
```

#### 5. Random Participation

```
User 1: "I'm having trouble with my project"
User 2: "What kind of project?"
User 1: "A React app that keeps crashing"
Claude: [5% chance] "React crashes can be tricky! Are you seeing any specific error messages in the console?"
```

**How it works:**

- Claude observes regular chat conversations (both regular messages AND replies to non-Claude messages)
- Random number generation determines participation (configurable probability)
- Uses recent message history for context
- Responds naturally as a helpful chat member
- **Creates Claude threads automatically** - if someone replies to Claude's random response, it becomes a threaded conversation

## 🏗 Architecture

### File Structure

```
app/api/telegram/
├── route.ts          # Main webhook handler and Claude logic
├── utils.ts          # Helper functions for messaging and user management
├── checkChat.ts      # Chat validation and database management
├── randomResponse.ts # Random Claude participation in regular conversations
├── setup-claude.ts   # Setup script for creating Claude user
└── README.md         # This documentation
```

### Database Integration

The system leverages your existing database schema:

- **`claudeThreads`**: Tracks conversation threads linked to chats
- **`messages`**: Stores all messages with optional Claude thread IDs
- **`users`**: Manages user data with automatic upserts
- **`chats`**: Handles chat/group information

## 🔧 Key Functions

### Message Processing

- **`handleNewClaudeMessage()`** - Processes new Claude conversations
- **`handleReplyMessage()`** - Handles all reply scenarios with intelligent thread detection
- **`persistUserMessage()`** - Stores user messages with optional thread IDs
- **`persistClaudeMessage()`** - Stores Claude responses with thread context

### Thread Management

- **`createClaudeThread()`** - Creates new conversation threads
- **`getClaudeThreadFromMessage()`** - Finds existing thread IDs from message history
- **`getConversationHistory()`** - Builds complete conversation context for Claude API
- **`updateMessageWithClaudeThread()`** - Retroactively assigns threads to messages

### Utilities

- **`sendToClaudeAndRespond()`** - Handles Claude API calls and response processing
- **`ensureClaudeUserExists()`** - Auto-creates Claude user in database
- **`upsertUser()`** - Manages user data with conflict resolution

### Random Participation

- **`handleRandomResponse()`** - Manages spontaneous Claude participation in regular conversations
- **`getRecentMessages()`** - Retrieves chat context for random responses
- **`generateRandomChatPrompt()`** - Creates prompts for natural conversation participation

## 🎯 Claude Identifiers

The system recognizes multiple ways to invoke Claude:

- `"claude ..."` - Direct invocation
- `"hey claude ..."` - Friendly greeting
- `"dear claude ..."` - Formal address
- Various word order combinations supported

_Configuration in: `app/ai/claudeIdentifier.ts`_

## 🔌 Setup & Configuration

### Environment Variables

```env
# Required
ANTHROPIC_API_KEY=your_anthropic_api_key
TELEGRAM_TOKEN=your_telegram_bot_token

# Database
DATABASE_URL=your_supabase_database_url

# Optional: Random Response Configuration
CLAUDE_RANDOM_CHANCE=0.05        # 5% chance of random response (0.0 to 1.0)
CLAUDE_CONTEXT_MESSAGES=5        # Number of recent messages for context
CLAUDE_MAX_TOKENS=800           # Max tokens for random responses
```

### Webhook Configuration

**Local Development (with ngrok):**

```bash
curl -X POST https://api.telegram.org/bot{YOUR_BOT_TOKEN}/setWebhook \
  -H "Content-type: application/json" \
  -d '{"url": "https://your-ngrok-domain.ngrok-free.app/api/telegram"}'
```

**Production:**

```bash
curl -X POST https://api.telegram.org/bot{YOUR_BOT_TOKEN}/setWebhook \
  -H "Content-type: application/json" \
  -d '{"url": "https://your-domain.com/api/telegram"}'
```

### Database Setup

1. **Run database migrations** to ensure all tables exist
2. **Create the Claude user** (required for storing Claude's responses):

   **Option 1: Use the setup script (recommended)**

   ```bash
   npx tsx app/api/telegram/setup-claude.ts
   ```

   **Option 2: Add to package.json and run**

   ```json
   {
     "scripts": {
       "setup-claude": "tsx app/api/telegram/setup-claude.ts"
     }
   }
   ```

   Then run: `npm run setup-claude`

   **Option 3: Manual setup in your code**

   ```typescript
   import { setupClaudeUser } from './app/api/telegram/utils'
   await setupClaudeUser()
   ```

### Claude User Details

The system creates a special Claude user with:

- **Telegram ID**: `0` (no real user can have ID 0)
- **Username**: `claude_ai_bot`
- **First Name**: `Claude`
- **Purpose**: Stores Claude's responses in conversation threads

This approach works because:

- Telegram bots don't receive their own messages in webhooks
- We need a database record to associate Claude's responses with conversation threads
- Using ID 0 ensures no conflict with real users

## 📝 Usage Examples

### Starting a New Conversation

```
User: "hey claude, explain quantum computing"
Claude: [Detailed explanation...]
User: "can you give me a simple analogy?"
Claude: [Continues with context from previous explanation...]
```

### Contextual Help

```
Alice: "I'm having trouble with this React component"
Bob: "claude, can you help debug this?" (replying to Alice)
Claude: [Analyzes Alice's message and provides targeted help...]
```

### Thread Continuation

```
User: "claude, plan my weekend itinerary for Paris"
Claude: [Provides itinerary...]
User: "what about restaurants near the Louvre?" (replying to Claude)
Claude: [Responds with restaurant recommendations, knowing the Paris context...]
```

### Random Participation

```
Alice: "My laptop is running so slow lately"
Bob: "Have you tried restarting it?"
Alice: "Yeah, multiple times. Still sluggish"
Charlie: "Maybe check your storage space?"
Claude: [Random 5% chance] "If it's a Mac, you might want to check Activity Monitor for apps using high CPU. Sometimes background processes can really slow things down!"
Dave: "Oh good point! I had that issue with Chrome once"
```

### Random Response Threading

```
User 1: "Anyone know good Python libraries for data analysis?"
User 2: "I use pandas mostly"
Claude: [Random response] "Pandas is great! You might also want to check out Polars for faster performance on large datasets, and Seaborn for beautiful visualizations."
User 1: [Replying to Claude] "What makes Polars faster than pandas?"
Claude: [Threaded response] "Polars uses a columnar memory layout and is written in Rust, which makes it much faster for operations on large datasets. It also has better memory efficiency and can handle larger-than-memory datasets more gracefully than pandas."
```

## 🛠 Technical Details

### Error Handling

- Comprehensive TypeScript error checking
- Graceful handling of missing message data
- Database transaction safety
- API failure recovery

### Performance Considerations

- Efficient database queries with proper indexing
- Minimal API calls through intelligent thread detection
- Conversation history limited to thread scope

### Security

- Input validation for all message types
- Secure environment variable handling
- Database query parameterization

## 🚧 Development Notes

### Testing Scenarios

1. **New Claude conversations** - Test thread creation
2. **Reply continuations** - Verify history building
3. **Retroactive threading** - Test thread assignment to existing messages
4. **Mixed conversations** - Regular messages + Claude interactions
5. **Error conditions** - Network failures, invalid data

### Monitoring

- Console logging for thread creation and user management
- Error tracking for API failures
- Database operation success/failure logging

## 📚 Related Files

- **`app/ai/prompt.ts`** - Claude prompt generation and formatting
- **`app/ai/claudeIdentifier.ts`** - Claude invocation pattern matching
- **`app/db/schema.ts`** - Database schema definitions
- **`app/db/index.ts`** - Database connection and configuration

---

_Last updated: [Current Date]_
_System Status: ✅ Ready for production use_
