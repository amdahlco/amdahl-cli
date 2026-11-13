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
       amdahl optimize --list <file.csv> --for <tool> [--channel email|linkedin]
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
  --for <tool>                 With a CSV --list: also write the messages Amdahl
                               wrote as a CSV that tool imports, next to the
                               list (drafts.csv for lemlist gets
                               drafts-lemlist.csv), then print how to import it.
                               Tools: instantly, smartlead, lemlist, heyreach,
                               reply_io, apollo, outreach, salesloft, hubspot,
                               lgm, woodpecker, or other (any tool that imports
                               a CSV).
  --force                      Replace a results file that already exists.

In the results CSV, a cell that starts with =, +, - or @ gets a ' in front, so
a spreadsheet does not run it as a formula. That includes a phone number such
as +1 555 0100 or a negative number you copied through. Delete the ' to use it.

The --for file holds only the leads Amdahl wrote, with your columns after
Amdahl's, except the column the message came from and the ones Amdahl reads
(message, channel, evidence, on_unsupported, facts, rules, item_id). Your tool
imports a value as it is, so no cell gets the ' guard (the results file keeps
it). A lead that failed, needed input or has no email (no LinkedIn URL for
LinkedIn) is left out, and counted. A tool that takes one channel needs no
--channel; lemlist, reply_io and other take both, so add --channel. With
--json, .send_to has the file and the counts.

Output: the rewrite goes to stdout. What Amdahl did, and the run id, go to
stderr. With --json it prints {"ok", "file", "result"}: the rewritten message
is .result.message and the run id is .result.run_id. Several files give an
array of those. A list prints the batch, and each item's result, with --json.
Exit 1 when a message could not be rewritten.
${GLOBAL}`,

  search: `Usage: amdahl search "<question>" [--research] [--limit <n>]
       amdahl search --recipe <id> [--<fill-in> <value>]
       amdahl search --research-id <id>

Ask a question about your customers, calls and deals. It prints a short answer
with the rows it came from.

  --research    Start a research job: a deeper, cited answer. It needs a
                Customer agent key (amdahl keys create --preset agent). With a
                sign-in you get the search answer and a line that says so.
  --limit <n>   Ask for at most n rows.
  --recipe <id> Ask one of the console's recipe questions instead of your own
                (amdahl recipes lists them). A recipe with a fill-in takes it
                as a flag: --account, --products, --messages or --objection.
  --account, --products, --messages, --objection
                The fill-in a recipe asks for, in quotes. At most 300
                characters; a longer one is cut there, as the console does.
  --research-id <id>
                Read a research job that started earlier, and wait for it.
                Search prints the id when a job starts. It needs a key that
                can read research, the one that started the job.

With no rows it says why, in the server's words. A search the server cut at its
deadline says it ran out of time and exits 1; add --research, which can run
longer. With --json it prints the server's whole answer, every row included.
${GLOBAL}`,

  grade: `Usage: amdahl grade <file|-> [--channel email|linkedin]
                    [--evidence off|workspace] [--context <file.json>]

Grade a draft without rewriting it. The file is the message; "-" reads standard
input; with no file, at a terminal, paste it. Nothing is written back to you:
the grade is a 1 to 5 score with the five lines it rests on, each with its
verdict and reason.

  --channel email|linkedin   What the message is. Left out, it is inferred.
  --evidence off|workspace   "workspace" grades four of the lines against your
                             customers' calls, so it needs data connected.
                             Without it only the ask is graded; the others
                             say they were not evaluated.
  --context <file.json>      Your facts, rules and voice_examples, as JSON.

A line that could not be evaluated is not a fail, and a grade with no line
evaluated reads "Not graded", never 0. A grade is one reading and does not
predict replies. With --json it prints {"ok", "file", "result"}: the grade is
.result.grade and the run id is .result.run_id.
${GLOBAL}`,

  prompt: `Usage: amdahl prompt <file|-> [--mode improve|grade]
                     [--recipients <file.json>] [--channel email|linkedin]
                     [--context <file.json>] [--no-wait]
       amdahl prompt --run <id> [--no-wait]

Grade or improve a reusable prompt (the instructions a writer follows to write
an outbound email to any recipient) by the emails it writes. It starts a run
that takes a few minutes, prints the run id and waits. One message, not a
prompt, is for amdahl optimize.

  --mode improve|grade  improve (the default) revises the prompt and returns it
                        only when the revision wrote better email on recipients
                        held out of the revising. grade writes one email per
                        recipient and grades each.
  --recipients <file>   1 to 6 sample recipients as JSON: [{"recipient":
                        {"company": "Helix"}, "recipient_notes": "..."}]. Each
                        may have name, company, email, domain, linkedin_url and
                        attributes. Improve needs 2 or more. Left out, Amdahl
                        picks up to 6 of your workspace's accounts.
  --channel email|linkedin  What the emails are.
  --context <file.json>     Your rules, facts and voice_examples, as JSON.
  --no-wait             Start the run, print its id and stop.
  --run <id>            Read a run started earlier, and wait for it.

The revised prompt goes to stdout; the grades and emails go to stderr. A lift
is shown only when it is reportable. Neither mode predicts replies. With --json
it prints {"ok", "file", "started", "result"}.
${GLOBAL}`,

  runs: `Usage: amdahl runs [--limit <n>]

List the latest runs made from this computer: the id, when, what kind (optimize,
grade or prompt) and the channel. Amdahl has no list of your runs on its side:
this is a list the CLI keeps of the ids it started, never their text. A run made
in the console or an AI client is not in it.

  --limit <n>   Show n runs (default 10).

Open one by its id with amdahl run <run-id>. With --json it prints {"ok",
"source", "note", "total", "runs"}.
${GLOBAL}`,

  run: `Usage: amdahl run <run-id>

Show one optimize run you made: your draft, then the message Amdahl returned,
what it left out and what context you sent. The id is the one amdahl optimize
printed (amdahl runs lists the latest). Only you can open your own runs. A
prompt run is read with amdahl prompt --run <id>.
${GLOBAL}`,

  data: `Usage: amdahl data [--surface interactions|deals|deal_qualification]

Show what this workspace holds: each surface's row count and the span of its
dates, then what a search can filter on. A count that could not be read says
unknown, never 0.

  --surface <name>   One surface's fields, each with its type, meaning and the
                     values it is known to hold.

With --json it prints {"ok", "overview", "fields"}.
${GLOBAL}`,

  recipes: `Usage: amdahl recipes

List the console's recipe library: the questions it asks as a search, by
category, with what each reads and the fill-in it needs. Run one with
amdahl search --recipe <id>. With --json it prints every recipe with its
question and fill-ins.
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

Give at least one of --outcome, --sent-text and --comment. At a terminal, what
you leave out is asked (two questions at most). With --json, in an agent or in
CI, nothing is asked: a missing flag is a usage error.
${GLOBAL}`,

  sent: `Usage: amdahl sent <run-id> --provider <provider> --channel <channel>
                   --sent-as returned|edited [--sent-at <time>]
                   [--provider-send-id <id>]
                   [--recipient <email|url> | --recipient-key-hash <sha256>]
                   [--provider-campaign-id <id>] [--sequence-step <n>]
                   [--provider-variant-id <id>] [--provider-lead-id <id>]
                   [--thread-id <id>] [--sent-text <file> | -]

Report that the system that sent a message sent it. One send per command; the
API takes up to 100 (POST /messages/report_send).

  --provider <name>   ${SEND_PROVIDERS.slice(0, 4).join(', ')},
                      ${SEND_PROVIDERS.slice(4, 8).join(', ')},
                      ${SEND_PROVIDERS.slice(8, 12).join(', ')},
                      ${SEND_PROVIDERS.slice(12).join(', ')}.
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
  --recipient-key-hash  A SHA-256 you made, instead of --recipient (not both).
  --provider-campaign-id, --sequence-step, --provider-variant-id,
  --provider-lead-id, --thread-id   The provider's ids, when you have them.
  --sent-text <file>  The text as sent (a file, or - for standard input). Only
                      a hash of it is kept.

Give at least one of --provider-send-id and a recipient (--recipient or
--recipient-key-hash, not both). A send id with a recipient is fine: Amdahl
matches a report to a send by the id, the recipient, or both.

At a terminal, what you leave out is asked (three questions at most): where it
went out, who it went to, and whether you changed it first. Without --channel
it picks the channel and prints it: email for an email address, linkedin for a
LinkedIn profile, else the run's, else a tool that sends one kind. Only when
none of these says (a tool that sends both, a send id and no recipient) it asks
what was sent. With --json, in an agent or in CI, nothing is asked: a missing
flag, --channel too, is a usage error.
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
