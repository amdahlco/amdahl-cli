// src/help.ts
//
// `amdahl <command> --help` and `amdahl help <command>`: that command's usage
// and nothing else. The long help (`amdahl --help`) lists every command; this
// is what one command takes, what it prints, and its exit codes where they
// matter. Every line fits an 80-column terminal. Each command's flags are
// listed here, and a test checks that none is missing.

import { amdahlCommand } from './command-name'
import { SEND_PROVIDERS } from './commands/feedback'

/** The global flags, said once under every command's help. */
const GLOBAL = `
Global options: --profile, --api-url, --api-key, --json, --no-color, --verbose.
Run \`amdahl --help\` for what each does.
`

const HELP: Record<string, string> = {
  setup: `Usage: amdahl [setup] [--no-browser]

The guided setup. In a terminal it asks where Amdahl should work: Claude Code,
Cursor, Codex or this terminal. Run by an agent, or with no terminal, it sets
up that agent (or every client it finds) and asks nothing.

  --no-browser   Print the sign-in link instead of opening a browser.
`,

  login: `Usage: amdahl login [--workspace <slug>] [--no-browser] [--port <n>]

Sign in through the browser with your console account. Also: amdahl auth login.

  --workspace <slug>   Sign in to this workspace.
  --no-browser         Print the sign-in link instead of opening a browser.
  --port <n>           Listen for the browser's answer on this local port.
`,

  logout: `Usage: amdahl logout [--all]

Sign out and forget the sign-in on this machine. Also: amdahl auth logout.

  --all   Sign out of every saved profile, not just the current one.
`,

  whoami: `Usage: amdahl whoami [--show-token]

Show who you are: the account, workspace, role and which credential won. Also:
amdahl auth status.

  --show-token   Print the full access token, not its first characters.
`,

  'auth token': `Usage: amdahl auth token

Print a fresh access token from your sign-in. It needs your own sign-in: a key
in AMDAHL_KEY or --api-key wins over it, and then this exits 4.
`,

  status: `Usage: amdahl status

Can this workspace optimize, and what blocks it. It shows your role, the
monthly optimize quota and any connection that needs attention. Each blocked
item names its fix: the command, the console page, or who to ask.

With --json it prints the server's setup status as one object.
`,

  optimize: `Usage: amdahl optimize [<file>... | -] [--channel email|linkedin]
                       [--evidence off|workspace] [--on-unsupported flag|remove]
                       [--tries] [--context <file.json>]
       amdahl optimize --list <file.csv|file.jsonl> [--no-wait] [--force]
       amdahl optimize --batch <id> [--list <file>] [--force]

Rewrite an outbound email or LinkedIn message. Each file is one message; "-"
reads standard input. With no file, at a terminal, paste the message.

  --channel email|linkedin     What the message is. Left out, it is inferred.
  --evidence off|workspace     "workspace" also evaluates each claim against
                               your customers' own conversations. Slower.
  --on-unsupported flag|remove What to do with a claim nothing backs.
  --tries                      Also show every version the run scored.
  --context <file.json>        Your rules, voice_examples and facts, as JSON.
  --list <file>                Rewrite a whole list in one batch: a CSV with a
                               message column (it may also have item_id,
                               channel, evidence, on_unsupported, facts and
                               rules; any other column is copied to the
                               results) or a JSONL file, one item per line.
                               Up to 500 messages. The results go next to the
                               list: drafts.csv gets drafts.optimized.csv.
  --no-wait                    With --list: queue the batch and print its id.
  --batch <id>                 Pick up a batch queued earlier. With --list, the
                               same list; the results go next to it.
  --force                      Replace a results file that already exists.

Output: the rewrite goes to stdout. What Amdahl did, and the run id, go to
stderr. With --json it prints {"ok", "file", "result"}: the rewritten message
is .result.message and the run id is .result.run_id. Several files give an
array of those. A list prints the batch, and each item's result, with --json.
Exit 1 when a message could not be rewritten.
${GLOBAL}`,

  search: `Usage: amdahl search "<question>" [--research] [--limit <n>]

Ask a question about your customers, calls and deals. It prints a short answer
with the rows it came from.

  --research    Start a research job: a deeper, cited answer. It needs a
                Customer agent key (amdahl keys create --preset agent). With a
                sign-in you get the search answer and a line that says so.
  --limit <n>   Ask for at most n rows.

With --json it prints the server's whole answer, every row included.
${GLOBAL}`,

  connections: `Usage: amdahl connections [--all]

List the sources this workspace has connected, with each one's health and last
sync. A source that needs attention gets a link to its console page.

  --all   Also list disconnected and never-synced sources.
`,

  connect: `Usage: amdahl connect [<connector>] [--no-browser]

Open the console's add page. The connector only fills its search box: you pick
it there and sign in to that tool. If that connector is already connected and
healthy, this says so and prints the page instead of opening it. The CLI never
creates a connection itself.

  --no-browser   Print the link instead of opening a browser. It also prints
                 under --json, for an agent, in CI, and when stdin or stdout
                 is not a terminal.
`,

  open: `Usage: amdahl open [--no-browser]

Open this workspace in the console.

  --no-browser   Print the link instead of opening a browser.
`,

  feedback: `Usage: amdahl feedback <run-id> --evidence did_it_myself|reported_to_me|inferred
                       [--outcome used|used_with_edits|not_used|unsure]
                       [--sent-text <file> | -] [--comment <text>]

Say what happened to the message an optimize run returned. The run id is the
one \`amdahl optimize\` printed. Amdahl learns your preferences from an edit,
unless the evidence is "inferred". Each call stores one event.

  --evidence <how>   How you know. Required.
  --outcome <what>   What happened to it.
  --sent-text <file> The text as sent (a file, or - for standard input).
  --comment <text>   Your own words about it.

Give at least one of --outcome, --sent-text and --comment.
${GLOBAL}`,

  sent: `Usage: amdahl sent <run-id> --provider <provider> --channel <channel>
                   --sent-as returned|edited [--sent-at <time>]
                   (--provider-send-id <id> | --recipient <email|url> |
                    --recipient-key-hash <sha256>)
                   [--provider-campaign-id <id>] [--sequence-step <n>]
                   [--provider-variant-id <id>] [--provider-lead-id <id>]
                   [--thread-id <id>] [--sent-text <file> | -]

Report that the system that sent a message sent it. One send per command; the
API takes up to 100 (POST /messages/report_send).

  --provider <name>   ${SEND_PROVIDERS.slice(0, 4).join(', ')},
                      ${SEND_PROVIDERS.slice(4, 8).join(', ')},
                      ${SEND_PROVIDERS.slice(8).join(', ')}.
                      A sender not on the list: use "other".
  --channel <kind>    email, linkedin (the same as linkedin_message),
                      linkedin_invite, linkedin_message or linkedin_inmail.
  --sent-as <how>     returned (as Amdahl returned it) or edited. An edit needs
                      --sent-text: the message as you sent it.
  --sent-at <time>    A time with a zone, like 2026-11-12T09:30:00Z. Default:
                      now.
  --provider-send-id  The provider's own id for the send. For gmail, the
                      Message-ID header with its angle brackets.
  --recipient         An email address, or a LinkedIn profile URL for a LinkedIn
                      channel. Amdahl stores only a hash of it.
  --recipient-key-hash  A SHA-256 you made, instead of --recipient. Not both.
  --provider-campaign-id, --sequence-step, --provider-variant-id,
  --provider-lead-id, --thread-id   The provider's ids, when you have them.
  --sent-text <file>  The text as sent (a file, or - for standard input). Only
                      a hash of it is kept.

Give one of --provider-send-id, --recipient and --recipient-key-hash: Amdahl
matches a report to a send by one of them.
${GLOBAL}`,

  'keys create': `Usage: amdahl keys create --name <name>
                          [--preset read-only|agent|internal|admin]
                          [--expires 30d|90d|365d] [--no-browser]

Make an API key for a server or CI. You approve it in the console, then the key
is printed once. It needs your own sign-in.

  --name <name>    What to call the key. Required.
  --preset <kind>  read-only (default), agent (reads, optimize and research),
                   internal or admin (workspace admins only).
  --expires <days> 30d, 90d (default) or 365d.
  --no-browser     Print the approval link instead of opening a browser.
`,

  'keys list': `Usage: amdahl keys list

List the workspace's keys, without their secrets. It needs your own sign-in.
`,

  'keys revoke': `Usage: amdahl keys revoke <id|prefix> [--yes] [--no-browser]

Revoke a key. You type the key's name, then approve in the console. It needs
your own sign-in.

  --yes          Skip the question that asks you to type the name.
  --no-browser   Print the approval link instead of opening a browser.
`,

  'workspace list': `Usage: amdahl workspace list

List your saved sign-ins (profiles). One sign-in is one workspace.
`,

  'workspace use': `Usage: amdahl workspace use <profile>

Make a saved profile the default.
`,

  install: `Usage: amdahl install claude-code|codex|cursor [--print] [--force]

Add the Amdahl MCP server and the Amdahl skill to one AI client. It writes no
key or token: the client signs in itself the first time it connects.

  --print   Show what it would change, and change nothing.
  --force   Replace a skill file you have edited.
`,

  'skills add': `Usage: amdahl skills add <publisher>/<skill> [-y] [-g] [--agents] [--force]
                          [--accept-warning] [--site <origin>]

Add a skill from https://amdahl.ai/skills to this project. It needs no sign-in.
In a terminal it asks where to install it.

  -y, --yes          Add it to this project without asking.
  -g, --global       Add it for every project (~/.claude/skills).
  --agents           Also write .agents/skills, for Codex, Cursor and others.
  --force            Replace a different copy that is already there.
  --accept-warning   Install a skill amdahl.ai's security review flagged,
                     after printing the warning. Without it, -y, --json or no
                     terminal stops (exit 9).
  --site <origin>    Read from another origin (https, or http for localhost).
`,

  help: `Usage: amdahl help [<command>]

Show the help for one command, or all of them. Also: amdahl <command> --help.
`,
}

/** Commands that are only a first word: `amdahl keys --help` lists what it has. */
const GROUPS: Record<string, string[]> = {
  keys: ['keys create', 'keys list', 'keys revoke'],
  auth: ['login', 'logout', 'whoami', 'auth token'],
  workspace: ['workspace list', 'workspace use'],
  skills: ['skills add'],
}

/** A command word by another name. */
const ALIASES: Record<string, string> = { 'auth login': 'login', 'auth logout': 'logout', 'auth status': 'whoami' }

/** Every command that has help, by its canonical name. */
export const HELP_COMMANDS = Object.keys(HELP)

/**
 * The help for the command named by `words` (`['optimize']`, `['keys', 'create']`), or the
 * list of a command group's subcommands (`['keys']`), or null when there is none.
 */
export function commandHelp(words: string[]): string | null {
  const key = ALIASES[words.join(' ')] ?? words.join(' ')
  const text = HELP[key]
  if (text) return text
  const group = words.length === 1 ? GROUPS[words[0] ?? ''] : undefined
  if (!group) return null
  const lines = group.map((name) => `  ${amdahlCommand(name)}`)
  return `Usage: amdahl ${words[0]} <command>\n\nCommands:\n${lines.join('\n')}\n\nRun \`amdahl ${words[0]} <command> --help\` for one command.\n`
}
