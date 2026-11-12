# @amdahl/cli

The `amdahl` command line. It signs you in with your console account, checks
that a workspace can optimize, rewrites messages one at a time or a whole
list at once, answers questions about your customers, calls and deals, shows
and adds connected sources, records what happened to a message after you
sent it, manages API keys (each one approved in the console), points MCP
clients at Amdahl, and installs skills from the library at
https://amdahl.ai/skills.

## Using the Claude or ChatGPT app? You do not need this CLI

The Claude and ChatGPT apps connect to the Amdahl Optimizer as a custom
connector, with no key and no terminal. The MCP server URL is
`https://app.amdahl.ai/mcp`.

In Claude (web or desktop):

1. Open Settings, then Customize, then Connectors
   (https://claude.ai/customize/connectors).
2. Click **+ Add**, then **Add custom connector**.
3. Name it **Amdahl** and set the URL to `https://app.amdahl.ai/mcp`.
4. Click **Connect**, sign in to Amdahl with your work email, and choose your
   workspace.
5. Open a new chat and turn on Amdahl in the **+** menu under Connectors. If
   Amdahl is not listed, reload the app (Cmd+R, or Ctrl+R on Windows).
6. Optional: in Amdahl's connector settings, set its tool access to
   **Always available**, so Claude does not have to search for its tools.
   Under **Tool permissions**, you can also set **Read-only tools** to
   **Always allow**. Writing a message is a write call, so Claude asks before
   each one unless you also allow the message tool, `optimize_message`
   (**Custom**, or **Write/delete tools** set to **Always allow**).
7. Name the server in your ask: "Use the Amdahl MCP server to optimize this
   draft: ...". Claude does not call Amdahl for a plain "make this better".

In the ChatGPT desktop app: open Settings, then Plugins, then **Add**, then
**Add MCP server**. Choose **Connect to a custom MCP**, name it Amdahl, set the
type to Streamable HTTP and the URL to `https://app.amdahl.ai/mcp`, save, then
click **Authenticate** and sign in. In Work mode, ask "Use the Amdahl MCP server
to optimize this draft: ...".

Full steps: https://amdahl.ai/connect

## Install

Needs Node.js 22 or later. Node.js 20 reached end of life in April 2026 and
gets no security fixes. `amdahl` still starts on it, but npm warns when it
installs. On a Node older than 20, `amdahl` stops before it does anything,
names the version it found, and links the Node.js download page.

```sh
# Run once, with no install
npx -y amdahl

# Or install the `amdahl` command
npm i -g @amdahl/cli
amdahl
```

`amdahl` is also on npm by its short name, so `npx amdahl ...` is the same as
`npx @amdahl/cli ...`. That package ([packages/amdahl](packages/amdahl)) has no
code of its own: it depends on `@amdahl/cli` at the same version and runs it.
npm asks "Ok to proceed? (y)" before every `npx` run of a package you have not
installed; `npx -y` skips that question, so every example here uses it.

The quickest way to start is `npx -y amdahl` with nothing after it (or
`npx -y amdahl setup`), in a terminal. It asks where Amdahl should work:

```
$ npx -y amdahl
Amdahl · predictive ML for GTM
Where should Amdahl work?
> [x] Claude Code   found on your machine
  [ ] Cursor
  [ ] Codex
  [ ] This terminal
↑↓ move · Space tick/untick · Enter continue
```

It finds Claude Code, Cursor and Codex by their command on your PATH
(`claude`, `cursor`, `codex`) or their files in your home folder (`.claude`
or `.claude.json`, `.cursor`, `.codex`). Only the ones it finds are ticked
and tagged "found on your machine" (in dim grey where colour is allowed).
"This terminal" is always there and never ticked for you. If it finds none
of the three, it says so under the question, points Claude and ChatGPT app
users to https://amdahl.ai/connect, and the marker starts on "This
terminal", so Space then Enter picks it:

```
Where should Amdahl work?
We didn't find Claude Code, Cursor or Codex on this computer.
Using the Claude or ChatGPT app? Connect it at https://amdahl.ai/connect
  [ ] Claude Code
  [ ] Cursor
  [ ] Codex
> [ ] This terminal
↑↓ move · Space tick/untick · Enter continue
```

The `>` marker starts on the first ticked row, and only the marker is
coloured, so the row under it never looks picked when it is not. Esc, `q`
or Ctrl+C stops with nothing changed (exit 130). The menu redraws in place
in any width, also in a split pane narrower than its lines, and `NO_COLOR`
or `--no-color` turn the colour off. Enter with nothing ticked changes
nothing and says how to try Amdahl: run it again and tick "This terminal",
or connect the Claude or ChatGPT app at https://amdahl.ai/connect.

### The AI tools: set up first, then one sign-in in the tool

For Claude Code, Cursor and Codex there is no sign-in in the terminal. The
setup writes each tool's config straight away (as `amdahl install` does), so
nothing is lost if you stop later, and then prints that tool's next steps.
Each tool signs in to Amdahl itself, over OAuth, the first time it connects;
that sign-in is also where a new user creates their free workspace. Each
screen is six lines or fewer:

```
✓ Added Amdahl to Claude Code.
One step left, in Claude Code:
  1. If it's open, quit and reopen it. Type /mcp, pick amdahl, sign in.
  2. Paste an email and say: "Use Amdahl to make this sound less like AI"
New to Amdahl? The sign-in sets up your free workspace.
```

```
✓ Added Amdahl to Cursor.
One step left, in Cursor:
  1. If it's open, quit and reopen it. In Customize > MCPs, sign in to amdahl.
  2. In chat, paste an email, say: "Use Amdahl to make this sound less like AI"
```

Cursor reads `~/.cursor/mcp.json` when it starts and lists its MCP servers
under Customize, then MCPs.

Codex runs in the same terminal, so with `codex` on your PATH the setup
offers to run its sign-in for you:

```
✓ Added Amdahl to Codex.
Press Enter to sign Codex in to Amdahl (opens your browser).
✓ Codex is connected.
Run codex, paste an email and say: "Use Amdahl to make this sound less like AI"
```

Enter runs `codex mcp login amdahl` on your terminal (it prints the link and
opens the browser). Ctrl+C there skips it and names the command to run
later; if the sign-in does not finish, it says so and names the same
command. Without `codex` on your PATH, and always on Windows (where `codex`
is a `.cmd` file the CLI cannot start without a shell), the screen lists
`codex mcp login amdahl` as step 1. With more than one tool, the screens follow one another
and the "New to Amdahl?" line is printed once. A tool that fails (a broken
`~/.cursor/mcp.json` or `~/.claude.json`, say) prints its error, the rest
still run, and the exit code is the first failure's. In a terminal narrower
than a screen's lines, they break between words, and a numbered step's next
line starts under its text.

### This terminal: try it on a message

Pick "This terminal" (alone or beside the tools, which are set up first) to
see Amdahl work right away. It signs you in through the browser if you are
not signed in yet, then asks for a message:

```
✓ Signed in · Acme
Paste an email or LinkedIn message, then press Enter on an empty line:
<your draft>
Amdahl is rewriting it. This can take a minute.
── Amdahl's version ──────────────
<the rewritten message>
Cut the opener and 2 sentences nothing backed.
Next time: npx -y amdahl optimize draft.txt,
or pbpaste | npx -y amdahl optimize -
```

Empty lines inside a paste stay in the message: the terminal marks a paste
(bracketed paste), and where it does not, an empty line that more text
follows at once counts as pasted. Ctrl+D also ends the message. The lines
under Amdahl's version say what it did, as `amdahl optimize` does. The
`pbpaste` line is printed on macOS only.

While it waits for the browser, it prints one short line under "Opening
your browser…". In a terminal that shows links (iTerm2, VS Code, Warp,
Terminal, WezTerm, Ghostty, Windows Terminal, VTE 0.50 or later) it reads
"Browser didn't open? Open the sign-in page" and the last words are a link;
elsewhere it says to press Enter for the link. `FORCE_HYPERLINK=1` or `0`
overrides the guess, and `NO_COLOR` turns the link off. Either way, Enter
prints the full sign-in link once. Once you are signed in, that line is
replaced by `✓ Signed in`. If the browser could not be opened, or with
`--no-browser`, the full link prints at once. It waits up to 15 minutes, so
someone new can create their workspace on the way and land back in the same
setup. If the server rejects a key set in `AMDAHL_KEY` (or `AMDAHL_API_KEY`,
`AMDAHL_ACCESS_TOKEN`, `--api-key`), it says so, skips the browser sign-in
(that key would still win) and exits 3. Ctrl+C during the sign-in or the
paste stops with exit 130; if tools were set up first, it says they still
are.

### Run it again

When every tool it finds already points at Amdahl, it asks nothing, needs no
network and signs in nowhere. It says so, with the one thing to try and how
to finish the tool's sign-in if you have not yet:

```
Amdahl is in Claude Code. You're all set.
Paste an email there and say: "Use Amdahl to make this sound less like AI"
If you've already run /mcp, you're done.
If not: quit and reopen Claude Code, type /mcp, pick amdahl, sign in.
Want to try it here instead? Run: npx -y amdahl optimize
```

If you are already signed in here (a saved `amdahl login` for this API host,
or a key in `--api-key` or the environment), the last line is replaced by
what to do next in this terminal:

```
Try it here: amdahl optimize or amdahl search "your question"
Add data: amdahl connect, see it all: amdahl open
```

It still reads nothing from the network. An agent's run and a run with no
terminal print exactly what they did before.

An old copy of the Amdahl skill is brought up to date on the way. A tool it
finds that does not point at Amdahl yet brings the menu back.
`npx -y amdahl --verbose` also prints the files it wrote, the profile and
where the sign-in is stored.

### Run by an agent, or with no terminal

You can ask Claude Code, Cursor or Codex to run `npx -y amdahl` for you. With
no terminal (an agent's shell, a pipe such as `npx -y amdahl | cat`, or stdin,
stdout or stderr redirected), and whenever `CLAUDECODE` or `CURSOR_AGENT`
is set, it sets up without a question and without a browser sign-in:

- `CLAUDECODE` set (Claude Code runs it): Claude Code only.
- `CURSOR_AGENT` set (Cursor runs it): Cursor only.
- Anything else (Codex sets no variable): every client it finds.

In Codex's default sandbox, writes outside the workspace and network access
are blocked, so the run usually fails (`npx` cannot fetch the package, or
`Could not update ~/.codex/config.toml`, exit 1) unless you approve the
escalation Codex asks for, or run `npx -y amdahl` in your own terminal.

Each client signs in on its first connect, over OAuth, so the CLI needs no
sign-in of its own here. The last lines say what to try and the one step
that connects each client:

```
✓ Added to Claude Code
Try it: paste an email and say "Use Amdahl to make this sound less like AI" in Claude Code.
Before that, restart Claude Code and run /mcp once to connect Amdahl.
```

Run from inside Claude Code, the step is "restart Claude Code and run /mcp
once", since a running session may only see the new server after a
restart. If
it finds no client, it says so on stderr, names `npx -y amdahl install
claude-code`, writes nothing and exits 1.

**Exit code change in 0.3.4.** Before 0.3.4, bare `amdahl` with no terminal
or with `CLAUDECODE` or `CURSOR_AGENT` set printed the usage and exited 2.
It now sets up as above and exits 0 (1 when nothing was found or a client
failed). In CI, with `AMDAHL_NO_PROMPT=1`, or with `--json`, bare `amdahl`
still changes nothing, exits 2 and prints the usage to stderr, now after one
line that says why and names `amdahl install`. CI means one of `CI`, `JENKINS_URL`, `TF_BUILD`,
`CODEBUILD_BUILD_ID`, `TEAMCITY_VERSION`, `GITHUB_ACTIONS`, `GITLAB_CI`,
`BUILDKITE` or `CIRCLECI` is set (other than `false` or `0`), or
`BUILD_NUMBER` is set together with `JENKINS_HOME`.

When the CLI was started by `npx`, every message that names a command says
`npx -y amdahl ...` (for example `npx -y amdahl login`), since an `npx` user
has no `amdahl` on their PATH, and `-y` skips npm's question.

To connect one AI client yourself, run `amdahl install claude-code` (or `codex`,
`cursor`). It adds the Amdahl MCP server and also installs the Amdahl skill,
a map of everything Amdahl can do, so your agent knows which tool fits each
job. If the client already points at Amdahl, `install` leaves that as it is
(for Claude Code it skips `claude mcp add` when `~/.claude.json` or `claude
mcp get amdahl` shows the same URL) and still installs the skill.

For Claude Code it runs `claude mcp add --scope user --transport http amdahl
https://app.amdahl.ai/mcp`. The desktop app and the IDE extensions often
leave no `claude` on your PATH, so it also looks in `~/.local/bin`,
`~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin` and npm's global
bin. If none has `claude`, it writes the same entry into Claude Code's user
settings itself: `mcpServers.amdahl` set to `{"type": "http", "url":
"https://app.amdahl.ai/mcp"}` at the top level of `~/.claude.json` (in
`CLAUDE_CONFIG_DIR` when that is set). It keeps every other key, saves the
file as it was to `~/.claude.json.amdahl-backup` first, writes the new file
to a temp file and renames it into place (following a symbolic link), and
changes nothing when the entry is already there. A file that is not a JSON
object is left alone (exit 1, `invalid_config`). Cursor's and Codex's config
files are also written whole through a temp file. A symbolic link at
`~/.claude.json` is followed to its target, even one not created yet, and
stays a link. An `mcpServers` that is not a JSON object (an array, say) in
`~/.claude.json` or `~/.cursor/mcp.json` is left alone with `invalid_config`,
found before the setup writes anything. If it cannot write the client's config file, it
exits 1 with `write_failed` and names the file. The skill goes to the
client's user skills folder:

| client | skill file |
|---|---|
| Claude Code | `~/.claude/skills/amdahl/SKILL.md` |
| Codex | `~/.agents/skills/amdahl/SKILL.md` |
| Cursor | `~/.cursor/skills/amdahl/SKILL.md` |

If that file is a copy an earlier `amdahl install` wrote, `install` replaces it
with the current skill. If it differs from every skill the CLI has shipped (you
changed it), `install` keeps your copy and says so; add `--force` to replace
it. `--print` shows what it would run and the path it would write, without
changing anything. The same map is published at
https://docs.amdahl.ai/skills/amdahl/SKILL.md.

## Quick start

```sh
amdahl                       # guided setup for Claude Code, Cursor and Codex, or try it here (an agent can run it too)
amdahl login                 # sign in through the browser with your console account
amdahl whoami                # the account, workspace and role you are signed in as
amdahl status                # can this workspace optimize, and what blocks it
amdahl optimize draft.md     # rewrite one message (or pipe it in with -, or run it bare and paste)
amdahl optimize --list drafts.csv   # rewrite a whole list in one batch
amdahl search "what objections came up in lost deals?"   # ask about your customers
amdahl connections           # what is connected, and whether it is healthy
amdahl connect hubspot       # open the console's add page, to add a CRM or call recorder
amdahl open                  # open this workspace in the console
amdahl feedback <run-id> --evidence did_it_myself --outcome used   # what happened to it
amdahl sent <run-id> --provider gmail --channel email --sent-as returned --provider-send-id "<msg-id@mail>"   # it went out
amdahl install claude-code   # connect an AI client and add the Amdahl skill (also codex, cursor)
amdahl skills add <publisher>/<skill>   # add a skill from amdahl.ai/skills to this project
```

No workspace yet? With a work email, the sign-in page offers to create your
company's workspace and then finishes signing you in. If you signed in with
an address Amdahl can't use, the browser tab and the terminal say what to do
and link a new sign-in ("Sign in with your work email", "Sign in again" for
a subdomain address, "Try again" once you've confirmed your email), and the
terminal keeps waiting for it. Anything
else exits 5 with the one next step (ask your company's admins, try again
tomorrow, and so on). The CLI itself never creates or joins a workspace.

`amdahl login` ends with the next step: `amdahl optimize` to try a pasted
message, or bare `amdahl` to add Amdahl to Claude Code, Cursor or Codex.

`amdahl optimize` with no file, at a terminal, asks you to paste the message
(as the setup's "This terminal" does) and signs you in through the browser
first if you are not signed in ("Sign in first, then paste your message."). With stdin piped, or `-`, it reads stdin
whole as before. At a terminal it still says to give a file (exit 2) when
an agent runs it (`CLAUDECODE` or `CURSOR_AGENT` set), in CI (the same
variables bare `amdahl` checks) or with `AMDAHL_NO_PROMPT=1`: none of them
can paste.

On a server or in CI, skip `login` and set an API key in `AMDAHL_KEY`.

## Commands

```
amdahl  [--no-browser]                                           (guided setup; also: amdahl setup)
amdahl help                                                      (same as --help)
amdahl login   [--workspace <slug>] [--no-browser] [--port <n>]   (alias: auth login)
amdahl logout  [--all]                                           (alias: auth logout)
amdahl whoami  [--show-token]                                    (alias: auth status)
amdahl auth token
amdahl status
amdahl optimize [<file>... | -] [--channel email|linkedin] [--evidence off|workspace]
                [--on-unsupported flag|remove] [--tries] [--context <file.json>]
amdahl optimize --list <file.csv|file.jsonl> [--no-wait] [--batch <id>] [--force] [the optimize flags]
amdahl search "<question>" [--research] [--limit <n>]
amdahl connections [--all]
amdahl connect [<connector>] [--no-browser]
amdahl open [--no-browser]
amdahl feedback <run-id> --evidence did_it_myself|reported_to_me|inferred
                [--outcome used|used_with_edits|not_used|unsure] [--sent-text <file>|-] [--comment <text>]
amdahl sent <run-id> --provider <provider> --channel <channel> --sent-as returned|edited
                (--provider-send-id <id> | --recipient <email|url> | --recipient-key-hash <sha256>)
                [--sent-at <time>] [--provider-campaign-id <id>] [--sequence-step <n>]
                [--provider-variant-id <id>] [--provider-lead-id <id>] [--thread-id <id>]
                [--sent-text <file>|-]
amdahl keys create --name <name> [--preset read-only|agent|internal|admin] [--expires 30d|90d|365d] [--no-browser]
amdahl keys list
amdahl keys revoke <id|prefix> [--yes] [--no-browser]
amdahl workspace list | amdahl workspace use <profile>
amdahl install claude-code|codex|cursor [--print] [--force]
amdahl skills add <publisher>/<skill> [-g] [--agents] [--force] [--accept-warning] [--site <origin>]
```

Global flags: `--profile`, `--api-url`, `--api-key`, `--json`, `--no-color`,
`--verbose`, `-h`, `-v`. With `--json`, data goes to stdout and messages to
stderr. An unknown option prints `Unknown option --foo.` and `Run \`amdahl
--help\`.` (exit 2).

## Search

```sh
amdahl search "What objections came up in lost deals last quarter?"
```

`search` asks one question about the workspace's customers, calls and deals
(`POST /search/query`, with `answer: true`). It prints a short answer, with
each citation said in plain words, and the rows it came from under `From:`,
at most five. With no written answer it prints up to ten rows. Each row is
one line (its title, who and when) and up to three lines of its quote (the
row's `content_preview`, or its text), in 80 columns. `--limit <n>` asks for
at most `n` rows, and `--json` prints the server's whole answer, every row
included.

When the server found rows but wrote no answer over them (`not_enough_data`),
the CLI says so plainly before the rows: "Amdahl couldn't answer that from
these rows. Try rephrasing the question, or run `amdahl connections` to see
whether your data is synced." The rows follow under `Rows it read:`. A
failed answer says it found rows but could not write an answer.

The CLI sends the question as you typed it. A window such as "last month" is
read by the server from the words (the previous calendar month, in UTC); the
request has no separate field for a time window.

Research is something search starts, never a command of its own. Search
hands a statistical or long question to a research job by itself, and
`--research` asks it to (`route: "research"`). The CLI then waits for the
job (`GET /research/:id`, 45 seconds a read, up to 15 minutes) and prints its
cited answer, then what the answer rests on under `Details:` (its
`content_blocks`, in the order the job presented them), then up to three
questions to ask next.

Each table prints as a plain ASCII table that fits 80 columns: a long cell
wraps (a column is narrowed to its longest word first, so an id or a timestamp
stays whole), a cell past four lines is cut with `...`, a word wider than its
column is split with a `-`, and a table with more columns than 80 columns hold
prints each row as `label: value` lines, so no column is dropped. A table
prints at most 25 rows and counts the rest. Text, callout, citation, metric and
theme blocks print as plain text (an `<unverified>` figure is marked
`(unverified)`). A chart prints one line that says so, and so does any block
type this version does not know: both point to `--json`, where the whole block
is. Starting research needs
`conversations:write` and reading it back `conversations:read`. A CLI
sign-in has neither, so the server runs the search instead. The CLI says so
first, before any row:

```
Research needs a Customer agent key: amdahl keys create --name research --preset agent. Here is the search answer instead.
```

A workspace with nothing connected answers with `setup_needed`: the CLI
prints its message, which carries the console link, then
`Connect your CRM or call recorder: amdahl connect`. With no rows, it prints
the server's one line on how fresh the data is, or `Nothing matched.`

## Connections

```sh
amdahl connections
```

```
HubSpot             crm    healthy        synced 2026-11-11
Gong (Sales calls)  calls  needs sign-in  never synced
Sign in to it again: https://console.amdahl.ai/acme/connections/c1
```

`connections` lists what the workspace has connected (`GET /connections`),
each with its health in words and its last sync. Under the list, one line
says where to fix what needs attention: the one connection's console page,
or the Connections page when there are several. `--all` also lists
disconnected and never-synced sources. With nothing connected it says so and
names `amdahl connect`.

`amdahl connect hubspot` checks the connector against the catalog
(`GET /connections/catalog`; a type or a name, in any case), then opens the
console's add page,
`<console>/<workspace>/settings/connections?add=1&connector=hubspot`. The
`connector` only fills the search box on that page: you pick HubSpot there and
sign in to it. With no connector it opens the add page with an empty search
box. If that connector is already connected and healthy, the CLI says so
first ("HubSpot is already connected and healthy (last sync 2026-11-11).")
and prints the add page instead of opening it; one that needs attention gets
its own console page. The CLI never creates a connection itself. An unknown connector exits 2
and lists the ones you can connect; one that is not offered yet exits 1 and
says it is coming soon. It opens the browser only for a person at a terminal:
stdin and stdout are terminals, `AMDAHL_NO_PROMPT=1` is not set, no agent runs
it (`CLAUDECODE`, `CURSOR_AGENT`), it is not CI and there is no `--json`. So
`amdahl connect hubspot | cat` opens nothing. Everywhere else, with
`--no-browser`, or when the browser does not open, it prints the link on
stdout instead (under `--json`, as `url` with `opened: false`).

`amdahl open` opens this workspace in the console (the console home when you
are not signed in), on the same terms. `--no-browser` prints the link.

## Optimize a list

```sh
amdahl optimize --list drafts.csv
```

```
Queued 40 messages as batch 7c1e....
Ctrl+C stops waiting, not the batch. To pick it up later: amdahl optimize --list drafts.csv --batch 7c1e...
12 of 40 done, about 3 min left
40 of 40 messages optimized.
Results: drafts.optimized.csv
```

`--list` sends a whole list as one batch (`POST /messages/optimize/batch`),
which the server runs on spare capacity and never refuses as busy, then
reads it back (`GET /messages/optimize/batches/:id`) until it completes. A
file given without `--list` is still one message, as before.

The list is a CSV file with a header row, or a JSONL file (`.jsonl` or
`.ndjson`) with one batch item, a JSON object, per line. A CSV has a
`message` column and may have `item_id`, `channel`, `evidence`,
`on_unsupported`, `facts` and `rules`; facts and rules take one per line
inside the cell. Any other column (a CRM export has many) is not sent: one
line names it, and it is copied to the results file in its place. Only a
missing `message` column is refused. A JSONL item takes any field a single
optimize takes, and the server refuses a key it does not know. The optimize flags (`--channel`,
`--evidence`, `--on-unsupported`, `--tries`, `--context`) apply to every
item that does not set its own; a row's facts and a `--context` file's rules
and voice examples are both sent.

The whole file is read and checked first. A missing `message` column says
which columns it reads. Progress goes to stderr, in place at a terminal: a
queued batch says it is queued, and each line after that says where it stands
once. When the batch completes, the results go next to the list: `drafts.csv`
gets `drafts.optimized.csv` (every input column in its original order, then
`optimized_message`, `status`, `summary`, `run_id` and `error`; a column of
yours with one of those names keeps it, and Amdahl's takes `amdahl_` in
front), and
`x.jsonl` gets `x.optimized.jsonl` (one batch item per line, its `result`
what a single optimize returns). With `--json`, the batch and every item go
to stdout and no file is written. A failed item exits 1. A refused list
names the line of the first item the server refused.

A spreadsheet runs a cell that starts with `=`, `+`, `-` or `@` as a formula,
so in the results CSV such a cell (and one that starts with a tab or a
carriage return) starts with a `'`. The CLI does not replace a results file
that already exists: it exits 2 before it queues anything, and `--force`
replaces the file.

`--no-wait` queues the batch, prints its id and the command that picks it up,
and exits. `--batch <id>` picks up a batch queued earlier; with `--list`, the
results go next to that list and the list must have as many messages as the
batch has items (exit 2 otherwise), otherwise they go to `<id>.optimized.jsonl`
here. `--no-wait` with `--batch` exits 2: it only queues a new list.

## After you send

```sh
amdahl feedback <run-id> --evidence did_it_myself --outcome used_with_edits --sent-text sent.txt
amdahl sent <run-id> --provider gmail --channel email --sent-as edited --sent-text sent.txt --provider-send-id "<msg-id@mail.gmail.com>"
```

`feedback` says what happened to the message one optimize run returned
(`POST /messages/optimize/runs/:id/feedback`). `--evidence` is required:
`did_it_myself`, `reported_to_me` or `inferred`. Send at least one of
`--outcome` (`used`, `used_with_edits`, `not_used`, `unsure`), `--comment`
(the sender's own words) and `--sent-text` (a file with the text as sent, or
`-` for stdin). Amdahl learns the sender's preferences from an edit, unless
the evidence is `inferred`. Each call stores one event, so running it twice
stores two.

`sent` is for the system that sent the message: it reports that it went out
(`POST /messages/report_send`). A report from a CLI sign-in is stored as
`reported_via: cli`. The flags are the report's fields: `--provider`
(`lemlist`, `instantly`, `outreach`, `salesloft`, `hubspot`, `salesforce`,
`gmail`, `heyreach`, `apollo`, `linkedin_manual`, `other`; the server's
list, so use `other` for a sender that is not on it), `--channel` (`email`,
`linkedin_invite`, `linkedin_message`, `linkedin_inmail`; `linkedin` is
accepted and means `linkedin_message`, as in `amdahl optimize --channel`),
`--sent-as` (`returned` or `edited`) and `--sent-at` (a time with a time
zone; the current time when left out), then the optional ids. `--sent-as
edited` needs `--sent-text`, the message as you sent it (Amdahl keeps only a
hash of it). That is the CLI's rule, not the server's. A run id given twice,
or two run ids, exits 2.

The server stores a report only when it can tell which send it is, so one of
`--provider-send-id`, `--recipient` (an email address, or a LinkedIn profile
URL for a LinkedIn channel) or `--recipient-key-hash` (a SHA-256) is required.
A campaign, a lead and a step are not enough. Without one, the CLI exits 2
before it sends anything. The id is the provider's own: for gmail, the
`Message-ID` header with its angle brackets; never an email address (give that
as `--recipient`; Amdahl stores only a hash of it). The command reports one
send, so give one run id. To report many at once, call
`POST /messages/report_send`, which takes up to 100 items. Give `--recipient`
or `--recipient-key-hash`, not both: the server refuses the pair as
`invalid_recipient`, so the CLI exits 2 first. `--sent-at` needs an uppercase
`T` and `Z`, as the server does. The CLI checks each value against the
server's limits first, and a mistake is a usage error that names the flag. It
counts a text's length as the server does, in UTF-16 units, so an emoji counts
as two. A send the server did not store prints why and exits 1.

## Next steps

Human output names the next step where there is one, in at most two extra
lines; `--json` never carries them.

- `amdahl optimize` on a workspace with no data connected ends with
  `Connect calls or a CRM so Amdahl checks claims against them: amdahl connect`.
  The CLI asks `GET /setup/status` beside the first rewrite, so it adds no
  wait, and says nothing when it cannot tell. Only a person at a terminal
  gets the line and the request (the same test as `optimize` with no file): a
  pipe, an agent, CI, `AMDAHL_NO_PROMPT=1` and `--json` make exactly the
  requests they made before.
- `amdahl status` gives each blocked item its fix: no data, `amdahl connect`;
  a connection that needs attention, its console page; a used-up quota, the
  day it resets; a role too low, ask a workspace admin.
- Bare `amdahl`, signed in, with every tool set up: what to try here.
- After an optimize (one file, a pasted message, or a list) a line says what
  to do once the message is sent: `Sent it? amdahl sent|feedback <run-id>`,
  with the run's own id. A list prints the first run id of its results.
- `amdahl optimize` no longer prints the server's `what_changed` line. It is
  the same sentence on every run. It is still in `--json`.

## Help and errors

`amdahl <command> --help` (also `-h`, or `amdahl help <command>`) prints that
command's usage and nothing else: its flags, what it prints, and its exit
codes where they matter. `amdahl keys --help` lists the `keys` commands. For
`optimize --json`, the help says where the message is: `.result.message`, and
the run id is `.result.run_id`.

Three failures print one plain line each:

- A credential that lacks a scope says what it cannot do and what to use:
  `This credential cannot optimize.` then `Use a Customer agent key, or run
  \`amdahl login\` again.` (exit 4). It never prints the server's
  `Missing required scope(s)`.
- A key the server will not take (revoked or expired): `This key isn't valid
  (revoked or expired). Unset AMDAHL_KEY, then run amdahl login.` (or `Drop
  --api-key` for a key from the flag; exit 3). A sign-in it will not take:
  `Your sign-in is no longer valid. Run amdahl login.`
- A file that is not there: `Can't find <file>.` (exit 2), for a draft, a
  list, `--context` and `--sent-text`.

## Skills

`skills add` installs one skill from the library at https://amdahl.ai/skills.
It needs no sign-in.

```sh
npx -y amdahl skills add <publisher>/<skill>
# the skill's link works too, with or without .md:
npx -y amdahl skills add https://amdahl.ai/skills/<publisher>/<skill>
```

In a terminal, it asks one question. It prints `Checking <publisher>/<skill>
on amdahl.ai... OK` while it downloads and checks the skill. Then it names
the skill and the agents it sees in use, and asks where to install it, in a
menu:

```
System diagram, by Amdahl (17 files), for Claude Code and Cursor.
Install it in:
> This project (~/proj)
  Every project on this computer
(Use the arrow keys, then Enter)
```

Up and Down (or `k` and `j`) move the marker; typing `1` or `2` jumps to
that row. Enter picks, and the menu shrinks to one line, such as
`Install it in: This project (~/proj)`. The marked row is in the brand
colour, or bold when colour is off (`--no-color`, `NO_COLOR`, `TERM=dumb`).
The pick is the go-ahead: it installs, prints the folders it wrote, and
says to open a new chat. In your home folder it does not ask, and installs
for every project. Ctrl+C stops it with nothing written (exit 130).

It never asks about agents. A `.claude` folder here or in your home folder,
or `CLAUDECODE` set, means Claude Code (`.claude/skills`). A `.codex` folder
means Codex, a `.cursor` folder or `CURSOR_AGENT` means Cursor, and an
`.agents` folder means other agents (all `.agents/skills`). When it sees
both kinds, or neither, it writes both folders. To choose yourself, use the
flags below.

If a different copy of the skill is already there, it asks once more, in
the same kind of menu: "Keep your copy" (where the marker starts) or
"Replace it". With `--force` it replaces it without asking.

It never asks when stdin or stdout is not a terminal (an agent, CI, a pipe),
or with `--json`, `-y`, `-g` or `--agents`, or with `AMDAHL_NO_PROMPT=1`.
Then the flags say where. Without `--agents`, it uses the folder of the agent
that ran it, when that agent says so: Claude Code sets `CLAUDECODE`
(`.claude/skills`), Cursor sets `CURSOR_AGENT` (`.agents/skills`). Codex
documents no such variable, so a run from Codex gets the default, Claude
Code. Without flags it says on stderr where the skill went. `-y` (`--yes`)
adds it to this project without asking. Neither replaces a different copy
without `--force`.

amdahl.ai's AI security review flags some skills. A flagged skill's index
entry carries an `x-amdahl-warning` field. `skills add` prints it before it
writes anything: the skill, the sentence from the skill page, and the page's
link.

```
Warning: amdahl.ai's security review flagged amdahl/call-prep.
  Flagged: it may send your data somewhere else (line 14), and 2 more. Read it before you install.
  See what was flagged: https://amdahl.ai/skills/amdahl/call-prep
```

In a terminal, it then asks `Install this skill?` in the same kind of menu.
The marker starts on "Cancel", which writes nothing and exits 0. "Install
anyway" goes on as usual. With `-y`, `--json` or no terminal, it does not
install the skill. It does not ask an agent either, even in a terminal: when
`CLAUDECODE` or `CURSOR_AGENT` is set, it does not install. It says to show
the warning to the person, and exits 9. Once they agree, run the same
command again with `--accept-warning`: it prints the warning and installs. With `--json`, the result or the refusal
carries the warning as `warning`, with `result`, `flagged`, `line`, `text`
and `page`.

It treats every field of the warning as untrusted. It turns line breaks in
the sentence into spaces, removes control, escape and format characters, and
cuts the sentence at 300 characters. It keeps `line` only as a positive
integer, and `flagged` only as a plain id.

The site sends the field only for a flagged skill. So when the field is
there but `skills add` cannot read it (it is not an object, its `result` is
not `warn` or `fail`, or it has no sentence), the skill is still flagged. It
prints the sentence "amdahl.ai flagged this skill. This version of the CLI
could not read why." and holds the install the same way. Only a missing
field, or `null`, means no warning.

It reads the skill's index,
`https://amdahl.ai/skills/<publisher>/<skill>/.well-known/agent-skills/index.json`
([Agent Skills Discovery](https://schemas.agentskills.io/discovery/0.2.0/schema.json)
v0.2.0). The index lists one of two kinds of skill:

- `type: "skill-md"`: one SKILL.md. `skills add` downloads it.
- `type: "archive"`: a folder (the SKILL.md plus scripts, references and
  other files), as one `.tar.gz`. `skills add` downloads it and unpacks it
  with its own reader. It never runs `tar`.

It refuses the download, and writes nothing, unless all of these are true:

- The index points at a file on the same site.
- The sha256 of the downloaded bytes equals the index's `digest`. This is
  checked before anything in an archive is read. The index and the file come
  from the same site, so this only catches a corrupted or cut-off download.
  It is not a signature and does not show the file is unchanged: that rests
  on HTTPS and on who can publish to amdahl.ai/skills.
- The SKILL.md front matter parses as YAML, `name` is a string, and
  `description` is a string that is not empty.
- `name` equals the skill's name in the index.

An archive must also be a plain folder. `skills add` refuses it if:

- the gzip CRC-32 or length does not match, or bytes follow the gzip data;
- a tar header has a wrong checksum, is not ustar, or the tar has no end;
- a path is absolute, holds `..`, `.` or an empty segment, a backslash or a
  control character, or two entries share a path (also when only the
  case differs);
- an entry is not a file or a folder (a link, a device, a pax header);
- a file mode is not 0644 or 0755;
- it has more than 200 files, or more than 4 MB of file contents;
- SKILL.md is not at its root.

Without the questions, the flags say where it writes, and it prints each
path it wrote:

| flag | where |
|---|---|
| (none) or `-y` | `./.claude/skills/<name>/`, for Claude Code in this project |
| `-g`, `--global` | `~/.claude/skills/<name>/`, for every project |
| `--agents` | also `.agents/skills/<name>/` (in this project, or in `~` with `-g`), which Codex, Cursor and most other agents read |

A `skill-md` skill writes `SKILL.md` in that folder, exactly as downloaded,
through a temp file renamed into place. It refuses, even with `--force`, when
the skill folder, the `skills` or `.claude`/`.agents` folder above it, or
`SKILL.md` itself is a symbolic link, so it never writes outside that folder.
An `archive` skill unpacks into a hidden temp folder beside each target,
then renames it into place only when every target is complete. If any step
fails, it removes what it unpacked and puts back any folder it replaced.

If a different file or folder with that name is already there, `skills add`
stops before it writes anything. Add `--force` to replace it. For a folder
skill, `--force` replaces the whole folder, with any files you added to it.
A skill that is already identical is left as it is.

It sends two requests, both to amdahl.ai: the index, then the file. It
follows no redirect and sends no telemetry. It waits at most 15 seconds for
each request. It refuses an index over 256 KB, a SKILL.md over 64 KB (the
most amdahl.ai accepts) and an archive over 4 MB. Each refusal writes
nothing. `--site <origin>` sends both requests to another origin, for
example a local copy of the site (`--site http://localhost:6782`). The
origin must be `https`; `http` is allowed only for localhost.

## Feedback link

Without `--json`, `amdahl optimize` ends each run with its run id:

```
Run: 3f2c8a1e-...
```

Under `--json` the run id is in `result.run_id` and nothing extra prints.

Amdahl staff can opt in to a feedback link after the run id. The link opens the
run's internal page in the Amdahl console, which only staff can see. It is off
by default. To turn it on:

- Set `"feedbackLink": true` at the top level of the config file
  (`${XDG_CONFIG_HOME:-~/.config}/amdahl/config.json`, or
  `%APPDATA%\amdahl\config.json` on Windows).
- Or set `AMDAHL_FEEDBACK_LINK=1` for one command or shell.
  `AMDAHL_FEEDBACK_LINK=0` turns it off even when the config turns it on.

The link uses the console for your API host (see
[Targeting staging](#targeting-staging)).

Every request to the Amdahl API sends the headers
`X-Amdahl-Client: cli/<version>` and `User-Agent: amdahl-cli/<version>`, so
Amdahl can tell which runs came from the CLI. The headers are only labels. It never changes what a credential can do.

## Targeting staging

```sh
AMDAHL_API_URL=https://staging.amdahl.ai amdahl login
# or: amdahl login --api-url https://staging.amdahl.ai
```

A profile remembers its API host, so later commands need no flag. A profile's
token is only ever sent to that host. Messages that link to the console use
`AMDAHL_CONSOLE_URL` when set, otherwise the console for the known API host
(`staging.amdahl.ai` -> `https://stagingui.amdahl.ai`, otherwise
`https://console.amdahl.ai`).

## Credentials

Highest first: `--api-key`, `AMDAHL_KEY`, `AMDAHL_API_KEY`,
`AMDAHL_ACCESS_TOKEN`, then the stored sign-in (`--profile`, `AMDAHL_PROFILE`,
the default profile). `whoami` names the source that won. `keys create`,
`keys revoke` and `auth token` need the stored sign-in and exit 4 otherwise.

- Config: `${XDG_CONFIG_HOME:-~/.config}/amdahl/config.json` (mode 0600). No
  tokens.
- Tokens: the OS keychain (service `amdahl-cli`; macOS `security`, Linux
  `secret-tool`), passed on stdin, never on argv. Without a keychain:
  `credentials.json` (mode 0600), named under `--verbose`. If that file is
  ever readable by other users, the CLI makes it owner-only and warns.
  `AMDAHL_CREDENTIAL_STORE=keychain|file` forces either.

## Keys

`keys create` generates the key on your machine and sends only its sha256 hash
and 14-character prefix. You approve the request in the console by typing the
code shown in the terminal; then the key is printed once and stored nowhere.

## Exit codes

| code | meaning |
|---|---|
| 0 | ok |
| 1 | general (`login_timeout`, `state_mismatch`, optimize `ok: false`, a failed item in `optimize --list`, a send `sent` could not store, research that failed or is still running, a `skills add` refusal, `invalid_config`, bare `amdahl` with no terminal that found no client) |
| 2 | usage (also bare `amdahl` in CI, with `AMDAHL_NO_PROMPT=1` or with `--json`) |
| 3 | not signed in (401, `invalid_grant`, no credential) |
| 4 | forbidden (403, `oauth_required`, `cli_client_required`, `not_admin`, `missing_scope`; also research that started but this credential cannot read) |
| 5 | no workspace |
| 6 | rate limited or quota (429) |
| 7 | approval denied, expired or locked out |
| 8 | network or 5xx |
| 9 | `skills add` did not install a skill amdahl.ai's security review flagged: no terminal to ask, `-y`, `--json` or an agent ran it, and no `--accept-warning` (nothing was written) |
| 130 | stopped with Ctrl+C (or Esc or `q` in a menu) at a question: "Stopped. Nothing changed." (in the setup, after tools were set up: "Stopped. Amdahl is still set up in …") |

## Development

Needs Node.js 22 or later and pnpm 9 (`corepack enable` picks up the version
pinned in `package.json`).

```sh
pnpm install
pnpm build         # dist/amdahl.js, one file, no runtime deps
pnpm test          # vitest, against a local mock server
pnpm type-check
pnpm smoke:pack    # pack both packages, install offline, run --help and --version
pnpm sync:skill    # refresh skill/SKILL.md from docs.amdahl.ai (and skill/shipped.json), then commit both
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues as described in
[SECURITY.md](SECURITY.md), not in public issues.

## Releases

`.github/workflows/publish.yml` publishes to npm. To release:

1. In a PR, bump the version in `package.json` and `src/version.ts` together,
   and in `packages/amdahl/package.json` both its `version` and its
   `@amdahl/cli` dependency. The workflow refuses a version that does not
   match the first two, or one that is already on npm; a test checks the third.
2. After it merges, push a tag `cli-v<version>` (for example `cli-v0.2.0`). A
   version with a `-` (for example `0.2.0-rc.1`) goes to the `next` dist-tag;
   anything else goes to `latest`.

The workflow type-checks, tests, builds and packs, runs the tarball's `--help`
and `--version` from an empty directory, and then publishes that same tarball.
You can also run it by hand from the Actions tab: a manual run is a dry run
(`npm publish --dry-run`) unless you clear `dry_run`.

Publishing uses npm [trusted publishing](https://docs.npmjs.com/trusted-publishers):
the publish job authenticates to npm with a short-lived GitHub OIDC token in
the `npm` environment, so no long-lived npm token is needed. Every release
carries a signed [provenance attestation](https://docs.npmjs.com/generating-provenance-statements)
that links the package on npm to the commit and workflow run that built it.
Check it with `npm audit signatures` or on the package page on npmjs.com.

The workflow publishes `amdahl` (the short name) right after `@amdahl/cli`,
from the same run, only when the repository variable `NPM_PUBLISH_AMDAHL` is
`true`. Amdahl already holds the `amdahl` name on npm (a 0.0.1 placeholder
with no bin), so trusted publishing can be set up for it now. Before you push
the tag:

1. On npmjs.com, `amdahl`, Settings, add a trusted publisher: GitHub Actions,
   `amdahlco/amdahl-cli`, workflow `publish.yml`, environment `npm`.
2. Set the repository variable `NPM_PUBLISH_AMDAHL` to `true`.

Then each `cli-v<version>` tag publishes both packages from CI, both with
provenance. Each publish step skips a version already on npm, so if the
`amdahl` step fails, use **Re-run failed jobs** on that run. (Re-running every
job stops at the check that the version is not on npm yet.)

Only if CI cannot publish `amdahl`, publish it by hand as a fallback: download
the `tarball` artifact from the run (it holds `amdahl-<version>.tgz`, already
checked), then, as an owner of the `amdahl` npm org with 2FA, run
`npm publish amdahl-<version>.tgz --access public --provenance=false`.
`publishConfig` asks for provenance, which a laptop cannot give, so without
`--provenance=false` the publish is expected to fail. That version has no
provenance.
