// src/command-name.ts
//
// How messages name the CLI. Someone who ran `npx amdahl` has no `amdahl`
// command on their PATH, so a message that says "run `amdahl login`" would
// send them to a command that does not exist. `runCli` sets the name once per
// run from how the CLI was started; every message builds its commands with
// {@link amdahlCommand}.

import type { Io } from './io'

let prefix = 'amdahl'

/**
 * True when npm's `npx` (or `npm exec`) started the CLI: npm sets
 * `npm_command=exec` and `npm_lifecycle_event=npx`, and npx installs into a
 * `_npx` folder in its cache.
 */
export function startedByNpx(io: Pick<Io, 'env' | 'scriptPath'>): boolean {
  return io.env.npm_command === 'exec' || io.env.npm_lifecycle_event === 'npx' || /[\\/]_npx[\\/]/.test(io.scriptPath ?? '')
}

/**
 * Name the CLI `npx -y amdahl` or `amdahl` in every message of this run. The
 * `-y` skips npm's "Ok to proceed?" question, which npm asks on every run.
 */
export function setCommandName(io: Pick<Io, 'env' | 'scriptPath'>): void {
  prefix = startedByNpx(io) ? 'npx -y amdahl' : 'amdahl'
}

/** The command to tell a person to run, for example `amdahlCommand('login')` is `npx -y amdahl login` under npx. */
export function amdahlCommand(rest = ''): string {
  return rest ? `${prefix} ${rest}` : prefix
}
