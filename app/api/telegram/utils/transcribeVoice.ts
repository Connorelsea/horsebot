import Groq from 'groq-sdk'
import TelegramBot from 'node-telegram-bot-api'
import { log } from './log'
import { sendToLogChat } from './logChat'

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN || '')

/**
 * If a Telegram message contains a voice message or audio file,
 * download it, transcribe with Groq Whisper, and mutate message.text
 * to include the transcription.
 *
 * Returns true if the message was enriched, false otherwise.
 */
export async function enrichMessageWithVoiceTranscription(
  message: TelegramBot.Message,
): Promise<boolean> {
  const voice = message.voice
  const audio = message.audio
  const videoNote = (message as any).video_note
  if (!voice && !audio && !videoNote) return false

  if (!process.env.GROQ_API_KEY) {
    log('voice', 'GROQ_API_KEY not set, skipping transcription')
    const caption = message.caption || message.text || ''
    const type = videoNote ? 'Video note' : 'Voice message'
    message.text = caption
      ? `${caption}\n[${type}: not transcribed]`
      : `[${type}: not transcribed]`
    return false
  }

  try {
    const fileId = voice?.file_id || audio?.file_id || videoNote?.file_id
    if (!fileId) return false

    // Get file URL from Telegram
    const file = await bot.getFile(fileId)
    if (!file.file_path) {
      log('voice', 'no file_path from Telegram')
      return false
    }

    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`

    // Download the audio
    const response = await fetch(fileUrl)
    if (!response.ok) {
      log('voice', 'download failed', { status: response.status })
      return false
    }

    const buffer = await response.arrayBuffer()

    // Map Telegram file extensions to Groq-accepted formats
    const rawExt = file.file_path.split('.').pop()?.toLowerCase() || 'ogg'
    const extMap: Record<string, string> = { oga: 'ogg', ogx: 'ogg' }
    const ext = extMap[rawExt] || rawExt
    const filename = `voice.${ext}`

    log('voice', `downloading ${file.file_path} (${rawExt}→${ext}, ${buffer.byteLength} bytes)`)

    // Transcribe with Groq Whisper
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
    const transcription = await groq.audio.transcriptions.create({
      file: new File([buffer], filename, { type: `audio/${ext}` }),
      model: 'whisper-large-v3',
      language: 'en',
    })

    const text = transcription.text?.trim()
    if (!text) {
      log('voice', 'empty transcription')
      return false
    }

    // Build enriched text
    const caption = message.caption || message.text || ''
    const duration = voice?.duration || audio?.duration || videoNote?.duration
    const durationTag = duration ? ` ${duration}s` : ''
    const type = videoNote ? 'Video note' : 'Voice'
    message.text = caption
      ? `${caption}\n[${type}${durationTag}: "${text}"]`
      : `[${type}${durationTag}: "${text}"]`

    log('voice', `transcribed (${duration}s): "${text.substring(0, 60)}"`)

    const from = message.from?.first_name || message.from?.username || '?'
    sendToLogChat(`🎙 ${type} from ${from} (${duration}s):\n"${text}"`)

    // Send transcription to the source chat so everyone can read it
    const chatId = message.chat.id
    bot.sendMessage(chatId, `🎤 ${from}: "${text}"`, {
      reply_to_message_id: message.message_id,
    }).catch((err) => log('voice', 'source chat send failed', { error: err }))

    return true
  } catch (error) {
    log('voice', 'transcription failed', { error })
    const caption = message.caption || message.text || ''
    const type = (message as any).video_note ? 'Video note' : 'Voice message'
    message.text = caption
      ? `${caption}\n[${type}: transcription failed]`
      : `[${type}: transcription failed]`
    return false
  }
}
