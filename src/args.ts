// src/args.ts
//
// Argument parsing on `node:util.parseArgs`. Two passes: a lenient pass with
// every known option finds the command words, then a strict pass with only
// that command's options (plus the global ones) rejects anything else as a
// usage error (exit 2).

import { parseArgs, type ParseArgsConfig } from 'node:util'
import { amdahlCommand } from './command-name'
import { type CliError, usageError } from './errors'
import { RECIPES } from './recipes-data'
import { nearest } from './suggest'

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
export const COMMAND_OPTIONS: Record<string, OptionSpec> = {
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
    for: { type: 'string' },
  },
  sequence: {
    write: { type: 'string' },
    emails: { type: 'string' },
    plan: { type: 'string' },
    csv: { type: 'string' },
    from: { type: 'string' },
    force: { type: 'boolean' },
    channel: { type: 'string' },
    evidence: { type: 'string' },
    'on-unsupported': { type: 'string' },
    context: { type: 'string' },
    leads: { type: 'string' },
    match: { type: 'string', multiple: true },
    fallback: { type: 'string', multiple: true },
    same: { type: 'string', multiple: true },
    drop: { type: 'string', multiple: true },
    for: { type: 'string' },
    resume: { type: 'boolean' },
  },
  grade: {
    channel: { type: 'string' },
    evidence: { type: 'string' },
    context: { type: 'string' },
  },
  prompt: {
    mode: { type: 'string' },
    recipients: { type: 'string' },
    channel: { type: 'string' },
    context: { type: 'string' },
    'no-wait': { type: 'boolean' },
    run: { type: 'string' },
  },
  runs: { limit: { type: 'string' } },
  run: {},
  data: { surface: { type: 'string' } },
  recipes: {},
  search: {
    research: { type: 'boolean' },
    limit: { type: 'string' },
    recipe: { type: 'string' },
    'research-id': { type: 'string' },
    // A recipe's fill-ins are flags (--account, --products, ...): the recipe library names them.
    ...Object.fromEntries([...new Set(RECIPES.flatMap((r) => r.fills.map((f) => f.key)))].map((key) => [key, { type: 'string' as const }])),
  },
  connections: { all: { type: 'boolean' } },
  connect: { 'no-browser': { type: 'boolean' } },
  open: { 'no-browser': { type: 'boolean' } },
  'sequencers campaigns': {},
  'sequencers push': {
    campaign: { type: 'string' },
    connection: { type: 'string' },
    list: { type: 'string' },
    channel: { type: 'string' },
    yes: { type: 'boolean' },
  },
  feedback: {
    'sent-text': { type: 'string' },
    comment: { type: 'string' },
    outcome: { type: 'string' },
    evidence: { type: 'string' },
    rating: { type: 'string' },
    surface: { type: 'string' },
    'email-ok': { type: 'boolean' },
    'no-email-ok': { type: 'boolean' },
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
const TWO_WORD = new Set(['auth', 'keys', 'workspace', 'skills', 'sequencers'])

/** The parsed command line. */
export interface ParsedArgs {
  /** Canonical command name, or null when only global flags were given. */
  command: string | null
  /** Positionals after the command words. */
  args: string[]
  /** Every flag value, by long name. */
  flags: Record<string, string | boolean | undefined>
}

/**
 * The positional words of a command line, for help: lenient, so it never throws.
 * `amdahl keys --help` and `amdahl optimize draft.md --help` still name a command.
 */
export function helpWords(argv: string[]): string[] {
  try {
    return parseArgs({ args: argv, options: allOptions(), allowPositionals: true, strict: false }).positionals
  } catch {
    return []
  }
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
    if (second === undefined) throw usageError(`\`amdahl ${first}\` needs a subcommand.`, groupHint(first))
    name = `${first} ${second}`
    words = 2
  }
  name = ALIASES[name] ?? name
  const spec = COMMAND_OPTIONS[name]
  if (!spec) throw unknownCommand(positionals.slice(0, words))

  const strict = strictParse(name === 'sequence' ? bareCsv(argv) : argv, { ...GLOBAL_OPTIONS, ...spec }, name === 'search' && argv.some((a) => a === '--recipe' || a.startsWith('--recipe=')))
  return { command: name, args: strict.positionals.slice(words), flags: strict.values }
}

/** The subcommands of a command group (`keys` → `keys create`, …), aliases included. */
function groupCommands(group: string): string[] {
  const names = [...Object.keys(COMMAND_OPTIONS), ...Object.keys(ALIASES)].filter((n) => n.startsWith(`${group} `))
  return [...new Set(names)]
}

/** The hint under "`amdahl keys` needs a subcommand.": the commands it has. */
function groupHint(group: string): string {
  return `Commands: ${groupCommands(group).map((n) => amdahlCommand(n)).join(', ')}`
}

/** Other words people reach for, by the subcommand that does it. */
const SYNONYMS: Record<string, string> = {
  'keys delete': 'keys revoke',
  'keys remove': 'keys revoke',
  'keys rm': 'keys revoke',
  'keys new': 'keys create',
  'keys add': 'keys create',
  'keys ls': 'keys list',
  'workspace switch': 'workspace use',
  'workspace ls': 'workspace list',
}

/**
 * "Unknown command `optimze`." with the nearest command ("Did you mean `amdahl optimize`?"),
 * or, with none near, the help and the update line: a command from newer docs may not be in
 * this version.
 */
function unknownCommand(words: string[]): CliError {
  const typed = words.join(' ')
  const message = `Unknown command \`${typed}\`.`
  const [first = '', second] = words
  let near: string | null = SYNONYMS[typed] ?? null
  if (!near && second !== undefined) {
    const sub = nearest(second, groupCommands(first).map((n) => n.slice(first.length + 1)))
    near = sub ? `${first} ${sub}` : null
  }
  if (!near && second === undefined) near = nearest(first, [...new Set(Object.keys(COMMAND_OPTIONS).map((n) => n.split(' ')[0] ?? n))])
  if (near && TWO_WORD.has(near) && second === undefined) return usageError(message, `Did you mean \`${amdahlCommand(near)}\`? ${groupHint(near)}`)
  if (near) return usageError(message, `Did you mean \`${amdahlCommand(near)}\`?`)
  return usageError(
    message,
    `Run \`${amdahlCommand('--help')}\` to see the commands. If the docs show it, this amdahl may be older than the docs: update with \`npm install -g amdahl@latest\`, or run \`npx -y amdahl@latest\`.`
  )
}

/**
 * `--csv` alone means "next to the input"; `--csv <path>` names the file, and the path ends in .csv.
 * Any other word after a bare `--csv` is the input, so it is passed on as `--csv=` and that word.
 */
function bareCsv(argv: string[]): string[] {
  return argv.map((arg, i) => (arg === '--csv' && !/\.csv$/i.test(argv[i + 1] ?? '') ? '--csv=' : arg))
}

function strictParse(argv: string[], options: OptionSpec, withRecipe = false) {
  try {
    const parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true })
    return {
      positionals: parsed.positionals,
      values: parsed.values as Record<string, string | boolean | undefined>,
    }
  } catch (err) {
    const [message, hint] = parseErrorMessage(err)
    // With --recipe, an option this version lacks is most likely a fill-in the server's newer recipes take.
    if (withRecipe && (err as { code?: string } | null)?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      throw usageError(message, `If it is a recipe's fill-in, this version of amdahl does not know it: update with \`npm install -g amdahl@latest\`. Or run \`${amdahlCommand('--help')}\`.`)
    }
    throw usageError(message, hint)
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
                                 and say what changed and why (with no file,
                                 at a terminal, paste it)
  amdahl optimize --list drafts.csv
                                 Rewrite a whole list in one batch; results go
                                 to drafts.optimized.csv
  amdahl optimize --list drafts.csv --for lemlist
                                 Also write drafts-lemlist.csv, a file your
                                 sequencer imports, and say how (Instantly,
                                 Smartlead, lemlist, HeyReach, Apollo and more)
  amdahl sequence emails.md      Improve a 2 to 10 email sequence, in order
  amdahl sequence --write "<goal>"
                                 Write a new one, 2 to 6 emails
  amdahl sequence emails.md --leads leads.csv
                                 A sequence for each person in a lead list
  amdahl grade draft.md          Grade a message: score and the lines behind
  amdahl prompt prompt.md        Grade or improve a reusable prompt by the
                                 emails it writes (with no file, at a
                                 terminal, three short steps)
  amdahl search "<question>"     Ask about your customers, calls and deals
  amdahl recipes                 The console's questions (amdahl search
                                 --recipe <id> runs one)
  amdahl data                    What the workspace holds, what to filter on
  amdahl runs                    Your latest runs (amdahl run <id> opens one)
  amdahl connect hubspot         Add a CRM or call recorder in the console
                                 (amdahl connections lists what is connected)
  amdahl sequencers push drafts-other.csv --campaign <id>
                                 Add the leads and Amdahl's messages to a
                                 paused or draft campaign in your connected
                                 sequencer (amdahl sequencers campaigns lists
                                 them); it asks first
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
           --json prints {ok, file, result}: the message is .result.message
           and the run id is .result.run_id.
  optimize --list <file.csv|file.jsonl> [--no-wait] [--batch <id>] [--force]
           [--for <tool>] [the optimize flags above, for every message]
           A CSV needs a message column, and may have item_id, channel,
           evidence, on_unsupported, facts and rules. Any other column is
           copied to the results as it is. --batch <id> picks up a batch
           queued earlier, with the same list. --force replaces an existing
           results file. In the results CSV, a cell that starts with =, +, -
           or @ (a phone number, say) gets a ' in front: it is no formula.
           --for <tool>  a CSV list only: also write the messages Amdahl wrote
                       as a CSV that tool imports (<list>-<tool>.csv), and say
                       how to import it. Tools: instantly, smartlead, lemlist,
                       heyreach, reply_io, apollo, outreach, salesloft,
                       hubspot, lgm, woodpecker, amplemarket, other (any tool
                       that imports a CSV). lemlist, reply_io and other take
                       both channels, so add --channel email|linkedin.
  sequence [<file>|-] [--evidence off|workspace] [--on-unsupported flag|remove]
           [--context <file.json>] [--csv [<file.csv>]] [--force] [--from <n>]
  sequence --write "<goal>" [--emails <2-6>] [--plan <file>] [the flags above]
           Improve 2 to 10 emails in order (a text, markdown or CSV file, or -
           for stdin), or write 2 to 6 new ones. Each email is written as a
           follow-up to the improved ones before it. --json prints {ok, mode,
           emails, fields}: each email has .subject, .message and .run_id.
  sequence <file> --leads <list.csv> [--match <field>=<column>]
           [--fallback <field>=<text>] [--same <field>=<text>] [--drop <field>]
           [--for <tool>] [--force] [--resume]
  sequence --write "<goal>" --leads <list.csv> [--emails <2-6>] [--plan <file>]
           [--for <tool>] [--force] [--resume]
           A whole sequence for each person in a lead list, up to 500 people.
           Each person's email 2 follows their own email 1. The results are
           saved next to the list as <list>-amdahl-sequence.csv.
  grade <file|-> [--channel email|linkedin] [--evidence off|workspace]
           [--context <file.json>]
           Grade a draft and write nothing. The score always comes with its
           five lines. No line evaluated reads "Not graded", never 0. A grade
           does not predict replies. --json prints {ok, file, result}: the
           grade is .result.grade.
  prompt <file|-> [--mode improve|grade] [--recipients <file.json|file.csv>]
           [--channel email|linkedin] [--context <file.json>] [--no-wait]
  prompt --run <id> [--no-wait]
           Grade or improve a reusable prompt by the emails it writes. A run
           takes minutes: its id is printed, --run <id> reads it later.
  prompt   With no file, at a terminal, it asks in three steps: the prompt,
           who to test it on, and Improve or Grade.
  runs [--limit <n>]                         Your latest runs, on this computer
  run <run-id>                               One run: your draft, then Amdahl's
  data [--surface interactions|deals|deal_qualification]
                                             What the workspace holds and what
                                             a search can filter on
  recipes                                    The console's recipe questions
  search "<question>" [--research] [--limit <n>]
  search --recipe <id> [--account|--products|--messages|--objection <text>]
  search --research-id <id>
           --research  ask for a research job: a deeper, cited answer (needs
                       a Customer agent key, amdahl keys create --preset
                       agent; a sign-in gets the search answer). Search starts
                       research itself when a question needs it, and offers
                       it when it could help
           --recipe    one of the console's questions (amdahl recipes); its
                       fill-in is a flag, like --account Acme
           --research-id  read a research job that started earlier; search
                       prints the id when a job starts
  connections [--all]                        Connected sources and health
  connect [<connector>] [--no-browser]       Open the console's add page
  open    [--no-browser]                     This workspace in the console
  sequencers campaigns [<connection>]        A connected sequencer's campaigns
  sequencers push <file|batch-id> --campaign <id> [--connection <id|type>]
           [--list <file>] [--channel email|linkedin] [--yes]
           Add leads, with the messages Amdahl wrote, to a paused or draft
           campaign. It shows the campaign and the lead count and asks first;
           --yes skips the question. A file needs an amdahl_message column
           (optimize --list <list> --for other writes one); a batch id needs
           --list, the list it was written from. Up to 100 leads a call.
  feedback <run-id> --evidence did_it_myself|reported_to_me|inferred
           [--outcome used|used_with_edits|not_used|unsure]
           [--sent-text <file> | -] [--comment <text>]
                                             What happened to a message
           At a terminal, what is left out is asked (at most two questions);
           with --json, in an agent or in CI, nothing is asked.
  sent <run-id> --provider <provider> --channel <channel>
           --sent-as returned|edited [--sent-at <time>]
           [--provider-send-id <id>]
           [--recipient <email|url> | --recipient-key-hash <sha256>]
           [--provider-campaign-id <id>] [--sequence-step <n>]
           [--provider-variant-id <id>] [--provider-lead-id <id>]
           [--thread-id <id>] [--sent-text <file> | -]
           One send per command. Give --provider-send-id, a recipient, or
           both (a recipient is --recipient or --recipient-key-hash, not both).
           --provider: lemlist, instantly, outreach, salesloft, hubspot,
                       salesforce, gmail, heyreach, apollo, smartlead,
                       reply_io, lgm, woodpecker, amplemarket,
                       linkedin_manual, other (any sender not listed)
           --channel:  email, linkedin (= linkedin_message), linkedin_invite,
                       linkedin_message, linkedin_inmail
           --sent-as edited needs --sent-text.
                                             Report that a message went out
           At a terminal, what is left out is asked (at most three questions);
           with --json, in an agent or in CI, nothing is asked.
  keys create --name <name> [--preset optimize|read-only|agent|internal|admin]
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
           Run \`amdahl <command> --help\` for one command's usage.

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
