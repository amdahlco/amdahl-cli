// src/main.ts
//
// Dispatch: parse argv, build the context, run one command, and turn any
// failure into the error output and its exit code. Returns the exit code
// instead of exiting, so tests drive the whole CLI in-process.

import { USAGE, parseCommandLine } from './args'
import { setCommandName } from './command-name'
import { authToken, login, logout, whoami } from './commands/auth'
import { connect, connections, open } from './commands/connections'
import { feedback, sent } from './commands/feedback'
import { install } from './commands/install'
import { keysCreate, keysList, keysRevoke } from './commands/keys'
import { optimize } from './commands/optimize'
import { search } from './commands/search'
import { noSetupLine, setup, setupMode } from './commands/setup'
import { skillsAdd } from './commands/skills'
import { status, workspaceList, workspaceUse } from './commands/workspace-status'
import { createCtx, toCliError, type Ctx } from './context'
import { CliError, EXIT } from './errors'
import type { Io } from './io'
import { createOutput } from './output'
import { VERSION } from './version'

type Handler = (ctx: Ctx, args: string[]) => Promise<number>

const COMMANDS: Record<string, Handler> = {
  login: (ctx) => login(ctx),
  logout: (ctx) => logout(ctx),
  whoami: (ctx) => whoami(ctx),
  'auth token': (ctx) => authToken(ctx),
  status: (ctx) => status(ctx),
  optimize,
  search,
  connections: (ctx) => connections(ctx),
  connect,
  open: (ctx) => open(ctx),
  feedback,
  sent,
  'keys create': (ctx) => keysCreate(ctx),
  'keys list': (ctx) => keysList(ctx),
  'keys revoke': keysRevoke,
  'workspace list': (ctx) => workspaceList(ctx),
  'workspace use': workspaceUse,
  install,
  'skills add': skillsAdd,
}

/** Commands that take no positional arguments. */
const NO_ARGS = new Set(['setup', 'login', 'logout', 'whoami', 'auth token', 'status', 'connections', 'open', 'keys create', 'keys list', 'workspace list'])

/**
 * Run the CLI.
 *
 * @param argv - arguments after `node amdahl.js`.
 * @param io - the process boundary.
 * @returns the exit code.
 */
export async function runCli(argv: string[], io: Io): Promise<number> {
  setCommandName(io)
  const json = argv.includes('--json')
  let out = createOutput(io, json, argv.includes('--no-color'))
  try {
    const parsed = parseCommandLine(argv)
    out = createOutput(io, parsed.flags.json === true, parsed.flags['no-color'] === true)
    if (parsed.flags.version) {
      io.stdout(`${VERSION}\n`)
      return EXIT.ok
    }
    if (parsed.flags.help || parsed.command === 'help') {
      io.stdout(USAGE)
      return EXIT.ok
    }
    if (NO_ARGS.has(parsed.command ?? '') && parsed.args.length > 0) {
      throw new CliError('usage', `Unexpected argument: ${parsed.args[0]}`, EXIT.usage)
    }
    if (!parsed.command || parsed.command === 'setup') {
      // Bare `amdahl` (or `amdahl setup`) is the guided setup: the menu in a person's terminal, no
      // question for an agent or a pipe. In CI, with AMDAHL_NO_PROMPT=1 or with --json it says why
      // not and prints the usage (exit 2).
      const mode = parsed.flags.json ? { kind: 'usage' as const, reason: 'it has no --json output' } : setupMode(io)
      if (mode.kind === 'usage') {
        io.stderr(`${noSetupLine(mode.reason)}${USAGE}`)
        return EXIT.usage
      }
      return await setup(createCtx(io, out, parsed.flags), mode.kind)
    }
    const handler = COMMANDS[parsed.command]
    if (!handler) throw new CliError('usage', `Unknown command ${parsed.command}`, EXIT.usage)
    const ctx = createCtx(io, out, parsed.flags)
    return await handler(ctx, parsed.args)
  } catch (err) {
    const e = err instanceof CliError ? err : toCliError(err)
    if (out.json) {
      const error: Record<string, string> = { code: e.code, message: e.message }
      if (e.hint) error.hint = e.hint
      if (e.detail) error.detail = e.detail
      io.stdout(`${JSON.stringify({ ...e.data, ok: false, error })}\n`)
    } else {
      // A person who pressed Ctrl+C gets a plain line, not an error.
      io.stderr(`${e.code === 'cancelled' ? '' : 'Error: '}${e.message}\n${e.hint ? `${e.hint}\n` : ''}`)
    }
    return e.exit
  }
}
