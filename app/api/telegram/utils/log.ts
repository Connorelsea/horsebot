import fs from 'fs'
import path from 'path'

const LOGS_DIR = path.join(process.cwd(), 'logs')

function localDateString(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function getLogFilePath(): string {
  return path.join(LOGS_DIR, `log_${localDateString()}.txt`)
}

function timestamp(): string {
  const now = new Date()
  const h = String(now.getHours()).padStart(2, '0')
  const m = String(now.getMinutes()).padStart(2, '0')
  const s = String(now.getSeconds()).padStart(2, '0')
  const ms = String(now.getMilliseconds()).padStart(3, '0')
  return `${h}:${m}:${s}.${ms}`
}

function serialize(params: { [key: string]: any }): string {
  try {
    return JSON.stringify(params, (_key, value) => {
      if (value instanceof Error) {
        return { message: value.message, stack: value.stack }
      }
      return value
    })
  } catch {
    return String(params)
  }
}

function writeToFile(line: string) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.appendFileSync(getLogFilePath(), line + '\n')
  } catch {
    // Silent fail — don't let logging break the app
  }
}

/**
 * Write to log file only (no console output).
 * Use for verbose debug data you only want when tailing the file.
 */
export const logVerbose = (
  prefix: string,
  message: string,
  body?: string,
) => {
  const ts = timestamp()
  const tag = `[${prefix}]`
  let line = `[${ts}] ${tag} ${message}`
  if (body) {
    line += '\n' + body + '\n---'
  }
  writeToFile(line)
}

/**
 * Log with two outputs:
 * - Console: concise `[prefix] message`
 * - File: verbose `[HH:MM:SS.mmm] [prefix] message { params }`
 */
export const log = (
  prefix: string,
  message: string,
  params: { [key: string]: any } = {},
) => {
  // Console: clean, short
  const tag = `[${prefix}]`
  const hasParams = Object.keys(params).length > 0

  if (hasParams) {
    // Only show params on console for errors
    const isError = 'error' in params
    if (isError) {
      const errMsg =
        params.error instanceof Error
          ? params.error.message
          : String(params.error)
      console.log(`${tag} ${message} — ${errMsg}`)
    } else {
      console.log(`${tag} ${message}`)
    }
  } else {
    console.log(`${tag} ${message}`)
  }

  // File: verbose with timestamp and full params
  const ts = timestamp()
  const verbose = hasParams
    ? `[${ts}] ${tag} ${message} ${serialize(params)}`
    : `[${ts}] ${tag} ${message}`
  writeToFile(verbose)
}
