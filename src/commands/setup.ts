// src/commands/setup.ts
//
// Bare `amdahl` (for example `npx amdahl`), also `amdahl setup`: a guided
// setup. In a person's terminal it asks once where Amdahl should work:
// Claude Code, Cursor, Codex (the ones it finds on this machine start ticked
// and say so) or this terminal. The AI tools are set up first, with no
// sign-in here: each signs in to Amdahl itself, over OAuth, the first time it
// connects (the server lets a CLI sign-in open an API key request but never
// mint one, so the setup has no key to hand them). Each then gets its numbered
// next steps; Codex, which runs in this same terminal, can sign in right away.
// "This terminal" signs in through the browser, asks for a message to be
// pasted and shows Amdahl's version of it. When every tool it finds already
// points at Amdahl, it says so and asks nothing.
//
// An agent, or any run without a terminal, gets the tools set up with no
// question and no sign-in. When Claude Code or Cursor says it runs the
// command (CLAUDECODE, CURSOR_AGENT), only that client is set up; otherwise
// (Codex sets no variable, a pipe sets none either) every client found on
// the machine. In CI or with AMDAHL_NO_PROMPT=1 nothing is set up: it says
// why and prints the usage (exit 2).

import { ciVariable } from '../ci'
import { amdahlCommand } from '../command-name'
import { apiClient, call, resolveCredential, type Credential, type Ctx } from '../context'
import { CliError, EXIT } from '../errors'
import { PromptCancelled, type Io } from '../io'
import { printable } from '../output'
import { browserSignIn, signedInLine } from './auth'
import { detectClients, hasAmdahl, installClient, isInstalled, onPath, preflight, type Client, type Step } from './install'
import { NEW_USER, optimizePasted } from './optimize'
import { joinNames } from './skills-guide'

export { NEW_USER }

/** An AI tool the setup can set up, with the name a person reads. */
interface Tool {
  client: Client
  name: string
}

/** The tools in the order the setup shows them. Codex is last: it may wait for Enter. */
const SHOWN: Tool[] = [
  { client: 'claude-code', name: 'Claude Code' },
  { client: 'cursor', name: 'Cursor' },
  { client: 'codex', name: 'Codex' },
]

/** The menu's question, last row, tag, note for a machine with none of the tools, and hint. */
export const QUESTION = 'Where should Amdahl work?'
export const TERMINAL = 'This terminal'
export const FOUND_TAG = 'found on your machine'
export const CONNECT_URL = 'https://amdahl.ai/connect'
export const NONE_FOUND = `We didn't find Claude Code, Cursor or Codex on this computer.\nUsing the Claude or ChatGPT app? Connect it at ${CONNECT_URL}`
export const MENU_HINT = '↑↓ move · Space tick/untick · Enter continue'

/** What to say to the AI tool, naming Amdahl: a plain "make this better" does not call it. */
export const ASK = '"Use Amdahl to make this sound less like AI"'

/** How each tool signs in to Amdahl, as one step. */
const SIGN_IN: Record<string, string> = {
  'Claude Code': "If it's open, quit and reopen it. Type /mcp, pick amdahl, sign in.",
  // Cursor reads ~/.cursor/mcp.json at start, and lists its MCP servers under Customize > MCPs.
  Cursor: "If it's open, quit and reopen it. In Customize > MCPs, sign in to amdahl.",
}

/** Where to try Amdahl in each tool, as a numbered step (each fits 80 columns). */
const TRY_IN: Record<string, string> = {
  'Claude Code': `Paste an email and say: ${ASK}`,
  Cursor: `In chat, paste an email, say: ${ASK}`,
  Codex: `In codex, paste an email, say: ${ASK}`,
}
/** Codex's last line once it is signed in, or the sign-in was skipped. */
const CODEX_TRY = `Run codex, paste an email and say: ${ASK}`

const CODEX_LOGIN = 'codex mcp login amdahl'

/**
 * Claude Code's or Cursor's screen after the setup: what it did, then the
 * numbered steps left, in that tool.
 */
export function toolScreen(name: string, already: boolean): string[] {
  return [
    already ? `✓ ${name} already has Amdahl.` : `✓ Added Amdahl to ${name}.`,
    `One step left, in ${name}:`,
    `  1. ${SIGN_IN[name] ?? ''}`,
    `  2. ${TRY_IN[name] ?? ''}`,
  ]
}

/** What a re-run says when every tool it finds already points at Amdahl. */
export function allSetLines(names: string[]): string[] {
  const [only] = names
  if (only === undefined) return []
  const tryHere = `Want to try it here instead? Run: ${amdahlCommand('optimize')}`
  if (names.length === 1) {
    const done: Record<string, [string, string]> = {
      'Claude Code': ["If you've already run /mcp, you're done.", 'If not: quit and reopen Claude Code, type /mcp, pick amdahl, sign in.'],
      Cursor: ["If you've already signed in under Customize > MCPs, you're done.", 'If not: quit and reopen Cursor, then sign in to amdahl there.'],
      Codex: [`If you've already run ${CODEX_LOGIN}, you're done.`, `If not, run it now in this terminal.`],
    }
    return [`Amdahl is in ${only}. You're all set.`, `Paste an email there and say: ${ASK}`, ...(done[only] ?? []), tryHere]
  }
  const step: Record<string, string> = {
    'Claude Code': 'quit and reopen it, type /mcp, pick amdahl, sign in',
    Cursor: 'quit and reopen it, then in Customize > MCPs, sign in to amdahl',
    Codex: `run ${CODEX_LOGIN}`,
  }
  return [
    `Amdahl is in ${joinNames(names)}. You're all set.`,
    `Paste an email in ${names.length === 2 ? 'either' : 'any of them'} and say: ${ASK}`,
    "If you've already signed each one in, you're done. If not:",
    ...names.map((n) => `  ${n}: ${step[n] ?? ''}`),
    tryHere,
  ]
}

/** What an empty pick says: how to try Amdahl after all. */
export function nothingPickedLines(): string[] {
  return [
    'Nothing picked, so nothing changed.',
    `To try it here, run ${amdahlCommand()} again and tick "${TERMINAL}".`,
    `Using the Claude or ChatGPT app? Connect it at ${CONNECT_URL}`,
  ]
}

/**
 * `line` broken at spaces to fit `columns`, for a terminal narrower than the
 * screens: the lines after the first start under the text of a numbered step.
 */
export function wrapLine(line: string, columns: number | undefined): string[] {
  if (!columns || [...line].length <= columns) return [line]
  const lead = /^\s*(?:\d+\.\s+)?/.exec(line)?.[0] ?? ''
  const indent = ' '.repeat(lead.length)
  const lines: string[] = []
  let current = lead
  let words = 0
  for (const word of line.slice(lead.length).split(' ')) {
    if (words > 0 && [...`${current} ${word}`].length > columns) {
      lines.push(current)
      current = indent + word
    } else current = words > 0 ? `${current} ${word}` : current + word
    words++
  }
  lines.push(current)
  return lines
}

const AGENT_ASK = `paste an email and say ${ASK}`

/**
 * The lines a setup run by an agent ends with: something to try, then the one
 * step that connects each client set up, on every run. `inClaudeCode` is a
 * run from a Claude Code session, which only sees a new server once restarted.
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
      Codex: `Before that, run \`${CODEX_LOGIN}\` once to connect Amdahl.`,
    }
    return [`Try it: ${AGENT_ASK} in ${only}.`, step[only] ?? '']
  }
  const step: Record<string, string> = {
    'Claude Code': inClaudeCode ? 'restart it, then run /mcp' : 'run /mcp',
    Cursor: 'sign in when it asks, on first use',
    Codex: `run \`${CODEX_LOGIN}\``,
  }
  return [`Try it: ${AGENT_ASK} in any of them.`, 'Before that, connect each one once:', ...names.map((n) => `  ${n}: ${step[n] ?? ''}`)]
}

/** How bare `amdahl` runs here: the menu, the agent setup, or the usage with the reason. */
export type SetupMode = { kind: 'menu' } | { kind: 'agent' } | { kind: 'usage'; reason: string }

/**
 * The menu when stdin, stdout and stderr (the menu draws on stderr) are a
 * terminal and no agent says it runs the command. In CI (see
 * {@link ciVariable}) or with AMDAHL_NO_PROMPT=1, the usage. Anything else (an agent, a pipe, no
 * terminal) is the agent setup. Reads only `io`, so the usage path builds no
 * context.
 */
export function setupMode(io: Io): SetupMode {
  const { env } = io
  const ci = ciVariable(env)
  if (ci) return { kind: 'usage', reason: `${ci} is set` }
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

/** One tool set up: whether it already pointed at Amdahl, and what the install said (for --verbose). */
interface Ready extends Tool {
  already: boolean
  detail: string
}

/**
 * Set up each tool in turn, printing nothing but failures: a tool that fails
 * prints its error and the rest still run. Returns the tools set up and the
 * first failure's exit code.
 */
async function installEach(ctx: Ctx, tools: Tool[]): Promise<{ ready: Ready[]; exit: number }> {
  let exit: number = EXIT.ok
  const ready: Ready[] = []
  for (const tool of tools) {
    let steps: { mcp: Step; skill: Step }
    try {
      steps = await installClient(ctx, tool.client, false)
    } catch (raw) {
      // Report it and go on to the next tool; anything unexpected is that tool's failure, not a network error.
      const err = raw instanceof CliError ? raw : new CliError('install_failed', `Could not set up ${tool.name}: ${raw instanceof Error ? raw.message : String(raw)}`, EXIT.general)
      reportError(ctx.io, err)
      if (exit === EXIT.ok) exit = err.exit
      continue
    }
    const detail = [steps.mcp.human, ...steps.mcp.notes, steps.skill.human, ...steps.skill.notes].filter(Boolean).join('\n')
    ready.push({ ...tool, already: steps.mcp.data.action === 'unchanged', detail })
  }
  return { ready, exit }
}

/** Wait for Enter (true) or Ctrl+C (false) on the terminal. */
function enterOrSkip(io: Io): Promise<boolean> {
  return new Promise((resolve) => {
    const stop = io.listenForEnter(
      () => {
        stop()
        resolve(true)
      },
      () => resolve(false)
    )
  })
}

/**
 * Codex's screen: it runs in this terminal, so with `codex` on PATH the setup
 * offers to run its sign-in (`codex mcp login amdahl`, which opens the
 * browser) on Enter. Ctrl+C skips it. Without `codex` on PATH, or on Windows
 * (where `codex` is a `.cmd` shim that cannot be spawned without a shell),
 * the steps.
 */
async function codexScreen(ctx: Ctx, tool: Ready, say: (line: string) => void, detail: (text: string) => void, lead: string[]): Promise<void> {
  say(tool.already ? '✓ Codex already has Amdahl.' : '✓ Added Amdahl to Codex.')
  detail(tool.detail)
  for (const line of lead) say(line)
  if (ctx.io.platform === 'win32' || !(await onPath(ctx, 'codex'))) {
    say('One step left, in your terminal:')
    say(`  1. Run: ${CODEX_LOGIN}`)
    say(`  2. ${TRY_IN.Codex ?? ''}`)
    return
  }
  say('Press Enter to sign Codex in to Amdahl (opens your browser).')
  if (!(await enterOrSkip(ctx.io))) {
    say(`Skipped. To connect it later, run: ${CODEX_LOGIN}`)
    say(CODEX_TRY)
    return
  }
  const code = await ctx.io.runInteractive('codex', ['mcp', 'login', 'amdahl'])
  if (code === 0) say('✓ Codex is connected.')
  else {
    // On a line of its own: a Ctrl+C that stopped it left "^C" where the cursor was.
    say('')
    say(`Codex didn't finish signing in. To try again, run: ${CODEX_LOGIN}`)
  }
  say(CODEX_TRY)
}

/** Bare `amdahl`, or `amdahl setup`, in the menu or agent mode. */
export async function setup(ctx: Ctx, mode: 'menu' | 'agent'): Promise<number> {
  const { io, out } = ctx
  const verbose = ctx.flags.verbose === true
  // A person's terminal may be narrower than a screen's lines: break them between words.
  const say = (line: string) => {
    for (const part of mode === 'menu' ? wrapLine(line, io.columns()) : [line]) io.stdout(`${part}\n`)
  }
  const detail = (text: string) => {
    if (verbose && text) io.stdout(`${text.replace(/^/gm, '  ')}\n`)
  }
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
    const { ready, exit } = await installEach(ctx, targets)
    for (const tool of ready) {
      say(tool.already ? `✓ ${tool.name} already has Amdahl` : `✓ Added to ${tool.name}`)
      detail(tool.detail)
    }
    for (const line of finishLines(ready.map((t) => t.name), Boolean(io.env.CLAUDECODE))) say(line)
    return exit
  }

  if (detected.length > 0) {
    const there = await Promise.all(detected.map((c) => hasAmdahl(ctx, c.client)))
    if (there.every(Boolean)) {
      // Every tool here points at Amdahl already. Bring an old skill up to date quietly, and ask nothing.
      let exit: number = EXIT.ok
      for (const tool of detected) {
        if (await isInstalled(ctx, tool.client)) continue
        const refreshed = await installEach(ctx, [tool])
        for (const r of refreshed.ready) detail(r.detail)
        if (exit === EXIT.ok) exit = refreshed.exit
      }
      for (const line of allSetLines(detected.map((c) => c.name))) say(line)
      return exit
    }
  }

  const rows = [...SHOWN.map((c) => c.name), TERMINAL]
  const picks = await io.multiSelect(QUESTION, rows, {
    ticked: [...SHOWN.map((c) => found[c.client]), false],
    tags: [...SHOWN.map((c) => (found[c.client] ? FOUND_TAG : undefined)), undefined],
    note: detected.length === 0 ? NONE_FOUND : undefined,
    // With no tool here, the marker starts on "This terminal": Space, then Enter.
    initial: detected.length === 0 ? SHOWN.length : undefined,
    hint: MENU_HINT,
    color: out.color,
  })
  if (picks.length === 0) {
    for (const line of nothingPickedLines()) say(line)
    return EXIT.ok
  }
  const here = picks.includes(SHOWN.length)

  // Work out each tool before writing anything, so one broken settings file is reported up front.
  let exit: number = EXIT.ok
  const chosen: Tool[] = []
  for (const pick of picks.flatMap((i) => SHOWN[i] ?? [])) {
    const err = await preflight(ctx, pick.client)
    if (!err) {
      chosen.push(pick)
      continue
    }
    reportError(io, err)
    if (exit === EXIT.ok) exit = err.exit
  }

  // The tools first, with no sign-in here: whatever happens after, they are set up.
  const done = await installEach(ctx, chosen)
  if (exit === EXIT.ok) exit = done.exit
  let lead = [NEW_USER]
  for (const [i, tool] of done.ready.entries()) {
    if (i > 0) say('')
    if (tool.client === 'codex') {
      await codexScreen(ctx, tool, say, detail, lead)
    } else {
      const [first, ...steps] = toolScreen(tool.name, tool.already)
      say(first ?? '')
      detail(tool.detail)
      for (const line of [...steps, ...lead]) say(line)
    }
    lead = []
  }

  if (!here) return exit
  if (done.ready.length > 0) say('')
  try {
    const code = await tryHere(ctx, say, lead)
    return exit === EXIT.ok ? code : exit
  } catch (err) {
    // Stopped during the try-out: the tools stay set up, so "nothing changed" would not be true.
    if (err instanceof PromptCancelled && done.ready.length > 0) {
      throw new CliError('cancelled', `Stopped. Amdahl is still set up in ${joinNames(done.ready.map((t) => t.name))}.`, EXIT.cancelled)
    }
    throw err
  }
}

/**
 * "This terminal": sign in through the browser when there is no sign-in yet,
 * then ask for a message to be pasted and show Amdahl's version of it.
 */
async function tryHere(ctx: Ctx, say: (line: string) => void, lead: string[]): Promise<number> {
  const { out } = ctx
  const verbose = ctx.flags.verbose === true
  const who = await signIn(ctx)
  if (who.kind === 'in') {
    say(`✓ Signed in · ${who.workspace}`)
    if (verbose) say(`  Signed in as ${who.email}.`)
  } else if (who.kind === 'out') {
    for (const line of lead) say(line)
    const signedIn = await browserSignIn(ctx)
    say(`✓ Signed in · ${printable(signedIn.workspace.name)}`)
    if (verbose) say(`  ${signedInLine(ctx, signedIn)}`)
  } else {
    const name = who.source === 'flag' ? '--api-key' : who.source.slice('env:'.length)
    out.info(`Amdahl rejected the key in ${name}, so a message can't be tried here. Fix it, or unset it and run \`${amdahlCommand('login')}\`.`)
    return EXIT.unauthenticated
  }
  return optimizePasted(ctx)
}
