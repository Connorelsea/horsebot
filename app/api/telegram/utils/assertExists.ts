import { eq } from 'drizzle-orm'
import { chats, users, UserType } from '../../../db/schema'
import TelegramBot from 'node-telegram-bot-api'
import db from '../../../db'


export async function assertChatExistsOrCreate(message: TelegramBot.Message) {
  const chatId = message.chat.id
  const title = message.chat.title
  const username = message.chat.username
  const firstName = message.chat.first_name
  const lastName = message.chat.last_name

  const chat = await db.query.chats.findFirst({
    where: eq(chats.chatId, chatId),
  })

  if (!chat) {
    const newChat = await db
      .insert(chats)
      .values({ chatId, title, username, firstName, lastName })
      .returning()
    return newChat[0]
  }

  return chat
}

export async function assertUserExistsOrCreate(
  user: TelegramBot.User,
): Promise<UserType> {
  // Insert the user if they don't already exist, and update their names if they do exist
  const newUser = await db
    .insert(users)
    .values({
      telegramId: user.id,
      username: user.username,
      firstName: user.first_name,
    })
    .onConflictDoUpdate({
      target: users.telegramId,
      set: {
        username: user.username,
        firstName: user.first_name,
      },
    })
    .returning()

  return newUser[0] as UserType
}
