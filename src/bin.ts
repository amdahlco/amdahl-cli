// src/bin.ts
//
// The `amdahl` executable. Everything lives in runCli; this only binds it to
// the real process.

import { realIo } from './io'
import { runCli } from './main'

runCli(process.argv.slice(2), realIo()).then(
  (code) => {
    process.exitCode = code
    // A request still in flight when the person pressed Ctrl+C must not keep the process alive.
    if (code === 130) setTimeout(() => process.exit(code), 200).unref()
  },
  (err: unknown) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  }
)
