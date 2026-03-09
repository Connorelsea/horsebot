import { MessageHandlerInput } from './types'
import { log } from '../utils/log'
import { persistMessage } from '../utils/persist'
import { handleRandomResponse } from '../randomResponse'

const handleNewChatMessage = async (input: MessageHandlerInput) => {
  const { message, user, chat } = input

  log('chat', `${user.firstName}: "${(message.text || '').substring(0, 40)}"`, {
    from: user.firstName,
    chat: chat.title || 'DM',
    text: message.text?.substring(0, 50),
  })

  // Persist the regular message (no thread) so it shows up in context history
  const savedMessage = await persistMessage({ message, chat, user })

  // Roll the dice for a random response
  await handleRandomResponse(message, chat, savedMessage.id)
}

export default handleNewChatMessage
