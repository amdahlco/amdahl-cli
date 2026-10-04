// src/output.ts
//
// How commands talk. With `--json`, DATA goes to stdout as one JSON document
// and every message goes to stderr, so `amdahl ... --json | jq` always parses.
// Machine events the e2e harness reads (`open_url`, `approve`) are single JSON
// lines on stderr.

import type { Io } from './io'

/** Writers bound to one invocation's flags. */
export interface Output {
  /** True under `--json`. */
  json: boolean
  /** Print the command's result: JSON on stdout, or the human lines. */
  result: (data: Record<string, unknown> | Record<string, unknown>[], human?: string) => void
  /** Print a message to stderr (never stdout). */
  info: (text: string) => void
  /** Print a machine event as one JSON line on stderr (only under `--json`). */
  event: (data: Record<string, unknown>) => void
  /** Bold text when colour is allowed. */
  bold: (text: string) => string
}

/**
 * Build the writers.
 *
 * @param io - the process boundary.
 * @param json - whether `--json` was passed.
 * @param noColor - whether `--no-color` was passed.
 */
export function createOutput(io: Io, json: boolean, noColor: boolean): Output {
  const color = !noColor && !io.env.NO_COLOR && io.stderrIsTTY && !json
  return {
    json,
    result(data, human) {
      if (json) {
        io.stdout(`${JSON.stringify(data)}\n`)
      } else if (human !== undefined) {
        io.stdout(human.endsWith('\n') ? human : `${human}\n`)
      }
    },
    info(text) {
      io.stderr(text.endsWith('\n') ? text : `${text}\n`)
    },
    event(data) {
      if (json) io.stderr(`${JSON.stringify(data)}\n`)
    },
    bold(text) {
      return color ? `\u001b[1m${text}\u001b[22m` : text
    },
  }
}
