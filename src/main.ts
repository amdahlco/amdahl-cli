// src/main.ts
//
// Dispatch: parse argv, build the context, run one command, and turn any
// failure into the error output and its exit code. Returns the exit code
// instead of exiting, so tests drive the whole CLI in-process.

import { USAGE, parseCommandLine } from './args'
import { authToken, login, logout, whoami } from './commands/auth'
import { install } from './commands/install'
import { keysCreate, keysList, keysRevoke } from './commands/keys'
import { optimize } from './commands/optimize'
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
  'keys create': (ctx) => keysCreate(ctx),
  'keys list': (ctx) => keysList(ctx),
  'keys revoke': keysRevoke,
  'workspace list': (ctx) => workspaceList(ctx),
  'workspace use': workspaceUse,
  install,
}

/** Commands that take no positional arguments. */
const NO_ARGS = new Set(['login', 'logout', 'whoami', 'auth token', 'status', 'keys create', 'keys list', 'workspace list'])

/**
 * Run the CLI.
 *
 * @param argv - arguments after `node amdahl.js`.
 * @param io - the process boundary.
 * @returns the exit code.
 */
export async function runCli(argv: string[], io: Io): Promise<number> {
  const json = argv.includes('--json')
  let out = createOutput(io, json, argv.includes('--no-color'))
  try {
    const parsed = parseCommandLine(argv)
    out = createOutput(io, parsed.flags.json === true, parsed.flags['no-color'] === true)
    if (parsed.flags.version) {
      io.stdout(`${VERSION}\n`)
      return EXIT.ok
    }
    if (parsed.flags.help) {
      io.stdout(USAGE)
      return EXIT.ok
    }
    if (!parsed.command) {
      io.stderr(USAGE)
      return EXIT.usage
    }
    if (NO_ARGS.has(parsed.command) && parsed.args.length > 0) {
      throw new CliError('usage', `Unexpected argument: ${parsed.args[0]}`, EXIT.usage)
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
      io.stdout(`${JSON.stringify({ ok: false, error })}\n`)
    } else {
      io.stderr(`Error: ${e.message}\n${e.hint ? `${e.hint}\n` : ''}`)
    }
    return e.exit
  }
}
