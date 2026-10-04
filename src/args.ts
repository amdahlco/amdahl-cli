// src/args.ts
//
// Argument parsing on `node:util.parseArgs`. Two passes: a lenient pass with
// every known option finds the command words, then a strict pass with only
// that command's options (plus the global ones) rejects anything else as a
// usage error (exit 2).

import { parseArgs, type ParseArgsConfig } from 'node:util'
import { usageError } from './errors'

type OptionSpec = NonNullable<ParseArgsConfig['options']>

/** Flags every command accepts. */
const GLOBAL_OPTIONS: OptionSpec = {
  profile: { type: 'string' },
  'api-url': { type: 'string' },
  'api-key': { type: 'string' },
  json: { type: 'boolean' },
  'no-color': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
}

/** Each command's own flags, keyed by its canonical name. */
const COMMAND_OPTIONS: Record<string, OptionSpec> = {
  login: {
    workspace: { type: 'string' },
    'no-browser': { type: 'boolean' },
    port: { type: 'string' },
  },
  logout: { all: { type: 'boolean' } },
  whoami: { 'show-token': { type: 'boolean' } },
  'auth token': {},
  status: {},
  optimize: {
    channel: { type: 'string' },
    evidence: { type: 'string' },
    'on-unsupported': { type: 'string' },
    tries: { type: 'boolean' },
    context: { type: 'string' },
  },
  'keys create': {
    name: { type: 'string' },
    preset: { type: 'string' },
    expires: { type: 'string' },
    'no-browser': { type: 'boolean' },
  },
  'keys list': {},
  'keys revoke': { yes: { type: 'boolean' }, 'no-browser': { type: 'boolean' } },
  'workspace list': {},
  'workspace use': {},
  install: { print: { type: 'boolean' }, force: { type: 'boolean' } },
}

/** Aliases onto canonical command names. */
const ALIASES: Record<string, string> = {
  'auth login': 'login',
  'auth logout': 'logout',
  'auth status': 'whoami',
}

/** Every command that takes one or two words. */
const TWO_WORD = new Set(['auth', 'keys', 'workspace'])

/** The parsed command line. */
export interface ParsedArgs {
  /** Canonical command name, or null when only global flags were given. */
  command: string | null
  /** Positionals after the command words. */
  args: string[]
  /** Every flag value, by long name. */
  flags: Record<string, string | boolean | undefined>
}

function allOptions(): OptionSpec {
  const merged: OptionSpec = { ...GLOBAL_OPTIONS }
  for (const spec of Object.values(COMMAND_OPTIONS)) Object.assign(merged, spec)
  return merged
}

/**
 * Parse argv (without the node and script entries).
 *
 * @throws a usage CliError for an unknown command or flag.
 */
export function parseCommandLine(argv: string[]): ParsedArgs {
  let loose
  try {
    loose = parseArgs({ args: argv, options: allOptions(), allowPositionals: true, strict: false })
  } catch (err) {
    throw usageError(err instanceof Error ? err.message : String(err))
  }
  const positionals = loose.positionals
  const first = positionals[0]
  if (first === undefined) {
    return { command: null, args: [], flags: strictParse(argv, GLOBAL_OPTIONS).values }
  }

  let words = 1
  let name = first
  if (TWO_WORD.has(first)) {
    const second = positionals[1]
    if (second === undefined) throw usageError(`\`amdahl ${first}\` needs a subcommand.`)
    name = `${first} ${second}`
    words = 2
  }
  name = ALIASES[name] ?? name
  const spec = COMMAND_OPTIONS[name]
  if (!spec) throw usageError(`Unknown command \`${positionals.slice(0, words).join(' ')}\`.`)

  const strict = strictParse(argv, { ...GLOBAL_OPTIONS, ...spec })
  return { command: name, args: strict.positionals.slice(words), flags: strict.values }
}

function strictParse(argv: string[], options: OptionSpec) {
  try {
    const parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true })
    return {
      positionals: parsed.positionals,
      values: parsed.values as Record<string, string | boolean | undefined>,
    }
  } catch (err) {
    throw usageError(err instanceof Error ? err.message : String(err))
  }
}

/** The help text. */
export const USAGE = `Usage: amdahl <command> [options]

What you can do:
  amdahl optimize draft.md       Rewrite an outbound email or LinkedIn message
  amdahl status                  Check that this workspace is set up to optimize
  amdahl keys create --name ci   Make an API key for a server or CI
  amdahl install claude-code     Connect your AI client (also codex, cursor)
  For everything Amdahl can do: https://docs.amdahl.ai/skills/amdahl/SKILL.md

Commands:
  login   [--workspace <slug>] [--no-browser] [--port <n>]   Sign in (alias: auth login)
  logout  [--all]                                           Sign out (alias: auth logout)
  whoami  [--show-token]                                    Show who you are (alias: auth status)
  auth token                                                Print a fresh access token
  status                                                    Check whether this workspace can optimize
  optimize [<file>... | -] [--channel email|linkedin] [--evidence off|workspace]
           [--on-unsupported flag|remove] [--tries] [--context <file.json>]
  keys create --name <name> [--preset read-only|agent|internal|admin] [--expires 30d|90d|365d] [--no-browser]
  keys list
  keys revoke <id|prefix> [--yes] [--no-browser]
  workspace list | workspace use <profile>
  install claude-code|codex|cursor [--print] [--force]

Global options:
  --profile <name>   Use a saved profile (default: AMDAHL_PROFILE, then the default profile)
  --api-url <url>    API host (default: AMDAHL_API_URL, then the profile, then https://app.amdahl.ai)
  --api-key <key>    Use an API key for this command (prefer AMDAHL_KEY: argv is visible to other users)
  --json             Data on stdout as JSON, messages on stderr
  --no-color         No colour (NO_COLOR is honoured too)
  -h, --help         Show this help
  -v, --version      Show the version
`
