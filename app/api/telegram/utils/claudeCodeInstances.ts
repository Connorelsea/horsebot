import { spawn, execSync } from 'child_process'
import fs from 'fs/promises'
import { realpathSync } from 'fs'
import path from 'path'
import os from 'os'
import { log } from './log'

// Find claude command path once at module load and resolve symlinks
let CLAUDE_PATH: string
try {
  const whichPath = execSync('which claude', { encoding: 'utf8' }).trim()
  // Resolve symlinks to get the actual executable
  CLAUDE_PATH = realpathSync(whichPath)
  log('claude-code', `path: ${CLAUDE_PATH}`)
} catch (_error) {
  // Fallback to common locations if which fails
  CLAUDE_PATH = '/usr/local/bin/claude'
  log('claude-code', `fallback path: ${CLAUDE_PATH}`)
}

const INSTANCES_FILE = path.join(process.cwd(), 'claude-code-instances.json')
const OUTPUT_DIR = path.join(process.cwd(), 'claude-code-outputs')

/**
 * Expand tilde (~) in paths to the user's home directory
 * Also fixes incorrectly expanded paths when Claude AI guesses the home directory
 */
function expandTilde(filepath: string): string {
  if (filepath.startsWith('~/')) {
    return path.join(os.homedir(), filepath.slice(2))
  }
  if (filepath === '~') {
    return os.homedir()
  }

  // Fix paths that were incorrectly expanded to /home/<username>/ (Linux-style)
  // Match /home/<anything>/ and replace with actual home directory
  const homeMatch = filepath.match(/^\/home\/[^/]+\/(.*)$/)
  if (homeMatch) {
    return path.join(os.homedir(), homeMatch[1])
  }

  // Fix paths that use incorrect macOS home directory /Users/<username>/
  // Match /Users/<anything>/ and replace with actual home directory
  const usersMatch = filepath.match(/^\/Users\/[^/]+\/(.*)$/)
  if (usersMatch) {
    const actualHome = os.homedir()
    // Only fix if the path doesn't match the actual home directory
    if (!filepath.startsWith(actualHome)) {
      return path.join(actualHome, usersMatch[1])
    }
  }

  return filepath
}

export type ClaudeCodeInstance = {
  id: number
  directory: string
  input: string
  pid: number | null
  status: 'running' | 'completed' | 'error'
  output: string
  error: string
  createdAt: string
  completedAt: string | null
}

type InstancesData = {
  nextId: number
  instances: Record<number, ClaudeCodeInstance>
}

/**
 * Read instances from file
 */
async function readInstances(): Promise<InstancesData> {
  try {
    const data = await fs.readFile(INSTANCES_FILE, 'utf-8')
    return JSON.parse(data)
  } catch (_error) {
    // File doesn't exist yet, return empty
    return { nextId: 1, instances: {} }
  }
}

/**
 * Write instances to file
 */
async function writeInstances(data: InstancesData): Promise<void> {
  await fs.writeFile(INSTANCES_FILE, JSON.stringify(data, null, 2))
}

/**
 * Ensure output directory exists
 */
async function ensureOutputDir(): Promise<void> {
  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true })
  } catch (error) {
    log('claude-code', 'output dir error', { error })
  }
}

/**
 * Spawn a new Claude Code instance
 * @param directory - Working directory for Claude Code
 * @param input - Input prompt/message for Claude Code
 * @returns Instance ID and initial info
 */
export async function spawnClaudeCodeInstance(
  directory: string,
  input: string,
): Promise<{ id: number; instance: ClaudeCodeInstance }> {
  await ensureOutputDir()

  // Expand tilde in directory path
  const expandedDirectory = expandTilde(directory)

  const data = await readInstances()
  const id = data.nextId
  data.nextId++

  const outputFile = path.join(OUTPUT_DIR, `instance-${id}.txt`)
  const errorFile = path.join(OUTPUT_DIR, `instance-${id}-error.txt`)

  log('claude-code', `spawn #${id} in ${expandedDirectory}`, {
    id,
    directory: expandedDirectory,
    input: input.substring(0, 100),
  })

  // Create instance record
  const instance: ClaudeCodeInstance = {
    id,
    directory: expandedDirectory,
    input,
    pid: null,
    status: 'running',
    output: '',
    error: '',
    createdAt: new Date().toISOString(),
    completedAt: null,
  }

  // Spawn detached Claude Code process
  try {
    const outputStream = await fs.open(outputFile, 'w')
    const errorStream = await fs.open(errorFile, 'w')

    const child = spawn(CLAUDE_PATH, ['--dangerously-skip-permissions', input], {
      cwd: expandedDirectory,
      detached: true,
      stdio: ['ignore', outputStream.fd, errorStream.fd],
    })

    instance.pid = child.pid || null

    // Close file handles after spawn to prevent garbage collection errors
    await outputStream.close()
    await errorStream.close()

    // Detach the process so it continues after parent exits
    child.unref()

    log('claude-code', `spawned #${id} pid=${child.pid}`)

    // Update status asynchronously when process completes (won't block API route)
    child.on('close', async (code) => {
      try {
        const currentData = await readInstances()
        if (currentData.instances[id]) {
          currentData.instances[id].status = code === 0 ? 'completed' : 'error'
          currentData.instances[id].completedAt = new Date().toISOString()
          await writeInstances(currentData)
        }
      } catch (error) {
        log('claude-code', 'status update error', { error })
      }
    })

    // Handle spawn errors
    child.on('error', async (error) => {
      log('claude-code', `spawn error #${id}`, { error })
      try {
        const currentData = await readInstances()
        if (currentData.instances[id]) {
          currentData.instances[id].status = 'error'
          currentData.instances[id].error = error.message
          currentData.instances[id].completedAt = new Date().toISOString()
          await writeInstances(currentData)
        }
      } catch (updateError) {
        log('claude-code', 'error update failed', { error: updateError })
      }
    })
  } catch (error) {
    log('claude-code', 'spawn catch error', { error })
    instance.status = 'error'
    instance.error = error instanceof Error ? error.message : 'Unknown error'
  }

  // Save instance
  data.instances[id] = instance
  await writeInstances(data)

  return { id, instance }
}

/**
 * Get status and output of a Claude Code instance
 * @param id - Instance ID
 * @returns Instance info with current output
 */
export async function getClaudeCodeInstance(
  id: number,
): Promise<ClaudeCodeInstance | null> {
  const data = await readInstances()
  const instance = data.instances[id]

  if (!instance) {
    return null
  }

  // Read latest output from files
  const outputFile = path.join(OUTPUT_DIR, `instance-${id}.txt`)
  const errorFile = path.join(OUTPUT_DIR, `instance-${id}-error.txt`)

  try {
    const output = await fs.readFile(outputFile, 'utf-8')
    instance.output = output
  } catch (_error) {
    // Output file might not exist yet
    instance.output = ''
  }

  try {
    const errorOutput = await fs.readFile(errorFile, 'utf-8')
    instance.error = errorOutput
  } catch (_error) {
    // Error file might not exist yet
    instance.error = ''
  }

  return instance
}

/**
 * List all instances
 */
export async function listClaudeCodeInstances(): Promise<ClaudeCodeInstance[]> {
  const data = await readInstances()
  return Object.values(data.instances)
}

/**
 * Kill a running instance
 */
export async function killClaudeCodeInstance(id: number): Promise<boolean> {
  const data = await readInstances()
  const instance = data.instances[id]

  if (!instance || !instance.pid) {
    return false
  }

  try {
    process.kill(instance.pid, 'SIGTERM')
    instance.status = 'error'
    instance.error = 'Killed by user'
    instance.completedAt = new Date().toISOString()
    await writeInstances(data)
    return true
  } catch (error) {
    log('claude-code', 'kill error', { error })
    return false
  }
}
