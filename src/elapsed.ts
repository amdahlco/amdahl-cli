// src/elapsed.ts
//
// A long wait with a clock: on a terminal's stderr, one line redrawn each second
// ("Researching... 0:07"), so nobody presses Ctrl+C thinking it hung. Nothing
// is drawn when stderr is not a terminal or under `--json`, so a log or a
// script reading stderr never holds the redraws. AMDAHL_TICK_MS sets the
// interval (for tests).

import type { Ctx } from './context'

/** `m:ss` for a number of milliseconds. */
export function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** Run `fn` while `label` and the time passed are redrawn on stderr; the line is cleared when it ends. */
export async function withElapsed<T>(ctx: Ctx, label: string, fn: () => Promise<T>): Promise<T> {
  const { io, out } = ctx
  if (!io.stderrIsTTY || out.json) return fn()
  const tick = Number(io.env.AMDAHL_TICK_MS)
  const started = Date.now()
  const draw = () => io.stderr(`\r${label}... ${clock(Date.now() - started)}`)
  const timer = setInterval(draw, Number.isFinite(tick) && tick > 0 ? tick : 1000)
  timer.unref?.()
  try {
    return await fn()
  } finally {
    clearInterval(timer)
    io.stderr('\r\x1b[K')
  }
}
