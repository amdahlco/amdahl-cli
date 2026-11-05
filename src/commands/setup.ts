// src/commands/setup.ts
//
// Bare `amdahl` (for example `npx amdahl`) in a terminal: a guided setup. It
// asks once which AI clients to set up (the ones it finds on this machine
// start ticked), signs in through the browser when there is no sign-in yet,
// then sets up each one ticked the way `install <client>` does. It says one
// line per step; `--verbose` adds the files, the profile and the notes. When
// every client it finds is already set up and there is a sign-in, it says so
// and asks nothing.
//
// The clients sign in to Amdahl themselves, over OAuth, the first time they
// connect: the server lets a CLI sign-in open an API key request but never
// mint one without a person typing a code in the console, so the setup has
// no key to hand them. The last line names that one step for the client.
//
// Only a person at a terminal gets it. When stdin, stdout or stderr (where
// the menu draws) is not a terminal, in CI, when an agent says it is running
// (CLAUDECODE, CURSOR_AGENT) or with AMDAHL_NO_PROMPT=1, bare `amdahl` prints
// the usage and exits 2, as it always has.

import { apiClient, call, resolveCredential, type Credential, type Ctx } from '../context'
import { CliError, EXIT } from '../errors'
import type { Io } from '../io'
import { browserSignIn, signedInLine } from './auth'
import { detectClients, installClient, isInstalled, type Client, type Step } from './install'
import { joinNames } from './skills-guide'

/** The clients in the order the setup shows them, with the names a person reads. */
const SHOWN: { client: Client; name: string }[] = [
  { client: 'claude-code', name: 'Claude Code' },
  { client: 'cursor', name: 'Cursor' },
  { client: 'codex', name: 'Codex' },
]

/**
 * The first thing to ask the client once it is set up. `connect` adds the
 * client's own one-time sign-in, for a client this run just pointed at Amdahl.
 */
export function tryItLine(name: string, connect = false): string {
  const ask = 'say "make this email sound less like AI"'
  if (connect && name === 'Claude Code') return `Try it: in Claude Code, run /mcp once to connect, then ${ask}`
  if (connect && name === 'Codex') return `Try it: run \`codex mcp login amdahl\`, then open Codex and ${ask}`
  return `Try it: open ${name} and ${ask}`
}

/**
 * True when bare `amdahl` should run the setup: stdin, stdout and stderr (the
 * menu draws on stderr) are a terminal, it is not CI, no agent says it is running the command, and
 * AMDAHL_NO_PROMPT is not 1. Reads only `io`, so the usage path builds no
 * context and behaves exactly as before.
 */
export function shouldSetUp(io: Io): boolean {
  const { env } = io
  const ci = Boolean(env.CI) && env.CI !== 'false' && env.CI !== '0'
  return io.stdinIsTTY && io.stdoutIsTTY && io.stderrIsTTY && env.AMDAHL_NO_PROMPT !== '1' && !ci && !env.CLAUDECODE && !env.CURSOR_AGENT
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
    return { kind: 'in', email: me.email ?? me.user_id, workspace: me.workspace?.name ?? me.business_id }
  } catch (err) {
    if (!(err instanceof CliError && err.exit === EXIT.unauthenticated)) throw err
    return credential.source === 'profile' ? { kind: 'out' } : { kind: 'rejected', source: credential.source }
  }
}

/** Bare `amdahl` in a terminal. */
export async function setup(ctx: Ctx): Promise<number> {
  const { io, out } = ctx
  const verbose = ctx.flags.verbose === true
  const say = (line: string) => io.stdout(`${line}\n`)
  const detail = (text: string) => {
    if (verbose && text) say(text.replace(/^/gm, '  '))
  }
  say(`${out.bold('Amdahl')} · predictive ML for GTM`)

  const found = await detectClients(ctx)
  const detected = SHOWN.filter((c) => found[c.client])
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
        say(tryItLine(detected[0]?.name ?? ''))
        return EXIT.ok
      }
    }
  }

  const picks = await io.multiSelect(
    'Set up in:',
    SHOWN.map((c) => c.name),
    { ticked: SHOWN.map((c) => found[c.client]), color: out.color }
  )
  if (picks.length === 0) {
    say('Nothing picked, so nothing changed.')
    return EXIT.ok
  }

  who ??= await signIn(ctx)
  if (who.kind === 'in') {
    say(`✓ Signed in · ${who.workspace}`)
    detail(`Signed in as ${who.email}.`)
  } else if (who.kind === 'out') {
    const signedIn = await browserSignIn(ctx)
    say(`✓ Signed in · ${signedIn.workspace.name}`)
    detail(signedInLine(ctx, signedIn))
  } else {
    const name = who.source === 'flag' ? '--api-key' : who.source.slice('env:'.length)
    out.info(`Amdahl rejected the key in ${name}. Skipping the browser sign-in, because that key would still be used instead. Fix it, or unset it and run \`amdahl login\`.`)
  }

  let exit: number = EXIT.ok
  let ready: { name: string; connect: boolean } | null = null
  for (const { client, name } of picks.flatMap((i) => SHOWN[i] ?? [])) {
    let steps: { mcp: Step; skill: Step }
    try {
      steps = await installClient(ctx, client, false)
    } catch (raw) {
      // Report it and go on to the next client; anything unexpected is that client's failure, not a network error.
      const err = raw instanceof CliError ? raw : new CliError('install_failed', `Could not set up ${name}: ${raw instanceof Error ? raw.message : String(raw)}`, EXIT.general)
      io.stderr(`Error: ${err.message}\n${err.hint ? `${err.hint}\n` : ''}`)
      if (exit === EXIT.ok) exit = err.exit
      continue
    }
    const action = steps.mcp.data.action
    if (action === 'printed') {
      // Without `claude` on PATH there is only the command to run later.
      say(`! ${name}: \`claude\` is not on your PATH. Once it is, run:\n  ${String(steps.mcp.data.command)}`)
    } else {
      say(action === 'unchanged' ? `✓ ${name} already has Amdahl` : `✓ Added to ${name}`)
      ready ??= { name, connect: action !== 'unchanged' }
    }
    const mcpDetail = action === 'printed' ? [] : [steps.mcp.human, ...steps.mcp.notes]
    detail([...mcpDetail, steps.skill.human, ...steps.skill.notes].filter(Boolean).join('\n'))
  }
  if (ready) say(tryItLine(ready.name, ready.connect))
  return exit
}
