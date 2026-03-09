import Anthropic from '@anthropic-ai/sdk'
import TelegramBot from 'node-telegram-bot-api'
import { log } from './log'
import { sendToLogChat } from './logChat'

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN || '')

/**
 * If a Telegram message contains a photo (or sticker), download it,
 * describe it with Haiku vision, and mutate message.text to include
 * the description. This lets the rest of the pipeline treat it as text.
 *
 * Returns true if the message was enriched, false otherwise.
 */
export async function enrichMessageWithImageDescription(
  message: TelegramBot.Message,
): Promise<boolean> {
  const photo = message.photo
  const sticker = message.sticker
  if (!photo && !sticker) return false

  try {
    let fileId: string
    if (photo) {
      // Telegram sends multiple sizes — pick the largest
      fileId = photo[photo.length - 1].file_id
    } else {
      // Stickers: use the static thumbnail if available, else the sticker itself
      fileId = (sticker as any).thumbnail?.file_id || sticker!.file_id
    }

    // Get file URL from Telegram
    const file = await bot.getFile(fileId)
    if (!file.file_path) {
      log('image', 'no file_path from Telegram')
      return false
    }

    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`

    // Download as base64
    const response = await fetch(fileUrl)
    if (!response.ok) {
      log('image', 'download failed', { status: response.status })
      return false
    }

    const buffer = await response.arrayBuffer()
    const base64 = Buffer.from(buffer).toString('base64')

    // Determine media type from file path
    const ext = file.file_path.split('.').pop()?.toLowerCase()
    const mediaType = ext === 'png' ? 'image/png'
      : ext === 'webp' ? 'image/webp'
      : ext === 'gif' ? 'image/gif'
      : 'image/jpeg'

    // Describe with Sonnet vision
    const descResponse = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64 },
            },
            {
              type: 'text',
              text: 'Describe this image in detail for context in a group chat. Include: what the image shows, any people or characters, the setting/mood, any text or captions visible in the image (quote them), and if it\'s a meme or joke explain the humor. If it\'s a screenshot, describe what app/site it\'s from and the key content. Be thorough but casual — 2-5 sentences.',
            },
          ],
        },
      ],
    })

    const description =
      descResponse.content[0].type === 'text'
        ? descResponse.content[0].text
        : ''

    if (!description) return false

    // Build enriched text: caption (if any) + image description
    const caption = message.caption || message.text || ''
    const type = sticker ? 'Sticker' : 'Image'
    message.text = caption
      ? `${caption}\n[${type}: ${description}]`
      : `[${type}: ${description}]`

    log('image', `described: "${description.substring(0, 60)}"`)

    const from = message.from?.first_name || message.from?.username || '?'
    sendToLogChat(`🖼 ${type} from ${from}:\n${description}`)

    return true
  } catch (error) {
    log('image', 'describe failed', { error })
    // Fall back to just noting an image was sent
    const caption = message.caption || message.text || ''
    const type = message.sticker ? 'Sticker' : 'Image'
    message.text = caption
      ? `${caption}\n[${type}: could not be described]`
      : `[${type}: could not be described]`
    return false
  }
}
