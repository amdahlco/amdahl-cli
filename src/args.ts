// src/args.ts
//
// Argument parsing on `node:util.parseArgs`. Two passes: a lenient pass with
// every known option finds the command words, then a strict pass with only
// that command's options (plus the global ones) rejects anything else as a
// usage error (exit 2).

import { parseArgs, type ParseArgsConfig } from 'node:util'
import { amdahlCommand } from './command-name'
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
  verbose: { type: 'boolean' },
}

/** The flags bare `amdahl` (the guided setup) takes beside the global ones. */
const SETUP_OPTIONS: OptionSpec = { 'no-browser': { type: 'boolean' } }

/** Each command's own flags, keyed by its canonical name. */
const COMMAND_OPTIONS: Record<string, OptionSpec> = {
  setup: SETUP_OPTIONS,
  help: {},
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
    list: { type: 'string' },
    batch: { type: 'string' },
    'no-wait': { type: 'boolean' },
    force: { type: 'boolean' },
  },
  search: { research: { type: 'boolean' }, limit: { type: 'string' } },
  connections: { all: { type: 'boolean' } },
  connect: { 'no-browser': { type: 'boolean' } },
  open: { 'no-browser': { type: 'boolean' } },
  feedback: {
    'sent-text': { type: 'string' },
    comment: { type: 'string' },
    outcome: { type: 'string' },
    evidence: { type: 'string' },
  },
  sent: {
    provider: { type: 'string' },
    channel: { type: 'string' },
    'sent-as': { type: 'string' },
    'sent-at': { type: 'string' },
    'provider-send-id': { type: 'string' },
    'provider-campaign-id': { type: 'string' },
    'sequence-step': { type: 'string' },
    'provider-variant-id': { type: 'string' },
    'provider-lead-id': { type: 'string' },
    'thread-id': { type: 'string' },
    recipient: { type: 'string' },
    'recipient-key-hash': { type: 'string' },
    'sent-text': { type: 'string' },
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
  'skills add': {
    yes: { type: 'boolean', short: 'y' },
    global: { type: 'boolean', short: 'g' },
    agents: { type: 'boolean' },
    force: { type: 'boolean' },
    'accept-warning': { type: 'boolean' },
    site: { type: 'string' },
  },
}

/** Aliases onto canonical command names. */
const ALIASES: Record<string, string> = {
  'auth login': 'login',
  'auth logout': 'logout',
  'auth status': 'whoami',
}

/** Every command that takes one or two words. */
const TWO_WORD = new Set(['auth', 'keys', 'workspace', 'skills'])

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
    throw usageError(...parseErrorMessage(err))
  }
  const positionals = loose.positionals
  const first = positionals[0]
  if (first === undefined) {
    return { command: null, args: [], flags: strictParse(argv, { ...GLOBAL_OPTIONS, ...SETUP_OPTIONS }).values }
  }

  let words = 1
  let name = first
  if (TWO_WORD.has(first)) {
    const second = positionals[1]
    if (first === 'skills' && second !== 'add') {
      // `amdahl skills` or `amdahl skills <publisher>/<skill>`: point at the one skills command.
      const ref = second && second.includes('/') ? second : '<publisher>/<skill>'
      throw usageError(
        second === undefined ? '`amdahl skills` needs a subcommand.' : `Unknown command \`amdahl skills ${second}\`.`,
        `To add a skill: npx -y amdahl skills add ${ref}`
      )
    }
    if (second === undefined) throw usageError(`\`amdahl ${first}\` needs a subcommand.`)
    name = `${first} ${second}`
    words = 2
  }
  name = ALIASES[name] ?? name
  const spec = COMMAND_OPTIONS[name]
  if (!spec) throw usageError(`Unknown command \`${positionals.slice(0, words).join(' ')}\`.`, `Run \`${amdahlCommand('--help')}\` to see the commands.`)

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
    throw usageError(...parseErrorMessage(err))
  }
}

/**
 * Node's parseArgs messages, said plainly: "Unknown option --foo." instead of
 * its advice on positionals that start with '-'.
 */
function parseErrorMessage(err: unknown): [string, string?] {
  const message = err instanceof Error ? err.message : String(err)
  const code = (err as { code?: string } | null)?.code
  const help = `Run \`${amdahlCommand('--help')}\`.`
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    const option = /'(-[^']*)'/.exec(message)?.[1] ?? message
    return [`Unknown option ${option}.`, help]
  }
  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    const option = /'(--?[\w-]+)/.exec(message)?.[1]
    if (option && /argument missing/.test(message)) return [`${option} needs a value.`, help]
    if (option) return [`${option} takes no value.`, help]
  }
  return [message, help]
}

/** The help text. Every line fits an 80-column terminal. */
export const USAGE = `Usage: amdahl <command> [options]

What you can do:
  amdahl                         Set up Claude Code, Cursor or Codex, or try
                                 Amdahl in this terminal. In a terminal it
                                 asks which. Run by an agent or with no
                                 terminal, it sets up that agent, or every
                                 client it finds, and asks nothing (also:
                                 amdahl setup)
  amdahl optimize draft.md       Rewrite an outbound email or LinkedIn message
                                 (with no file, at a terminal, paste it)
  amdahl optimize --list drafts.csv
                                 Rewrite a whole list in one batch; results go
                                 to drafts.optimized.csv
  amdahl search "<question>"     Ask about your customers, calls and deals
  amdahl connect hubspot         Add a CRM or call recorder in the console
                                 (amdahl connections lists what is connected)
  amdahl status                  Check that this workspace can optimize
  amdahl open                    Open this workspace in the console
  amdahl keys create --name ci   Make an API key for a server or CI
  amdahl install claude-code     Connect one AI client (also codex, cursor)
  amdahl skills add <publisher>/<skill>
                                 Add a skill from https://amdahl.ai/skills
                                 to this project: its SKILL.md, or its folder
  Everything Amdahl can do: https://docs.amdahl.ai/skills/amdahl/SKILL.md

Commands:
  setup   [--no-browser]                     The guided setup (bare amdahl)
  login   [--workspace <slug>] [--no-browser] [--port <n>]
                                             Sign in (alias: auth login)
  logout  [--all]                            Sign out (alias: auth logout)
  whoami  [--show-token]                     Who you are (alias: auth status)
  auth token                                 Print a fresh access token
  status                                     Can this workspace optimize?
  optimize [<file>... | -] [--channel email|linkedin]
           [--evidence off|workspace] [--on-unsupported flag|remove]
           [--tries] [--context <file.json>]
  optimize --list <file.csv|file.jsonl> [--no-wait] [--batch <id>] [--force]
           [the optimize flags above, for every message]
           A CSV has a message column, and may have item_id, channel,
           evidence, on_unsupported, facts and rules. --batch <id> picks up
           a batch queued earlier, with the same list. --force replaces an
           existing results file.
  search "<question>" [--research] [--limit <n>]
           --research  ask for a research job: a deeper, cited answer (needs
                       a Customer agent key, amdahl keys create --preset
                       agent; a sign-in gets the search answer)
  connections [--all]                        Connected sources and health
  connect [<connector>] [--no-browser]       Open the console's add page
  open    [--no-browser]                     This workspace in the console
  feedback <run-id> --evidence did_it_myself|reported_to_me|inferred
           [--outcome used|used_with_edits|not_used|unsure]
           [--sent-text <file> | -] [--comment <text>]
                                             What happened to a message
  sent <run-id> --provider <provider> --channel <channel>
           --sent-as returned|edited [--sent-at <time>]
           (--provider-send-id <id> | --recipient <email|url> |
            --recipient-key-hash <sha256>)
           [--provider-campaign-id <id>] [--sequence-step <n>]
           [--provider-variant-id <id>] [--provider-lead-id <id>]
           [--thread-id <id>] [--sent-text <file> | -]
           One send per command. It needs one of the three in brackets.
                                             Report that a message went out
  keys create --name <name> [--preset read-only|agent|internal|admin]
              [--expires 30d|90d|365d] [--no-browser]
  keys list
  keys revoke <id|prefix> [--yes] [--no-browser]
  workspace list | workspace use <profile>
  install claude-code|codex|cursor [--print] [--force]
  skills add <publisher>/<skill> [-y] [-g] [--agents] [--force]
             [--accept-warning] [--site <origin>]
           In a terminal it asks one question: this project (Enter) or
           every project.
           -y        add without asking, to this project
           -g        every project (~/.claude/skills), not just this one
           --agents  also .agents/skills, for Codex, Cursor and other agents
           --force   replace a different copy of the skill already there
           --accept-warning
                     install a skill that amdahl.ai's security review flagged,
                     after printing the warning. Without it, a terminal asks
                     (Cancel or Install anyway); -y, --json or no terminal
                     stops (exit 9)
  help                                       Show this help

Global options:
  --profile <name>   Use a saved profile (default: AMDAHL_PROFILE, then the
                     default profile)
  --api-url <url>    API host (default: AMDAHL_API_URL, then the profile,
                     then https://app.amdahl.ai)
  --api-key <key>    Use an API key for this command (prefer AMDAHL_KEY: argv
                     is visible to other users)
  --json             Data on stdout as JSON, messages on stderr
  --no-color         No colour (NO_COLOR is honoured too)
  --verbose          Say more: files written, the profile, where the sign-in
                     is stored
  -h, --help         Show this help
  -v, --version      Show the version
`
