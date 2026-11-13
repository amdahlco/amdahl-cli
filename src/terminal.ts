// src/terminal.ts
//
// Whether a person is at a terminal, for what only a person should get: a
// browser opened for them, or a next step asked of the server for them. An
// agent, a pipe, CI and AMDAHL_NO_PROMPT=1 are not a person, and `--json` is
// a script reading data. {@link atTerminal} is the test `amdahl optimize`
// applies before it asks for a paste; {@link canOpenBrowser} adds stdout.

import { ciVariable } from './ci'
import { runningAgent } from './commands/skills-guide'
import type { Ctx } from './context'

/**
 * True when stdin is a terminal, prompts are allowed, no agent says it runs
 * the command (CLAUDECODE, CURSOR_AGENT) and this is not CI.
 */
export function atTerminal(ctx: Ctx): boolean {
  return ctx.io.stdinIsTTY && !ctx.nonInteractive && runningAgent(ctx) === null && !ciVariable(ctx.io.env)
}

/**
 * True when a person can be asked and shown a question: {@link atTerminal}, stdout a terminal and no
 * `--json`. `sent` and `feedback` ask for what is missing exactly when this holds.
 */
export function canAsk(ctx: Ctx): boolean {
  return atTerminal(ctx) && ctx.io.stdoutIsTTY && !ctx.out.json
}

/**
 * True when {@link atTerminal} and stdout is a terminal too: `amdahl connect |
 * cat` is a script reading the link, and opens no browser.
 */
export function canOpenBrowser(ctx: Ctx): boolean {
  return atTerminal(ctx) && ctx.io.stdoutIsTTY
}
