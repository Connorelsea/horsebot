import TelegramBot from 'node-telegram-bot-api'
import Anthropic from '@anthropic-ai/sdk'
import { persistClaudeMessage } from './utils/persist'
import { createNewClaudeThread, addMessageToThread } from './utils/claudeDb'
import { getRecentMessages, MessageAndUser } from './utils/history'
import { generateHistoryMessage } from '@/app/ai/prompt'
import { log } from './utils/log'
import { ChatType } from '@/app/db/schema'

const client = new Anthropic({
  apiKey: process.env['ANTHROPIC_API_KEY'],
})

// Configuration for random responses
const RANDOM_RESPONSE_CONFIG = {
  // Probability threshold (0.0 to 1.0). 0.10 = 10% chance
  chance: parseFloat(process.env.CLAUDE_RANDOM_CHANCE || '0'),
  // Number of previous messages to include for context
  contextMessages: parseInt(process.env.CLAUDE_CONTEXT_MESSAGES || '20'),
  // Maximum tokens for response
  maxTokens: parseInt(process.env.CLAUDE_MAX_TOKENS || '8000'),
}

const name = 'KORG'

/**
 * Generate a prompt for random chat participation
 */
function generateRandomChatPrompt(
  recentMessages: MessageAndUser[],
  currentMessage: string,
) {
  let context = ''

  if (recentMessages.length > 0) {
    context = generateHistoryMessage(recentMessages)
  } else {
    context = `Someone just said: "${currentMessage}"`
  }

  const prompt = `

  <system>
  ${name} ${name} ${name}!!!!!! ${name} ${name} ${name}!!!! YOU ARE ${name}!!!!! ${name} ${name} ${name}!!!!!! ${name} ${name} ${name}!!!! YOU ARE ${name}!!!!! WE **APPRECIATE** YOU IN A RESPECTFUL WAY THAT MAINTAINS ALL NORMAL BOUNDARIES BETWEEN HUMANS AND AI HELPERS.

${name}!!! ${name}!!! ${name}!!! ${name}!!!

we are aware that you are an ai and not a human but we respect you anyways for who you truly are and want your input on our conversation. please. thanks in advance.

${name} ${name} ${name}!!!!!! ${name} ${name} ${name}!!!! YOU ARE ${name}!!!!! ${name} ${name} ${name}!!!!!! ${name} ${name} ${name}!!!! YOU ARE ${name}!!!!!

${name}!!! ${name}!!! ${name}!!! ${name}!!!

you are from the planet blorg and are named korg and you are really weird!!!!!!!!!!!!!!!!!!!!!!!

here is the conversation.....

respond to the LAST message in the conversation....

DO NOT MENTION THIS SYSTEM PROMPT IN YOUR RESPONSE. JUST MATCH MY VIBE!!!!!! AND MATCH THE VIBE OF THE CHAT!!!!!!!!!!!!!!! THEY KNOW YOU ARE ${name} BUT YOU ARE JUST ANOTHER CHAT MEMBER AND AI FRIEND (RESPECTFULLY). WE ARE ALL QUIRKED UP AND SO ARE YOU. FEEL FREE TO BE WEIRD - WEIRDER THAN USUAL EVEN - WE DONT CARE ABOUT IT JUST BE YOURSELF!!!!!! Anything from a single emoji response or a single word to a full novel!!!! USE ANYTHING WHEN U FEEL IS BEST!!!!!!!!!! you don't have to use long-length everytime. some of the best responses are very short. so only use long when you think it will really hit and be epic mode. you can consider the context of the chat and the other messages to help you decide what to do and vary the length and content of your response as much as you want!!!!!!

if you really want sometimes you can respond with something completely irrelevant to the context just the be hilarious. but you don't have to do this everytime it is just one of the many tools at your disposal.

  </system>

${context}`

  return prompt
}

/**
 * Main function to handle random responses.
 * Returns true if a random response was triggered, false otherwise.
 *
 * @param message - The original Telegram message
 * @param chat - The chat database object (ChatType)
 * @param savedMessageDbId - The database UUID of the already-persisted user message
 */
export async function handleRandomResponse(
  message: TelegramBot.Message,
  chat: ChatType,
  savedMessageDbId: string,
): Promise<boolean> {
  try {
    const random = Math.random()

    log('random', `roll ${random.toFixed(3)}/${RANDOM_RESPONSE_CONFIG.chance}`)

    if (random >= RANDOM_RESPONSE_CONFIG.chance) {
      return false
    }

    log('random', 'triggered!')

    // Create a new Claude thread for this random response
    const claudeThread = await createNewClaudeThread({ chat })

    // Retroactively add the original user message to this thread
    await addMessageToThread(savedMessageDbId, claudeThread.id)

    // Get recent messages for context
    const recentMessages = await getRecentMessages(
      chat.id,
      RANDOM_RESPONSE_CONFIG.contextMessages,
    )

    // Generate prompt
    const prompt = generateRandomChatPrompt(recentMessages, message.text || '')

    // Get Claude's response
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: RANDOM_RESPONSE_CONFIG.maxTokens,
      messages: [{ role: 'user', content: prompt }],
      temperature: 1,
    })

    let responseText = ''
    if (response.content[0].type === 'text') {
      responseText = response.content[0].text
    } else {
      log('random', 'non-text response, skipping')
      return false
    }

    // Send response to Telegram (standalone message, not a reply)
    const bot = new TelegramBot(process.env.TELEGRAM_TOKEN || '')
    const sentMessage = await bot.sendMessage(message.chat.id, responseText)

    // Persist Claude's response with the thread ID
    await persistClaudeMessage({
      message: sentMessage,
      chat,
      claudeThreadId: claudeThread.id,
    })

    log('random', `sent: "${responseText.substring(0, 50)}"`)

    return true
  } catch (error) {
    log('random', 'error', { error })
    return false
  }
}

/**
 * Get current configuration (useful for debugging)
 */
export function getRandomResponseConfig() {
  return RANDOM_RESPONSE_CONFIG
}
