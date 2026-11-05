// src/commands/setup.ts
//
// Bare `amdahl` (for example `npx amdahl`) in a terminal: a guided setup. It
// names the AI clients it finds on this machine, asks once which to set up
// (the ones it found start ticked), signs in through the browser when there
// is no sign-in yet, then runs `install <client>` for each one ticked. When
// every client it finds is already set up and there is a sign-in, it says so
// and asks nothing.
//
// Only a person at a terminal gets it. With no terminal, CI, an agent that
// says it is running (CLAUDECODE, CURSOR_AGENT) or AMDAHL_NO_PROMPT=1, bare
// `amdahl` prints the usage and exits 2, as it always has.

import { apiClient, call, resolveCredential, type Ctx } from '../context'
import { CliError, EXIT } from '../errors'
import type { Io } from '../io'
import { login } from './auth'
import { detectClients, install, isInstalled, onPath, type Client } from './install'
import { joinNames } from './skills-guide'

/** The clients in the order the setup shows them, with the names a person reads. */
const SHOWN: { client: Client; name: string }[] = [
  { client: 'claude-code', name: 'Claude Code' },
  { client: 'cursor', name: 'Cursor' },
  { client: 'codex', name: 'Codex' },
]

/** The first thing to ask the client once it is set up. */
export function tryItLine(name: string): string {
  return `Try it: open ${name} and say "make this email sound less like AI"`
}

/**
 * True when bare `amdahl` should run the setup: stdin and stdout are a
 * terminal, it is not CI, no agent says it is running the command, and
 * AMDAHL_NO_PROMPT is not 1. Reads only `io`, so the usage path builds no
 * context and behaves exactly as before.
 */
export function shouldSetUp(io: Io): boolean {
  const { env } = io
  const ci = Boolean(env.CI) && env.CI !== 'false' && env.CI !== '0'
  return io.stdinIsTTY && io.stdoutIsTTY && env.AMDAHL_NO_PROMPT !== '1' && !ci && !env.CLAUDECODE && !env.CURSOR_AGENT
}

/** Who the stored sign-in (or key) belongs to, or null when there is none that works. */
async function signedInAs(ctx: Ctx): Promise<{ email: string; workspace: string } | null> {
  try {
    const credential = await resolveCredential(ctx)
    const me = await call(() => apiClient(ctx, credential).cli.whoami())
    return { email: me.email ?? me.user_id, workspace: me.workspace?.name ?? me.business_id }
  } catch (err) {
    if (err instanceof CliError && err.exit === EXIT.unauthenticated) return null
    throw err
  }
}

/** Bare `amdahl` in a terminal. */
export async function setup(ctx: Ctx): Promise<number> {
  const { io, out } = ctx
  const say = (line: string) => io.stdout(`${line}\n`)
  say(`${out.bold('Amdahl')}, predictive ML for GTM`)

  const found = await detectClients(ctx)
  const detected = SHOWN.filter((c) => found[c.client])
  let who: Awaited<ReturnType<typeof signedInAs>> | undefined
  if (detected.length > 0) {
    const installed = await Promise.all(detected.map((c) => isInstalled(ctx, c.client)))
    if (installed.every(Boolean) && (who = await signedInAs(ctx))) {
      say(`You're set up in ${joinNames(detected.map((c) => c.name))}.`)
      say(tryItLine(detected[0]?.name ?? ''))
      return EXIT.ok
    }
  }

  say(`Found on this machine: ${SHOWN.map((c) => `${c.name} ${found[c.client] ? '✓' : '–'}`).join('  ')}`)
  if (detected.length === 0) {
    say('None of them found here. Tick the ones you use with Space, then press Enter.')
  }
  const picks = await io.multiSelect(
    'Set up Amdahl in:',
    SHOWN.map((c) => c.name),
    { ticked: SHOWN.map((c) => found[c.client]), color: out.color }
  )
  if (picks.length === 0) {
    say('Nothing picked, so nothing changed. To set one up later: amdahl install claude-code|codex|cursor')
    return EXIT.ok
  }

  if (who === undefined) who = await signedInAs(ctx)
  if (who) say(`Signed in as ${who.email} (workspace: ${who.workspace})`)
  else await login(ctx)

  let exit: number = EXIT.ok
  let ready: string | null = null
  for (const { client, name } of picks.flatMap((i) => SHOWN[i] ?? [])) {
    try {
      await install(ctx, [client])
    } catch (err) {
      if (!(err instanceof CliError)) throw err
      io.stderr(`Error: ${err.message}\n${err.hint ? `${err.hint}\n` : ''}`)
      if (exit === EXIT.ok) exit = err.exit
      continue
    }
    // Without `claude` on PATH, `install claude-code` only prints the command to run.
    if (ready === null && (client !== 'claude-code' || (await onPath(ctx, 'claude')))) ready = name
  }
  if (ready) say(tryItLine(ready))
  return exit
}
