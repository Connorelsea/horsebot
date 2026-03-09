// Survive hot reloads in dev (same pattern as debounce)
const g = globalThis as typeof globalThis & { __botPaused?: boolean }
if (g.__botPaused === undefined) g.__botPaused = false

export function isPaused(): boolean {
  return g.__botPaused!
}

export function setPaused(paused: boolean): void {
  g.__botPaused = paused
}
