# Claude Custom Tools - How They Work

## The Key Insight

**Claude doesn't execute tools** - your application does! Claude just tells you which tool to call and with what parameters.

## The Flow

1. **Define Tool Schema** - You provide tool definitions in the `tools` array when creating messages

   ```typescript
   const tools = [
     {
       name: 'get_weather',
       description: 'Get weather for a location',
       input_schema: {
         /* JSON schema */
       },
     },
   ]
   ```

2. **Claude Chooses Tools** - Claude returns a "tool_use" content block

   ```json
   {
     "type": "tool_use",
     "id": "tool_12345",
     "name": "get_weather",
     "input": { "location": "San Francisco" }
   }
   ```

3. **Your Code Executes** - You run the actual function

   ```typescript
   const result = await getWeather('San Francisco')
   ```

4. **Send Results Back** - You provide the tool result to Claude

   ```typescript
   {
     "type": "tool_result",
     "tool_use_id": "tool_12345",
     "content": JSON.stringify(result)
   }
   ```

5. **Claude Continues** - Claude uses the result to continue the conversation

## Key Files Created

- **`tools.ts`** - Contains tool definitions and execution logic
- **`toolUseTest.ts`** - Test file showing how to use tools
- **`claude-with-tools-example.ts`** - Integration example for your Telegram bot

## Tool Function Structure

```typescript
// 1. Define the actual function
const myTool = async (params: { param1: string }) => {
  // Your actual implementation here
  return { result: 'something' }
}

// 2. Define the schema for Claude
const myToolDefinition = {
  name: 'my_tool',
  description: 'What this tool does',
  input_schema: {
    type: 'object',
    properties: {
      param1: { type: 'string', description: 'What param1 does' },
    },
    required: ['param1'],
  },
}
```

## Rich Telegram Messages

The `send_telegram_message` tool now supports rich formatting using Telegram entities! Claude can create messages with:

- **Text formatting**: Bold, italic, underline, strikethrough
- **Interactive elements**: Links, mentions, hashtags
- **Code**: Inline code and code blocks with syntax highlighting
- **Privacy**: Spoiler text that's hidden until clicked
- **And more**: Bot commands, emails, phone numbers

### Entity Examples

```typescript
// Bold text from position 0, length 5
{ type: 'bold', offset: 0, length: 5 }

// Spoiler text (hidden until clicked)
{ type: 'spoiler', offset: 10, length: 15 }

// Code block with language
{ type: 'pre', offset: 30, length: 25, language: 'javascript' }

// Custom link
{ type: 'text_link', offset: 60, length: 10, url: 'https://example.com' }

// User mention
{ type: 'text_mention', offset: 75, length: 8, user: { id: 12345 } }
```

### 🎯 Positioning Guide (CRITICAL for Claude)

**IMPORTANT: Use PLAIN TEXT only - NO markdown symbols!**

The biggest issues with rich messages are:

1. Including markdown symbols (**bold**, _italic_) in text
2. Incorrect positioning calculations

Here's how to get it right:

1. **Write your full text as PLAIN TEXT first** (no \*\* \_\_ ~~ etc.)
2. **Count every character from position 0**:

   - Letters, spaces, punctuation, newlines (\n) all count as 1 character
   - Be extra careful with spaces and newlines!
   - **NEWLINE RULE**: Each \n counts as exactly 1 character - don't skip it!

3. **Example walkthrough (MULTIPLE ENTITIES)**:

   ```
   Text: "This is bold text\nThis is italic text"  ← PLAIN TEXT

   Count from position 0 for EACH entity:
   T(0) h(1) i(2) s(3) SPACE(4) i(5) s(6) SPACE(7) b(8) o(9) l(10) d(11) SPACE(12) t(13) e(14) x(15) t(16) \n(17) T(18) h(19) i(20) s(21) SPACE(22) i(23) s(24) SPACE(25) i(26) t(27) a(28) l(29) i(30) c(31) SPACE(32) t(33) e(34) x(35) t(36)

   For "bold": { type: 'bold', offset: 8, length: 4 }
   For "italic": { type: 'italic', offset: 26, length: 6 }
   ```

4. **CRITICAL: Count from position 0 for EACH entity separately!**
5. **The entities handle ALL formatting** - never mix with markdown!

### Example Rich Message

```typescript
{
  text: "System Alert\n\nStatus: All systems operational\nNote: Maintenance scheduled tonight",
  entities: [
    { type: 'bold', offset: 0, length: 12 },      // "System Alert"
    { type: 'italic', offset: 21, length: 24 },   // "All systems operational"
    { type: 'spoiler', offset: 52, length: 29 }   // "Maintenance scheduled tonight"
  ]
}
```

## Example Use Cases

- **Rich messaging** - "Send a formatted system alert with bold headings and spoiler warnings"
- **API calls** - "Get system status from API"
- **File operations** - "Save this data to file"
- **External services** - "Send email to user@example.com"
- **Calculations** - "Calculate compound interest"
- **Database queries** - "Look up records from database"

## Testing

Run the test file to see tools in action:

```bash
npx tsx app/api/telegram/toolUseTest.ts
```

## Integration

### Basic Integration

To add tools to your existing Telegram bot, replace your `sendToClaudeAndRespond` function calls with `sendToClaudeAndRespondWithTools` from the example file.

### Rich Message Integration

To enable rich Telegram messages in your bot:

1. **Update your tool function** in `tools.ts`:

   ```typescript
   import { sendRichTelegramMessage } from './telegram-rich-message-example'

   // Replace the mock function with real Telegram Bot API call
   send_telegram_message: async (params) => {
     return await sendRichTelegramMessage(yourBotInstance, params)
   }
   ```

2. **Claude will automatically use entities**:
   - Ask: "Send a message with **bold text** and a spoiler"
   - Claude creates: `{ text: "Here's bold text and a secret", entities: [...] }`
   - Your bot sends it with proper Telegram formatting!

### What Claude Can Now Do

- Create **bold**, _italic_, ~~strikethrough~~ text
- Hide sensitive info with ||spoiler tags||
- Add `inline code` and `code blocks`
- Insert [custom links](https://example.com)
- Mention users by ID
- Format technical content beautifully

The tools will automatically be available to Claude in your Telegram conversations!
