// src/bin.ts
//
// The `amdahl` executable. Everything lives in runCli; this only binds it to
// the real process.

import { realIo } from './io'
import { runCli } from './main'

runCli(process.argv.slice(2), realIo()).then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  }
)
