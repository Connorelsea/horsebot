# Claude Bot Message Flow Diagram

This diagram illustrates how messages are processed by the Claude Telegram bot, including the new random participation feature.

```mermaid
flowchart TD
    A["📱 Message Received"] --> B{"Has Claude Identifier?"}

    B -->|Yes| C["🎯 Direct Claude Message"]
    B -->|No| D{"Is Reply?"}

    D -->|Yes| E{"Original has Claude Thread?"}
    D -->|No| F["💬 Regular Message"]

    E -->|Yes| G["🔄 Continue Thread"]
    E -->|No| H{"Reply has Claude Identifier?"}

    H -->|Yes| I["🔗 Create Retroactive Thread"]
        H -->|No| J["💾 Store Regular Reply"]

    F --> K["💾 Store Message"]
    K --> L["🎲 Random Check"]
    L --> M{"Random < 5%?"}

    J --> L

    M -->|Yes| N["📚 Get Recent Context"]
    M -->|No| O["✅ Done"]

    N --> P["🆕 Create Claude Thread"]
    P --> Q["🔗 Link Original Message"]
    Q --> R["🤖 Generate Random Response"]
    R --> S["💬 Send Natural Response"]
    S --> T["💾 Store Response (With Thread)"]
    T --> O

        C --> U["🆕 Create New Thread"]
    U --> V["🤖 Process with Claude"]
    V --> W["💬 Send Response"]
    W --> X["💾 Store with Thread ID"]
    X --> O

    G --> Y["📖 Build History"]
    Y --> V

    I --> Z["🔗 Link Original Message"]
    Z --> Y

    style C fill:#e1f5fe
    style F fill:#f3e5f5
    style L fill:#fff3e0
    style P fill:#e8f5e8
    style R fill:#e8f5e8
    style V fill:#e3f2fd
```

## Flow Explanation

### Main Entry Points

- **📱 Message Received**: All incoming Telegram messages start here
- **🎯 Direct Claude Message**: Messages that explicitly mention Claude
- **💬 Regular Message**: Normal chat messages without Claude identifiers

### Decision Points

- **Has Claude Identifier?**: Checks for "claude", "hey claude", etc.
- **Is Reply?**: Determines if the message is replying to another message
- **Original has Claude Thread?**: Checks if the replied-to message is part of a Claude conversation
- **Random < 5%?**: Random number generation for spontaneous Claude participation

### Key Features

1. **Threaded Conversations**: Formal Claude conversations with full history
2. **Retroactive Threading**: Smart linking of existing messages to new Claude threads
3. **Random Participation**: Claude spontaneously joins regular conversations AND replies (5% chance)
4. **Random Response Threading**: Random responses automatically create Claude threads for follow-up conversations
5. **Context Awareness**: Uses recent message history for natural responses

### Color Coding

- 🔵 **Blue (Direct Claude)**: Formal Claude conversations with threading
- 🟣 **Purple (Regular Messages)**: Normal chat messages
- 🟠 **Orange (Random Check)**: Random participation decision point
- 🟢 **Green (Random Response)**: Spontaneous Claude participation
- 🔵 **Light Blue (Processing)**: Claude API processing and response generation

This system enables Claude to participate naturally in group conversations while maintaining organized threaded discussions when explicitly invoked.
