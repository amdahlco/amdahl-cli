// src/commands/setup.ts
//
// Bare `amdahl` (for example `npx amdahl`), also `amdahl setup`: a guided
// setup. In a person's terminal it asks once where Amdahl should work (the
// clients it finds on this machine start ticked and say so), works out how
// to set up each one ticked, signs in through the browser when there is no
// sign-in yet, then sets up each one the way `install <client>` does. It
// says one line per step; `--verbose` adds the files, the profile and the
// notes. When every client it finds is already set up and there is a
// sign-in, it says so and asks nothing.
//
// An agent, or any run without a terminal, gets the same setup with no
// question and no sign-in. When Claude Code or Cursor says it runs the
// command (CLAUDECODE, CURSOR_AGENT), only that client is set up; otherwise
// (Codex sets no variable, a pipe sets none either) every client found on
// the machine. In CI or with AMDAHL_NO_PROMPT=1 nothing is set up: it says
// why and prints the usage (exit 2).
//
// The clients sign in to Amdahl themselves, over OAuth, the first time they
// connect: the server lets a CLI sign-in open an API key request but never
// mint one without a person typing a code in the console, so the setup has
// no key to hand them. The last lines name that one step for each client,
// every run, since whoever runs the setup again because a client "does not
// work" is the one who needs it most.

import { amdahlCommand } from '../command-name'
import { apiClient, call, resolveCredential, type Credential, type Ctx } from '../context'
import { CliError, EXIT } from '../errors'
import type { Io } from '../io'
import { printable } from '../output'
import { browserSignIn, signedInLine } from './auth'
import { detectClients, installClient, isInstalled, preflight, type Client, type Step } from './install'
import { joinNames } from './skills-guide'

/** The clients in the order the setup shows them, with the names a person reads. */
const SHOWN: { client: Client; name: string }[] = [
  { client: 'claude-code', name: 'Claude Code' },
  { client: 'cursor', name: 'Cursor' },
  { client: 'codex', name: 'Codex' },
]

/** The menu's question, tag, note for a machine with none of the clients, and hint. */
export const QUESTION = 'Where should Amdahl work?'
export const FOUND_TAG = 'found on your machine'
export const NONE_FOUND = "We didn't find any of these on this computer. Tick the ones you use."
export const MENU_HINT = '↑↓ move · Space tick/untick · Enter to install'

const ASK = 'say "make this email sound less like AI"'

/**
 * The lines a setup ends with: something to try, then the one step that
 * connects each client set up, on every run. `inClaudeCode` is a run from a
 * Claude Code session, which only sees a new server once restarted.
 */
export function finishLines(names: string[], inClaudeCode = false): string[] {
  const [only] = names
  if (only === undefined) return []
  if (names.length === 1) {
    const step: Record<string, string> = {
      'Claude Code': inClaudeCode
        ? 'Before that, restart Claude Code and run /mcp once to connect Amdahl.'
        : 'Before that, run /mcp once in Claude Code to connect Amdahl.',
      Cursor: 'Before that, sign in when Cursor asks, the first time you use Amdahl.',
      Codex: 'Before that, run `codex mcp login amdahl` once to connect Amdahl.',
    }
    return [`Try it: ${ASK} in ${only}.`, step[only] ?? '']
  }
  const step: Record<string, string> = {
    'Claude Code': inClaudeCode ? 'restart it, then run /mcp' : 'run /mcp',
    Cursor: 'sign in when it asks, on first use',
    Codex: 'run `codex mcp login amdahl`',
  }
  return [`Try it: ${ASK} in any of them.`, 'Before that, connect each one once:', ...names.map((n) => `  ${n}: ${step[n] ?? ''}`)]
}

/** How bare `amdahl` runs here: the menu, the agent setup, or the usage with the reason. */
export type SetupMode = { kind: 'menu' } | { kind: 'agent' } | { kind: 'usage'; reason: string }

/**
 * The menu when stdin, stdout and stderr (the menu draws on stderr) are a
 * terminal and no agent says it runs the command. In CI or with
 * AMDAHL_NO_PROMPT=1, the usage. Anything else (an agent, a pipe, no
 * terminal) is the agent setup. Reads only `io`, so the usage path builds no
 * context.
 */
export function setupMode(io: Io): SetupMode {
  const { env } = io
  if (Boolean(env.CI) && env.CI !== 'false' && env.CI !== '0') return { kind: 'usage', reason: 'CI is set' }
  if (env.AMDAHL_NO_PROMPT === '1') return { kind: 'usage', reason: 'AMDAHL_NO_PROMPT=1 is set' }
  if (env.CLAUDECODE || env.CURSOR_AGENT) return { kind: 'agent' }
  return io.stdinIsTTY && io.stdoutIsTTY && io.stderrIsTTY ? { kind: 'menu' } : { kind: 'agent' }
}

/** The command that sets up one client, for when the setup does not. */
function installLine(): string {
  return `To set up a client, run \`${amdahlCommand('install claude-code')}\` (or cursor, codex).`
}

/** The line before the usage when bare `amdahl` does not set anything up: why, and the command that would. */
export function noSetupLine(reason: string): string {
  return `Setup did not run: ${reason}.\n${installLine()}\n\n`
}

/**
 * Who the credential belongs to. `out` when there is none, or the stored
 * sign-in no longer works. `rejected` when the server refused a key from
 * --api-key or the environment: a browser sign-in would not help, since the
 * key wins over it on every later command.
 */
type SignIn =
  | { kind: 'in'; email: string; workspace: string }
  | { kind: 'out' }
  | { kind: 'rejected'; source: Exclude<Credential['source'], 'profile'> }

async function signIn(ctx: Ctx): Promise<SignIn> {
  let credential: Credential
  try {
    credential = await resolveCredential(ctx)
  } catch (err) {
    if (err instanceof CliError && err.exit === EXIT.unauthenticated) return { kind: 'out' }
    throw err
  }
  try {
    const me = await call(() => apiClient(ctx, credential).cli.whoami())
    return { kind: 'in', email: printable(me.email ?? me.user_id), workspace: printable(me.workspace?.name ?? me.business_id) }
  } catch (err) {
    if (!(err instanceof CliError && err.exit === EXIT.unauthenticated)) throw err
    return credential.source === 'profile' ? { kind: 'out' } : { kind: 'rejected', source: credential.source }
  }
}

/** Print a client's error the way the CLI prints any error. */
function reportError(io: Io, err: CliError): void {
  io.stderr(`Error: ${err.message}\n${err.hint ? `${err.hint}\n` : ''}`)
}

/**
 * Set up each client in turn, one line each. A client that fails prints its
 * error and the rest still run. Returns the names set up and the first
 * failure's exit code.
 */
async function installEach(ctx: Ctx, clients: typeof SHOWN, detail: (text: string) => void): Promise<{ ready: string[]; exit: number }> {
  let exit: number = EXIT.ok
  const ready: string[] = []
  for (const { client, name } of clients) {
    let steps: { mcp: Step; skill: Step }
    try {
      steps = await installClient(ctx, client, false)
    } catch (raw) {
      // Report it and go on to the next client; anything unexpected is that client's failure, not a network error.
      const err = raw instanceof CliError ? raw : new CliError('install_failed', `Could not set up ${name}: ${raw instanceof Error ? raw.message : String(raw)}`, EXIT.general)
      reportError(ctx.io, err)
      if (exit === EXIT.ok) exit = err.exit
      continue
    }
    ctx.io.stdout(`${steps.mcp.data.action === 'unchanged' ? `✓ ${name} already has Amdahl` : `✓ Added to ${name}`}\n`)
    ready.push(name)
    detail([steps.mcp.human, ...steps.mcp.notes, steps.skill.human, ...steps.skill.notes].filter(Boolean).join('\n'))
  }
  return { ready, exit }
}

/** Bare `amdahl`, or `amdahl setup`, in the menu or agent mode. */
export async function setup(ctx: Ctx, mode: 'menu' | 'agent'): Promise<number> {
  const { io, out } = ctx
  const verbose = ctx.flags.verbose === true
  const say = (line: string) => io.stdout(`${line}\n`)
  const detail = (text: string) => {
    if (verbose && text) say(text.replace(/^/gm, '  '))
  }
  const inClaudeCode = Boolean(io.env.CLAUDECODE)
  say(`${out.bold('Amdahl')} · predictive ML for GTM`)

  const found = await detectClients(ctx)
  const detected = SHOWN.filter((c) => found[c.client])

  if (mode === 'agent') {
    // The agent that runs it, when it says so; otherwise every client on the machine.
    const running = SHOWN.filter((c) => (c.client === 'claude-code' && io.env.CLAUDECODE) || (c.client === 'cursor' && io.env.CURSOR_AGENT))
    const targets = running.length > 0 ? running : detected
    if (targets.length === 0) {
      io.stderr(`Didn't find Claude Code, Cursor or Codex on this computer, so nothing changed.\n${installLine()}\n`)
      return EXIT.general
    }
    const { ready, exit } = await installEach(ctx, targets, detail)
    for (const line of finishLines(ready, inClaudeCode)) say(line)
    return exit
  }

  let who: SignIn | undefined
  if (detected.length > 0) {
    const installed = await Promise.all(detected.map((c) => isInstalled(ctx, c.client)))
    if (installed.every(Boolean)) {
      // Every client is set up already; only a missing sign-in is worth a question.
      let unreachable = false
      try {
        who = await signIn(ctx)
      } catch (err) {
        if (!(err instanceof CliError && err.exit === EXIT.network)) throw err
        unreachable = true
      }
      if (unreachable || who?.kind === 'in') {
        say(`You're set up in ${joinNames(detected.map((c) => c.name))}.${unreachable ? ' (Could not reach Amdahl to check your sign-in.)' : ''}`)
        for (const line of finishLines(detected.map((c) => c.name), inClaudeCode)) say(line)
        return EXIT.ok
      }
    }
  }

  const picks = await io.multiSelect(
    QUESTION,
    SHOWN.map((c) => c.name),
    {
      ticked: SHOWN.map((c) => found[c.client]),
      tags: SHOWN.map((c) => (found[c.client] ? FOUND_TAG : undefined)),
      note: detected.length === 0 ? NONE_FOUND : undefined,
      hint: MENU_HINT,
      color: out.color,
    }
  )
  if (picks.length === 0) {
    say('Nothing picked, so nothing changed.')
    return EXIT.ok
  }

  // Work out each pick before the sign-in, so nobody signs in only to hear a client cannot be set up.
  let exit: number = EXIT.ok
  const chosen: typeof SHOWN = []
  for (const pick of picks.flatMap((i) => SHOWN[i] ?? [])) {
    const err = await preflight(ctx, pick.client)
    if (!err) {
      chosen.push(pick)
      continue
    }
    reportError(io, err)
    if (exit === EXIT.ok) exit = err.exit
  }
  if (chosen.length === 0) return exit

  who ??= await signIn(ctx)
  if (who.kind === 'in') {
    say(`✓ Signed in · ${who.workspace}`)
    detail(`Signed in as ${who.email}.`)
  } else if (who.kind === 'out') {
    const signedIn = await browserSignIn(ctx)
    say(`✓ Signed in · ${printable(signedIn.workspace.name)}`)
    detail(signedInLine(ctx, signedIn))
  } else {
    const name = who.source === 'flag' ? '--api-key' : who.source.slice('env:'.length)
    out.info(`Amdahl rejected the key in ${name}. Skipping the browser sign-in, because that key would still be used instead. Fix it, or unset it and run \`${amdahlCommand('login')}\`.`)
  }

  const done = await installEach(ctx, chosen, detail)
  for (const line of finishLines(done.ready, inClaudeCode)) say(line)
  return exit === EXIT.ok ? done.exit : exit
}
