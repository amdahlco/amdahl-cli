// src/sequence-ticker.ts
//
// The line `amdahl sequence` redraws each second while a request runs, such as
// `email 2 of 3, 0:41`, so a minute of waiting shows that it is working. Only
// on a terminal's stderr: nothing for a pipe, a file or `--json`.

import type { Io } from './io'

const TICK_MS = 1000

/** `0:41`, `1:05`. */
export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** Start redrawing `label, m:ss` on stderr. The returned function stops it and clears the line. */
export function startTicker(io: Io, label: string): () => void {
  if (!io.stderrIsTTY) return () => {}
  const started = io.now()
  let drawn = false
  const timer = setInterval(() => {
    io.stderr(`\r${label}, ${clock(Math.floor((io.now() - started) / 1000))}\u001b[K`)
    drawn = true
  }, TICK_MS)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    if (drawn) io.stderr('\r\u001b[K')
  }
}
