#!/usr/bin/env tsx

/**
 * Setup script for Claude user in database
 *
 * This script creates the special Claude user that represents the AI assistant
 * in your database. Run this once after setting up your database.
 *
 * Usage:
 *   npx tsx app/api/telegram/setup-claude.ts
 *
 * Or add to package.json scripts:
 *   "setup-claude": "tsx app/api/telegram/setup-claude.ts"
 */

import 'dotenv/config'
import { setupClaudeUser } from './utils'

async function main() {
  console.log('🤖 Claude User Setup Script')
  console.log('============================')
  console.log('')

  console.log('This script will create a special Claude user in your database.')
  console.log('The Claude user has Telegram ID 0 (which no real user can have)')
  console.log(
    "and is used to store Claude's responses in conversation threads.",
  )
  console.log('')

  const result = await setupClaudeUser()

  if (result) {
    console.log('')
    console.log(
      '🎉 Setup complete! Your bot is ready to handle Claude conversations.',
    )
    console.log('')
    console.log('Next steps:')
    console.log('1. Deploy your webhook endpoint')
    console.log('2. Set up your Telegram webhook (see README.md)')
    console.log('3. Start chatting with Claude in your Telegram chat!')
    console.log('')
    console.log('Try these commands in Telegram:')
    console.log('  "hey claude, what\'s the weather?"')
    console.log('  "claude, explain quantum computing"')
    console.log('  "dear claude, help me debug this code"')
  } else {
    console.log('')
    console.log(
      '❌ Setup failed. Please check your database connection and try again.',
    )
    console.log('')
    console.log('Common issues:')
    console.log('- Database not running')
    console.log('- Missing environment variables')
    console.log('- Database migration not run')
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('❌ Setup script failed:', error)
  process.exit(1)
})
