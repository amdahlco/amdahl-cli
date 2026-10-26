# @amdahl/cli

The `amdahl` command line. It signs you in with your console account, checks
that a workspace can optimize, rewrites messages, manages API keys (each one
approved in the console), points MCP clients at Amdahl, and installs skills
from the library at https://amdahl.ai/skills.

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

Needs Node.js 20 or later. On an older Node, `amdahl` stops before it does
anything, names the version it found, and links the Node.js download page.

```sh
# Run once, with no install
npx @amdahl/cli login

# Or install the `amdahl` command
npm i -g @amdahl/cli
amdahl login
```

`amdahl` is also on npm by its short name, so `npx amdahl ...` is the same as
`npx @amdahl/cli ...`. That package ([packages/amdahl](packages/amdahl)) has no
code of its own: it depends on `@amdahl/cli` at the same version and runs it.

To connect an AI client, run `amdahl install claude-code` (or `codex`,
`cursor`). It adds the Amdahl MCP server and also installs the Amdahl skill,
a map of everything Amdahl can do, so your agent knows which tool fits each
job. The skill goes to the client's user skills folder:

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
amdahl login                 # sign in through the browser with your console account
amdahl whoami                # the account, workspace and role you are signed in as
amdahl status                # can this workspace optimize, and what blocks it
amdahl optimize draft.md     # rewrite one message (or pipe it in with -)
amdahl install claude-code   # connect an AI client and add the Amdahl skill (also codex, cursor)
amdahl skills add <publisher>/<skill>   # add a skill from amdahl.ai/skills to this project
```

No workspace yet? `amdahl login` prints the console link where you can
create one or join the beta. The CLI never creates or joins a workspace.

On a server or in CI, skip `login` and set an API key in `AMDAHL_KEY`.

## Commands

```
amdahl login   [--workspace <slug>] [--no-browser] [--port <n>]   (alias: auth login)
amdahl logout  [--all]                                           (alias: auth logout)
amdahl whoami  [--show-token]                                    (alias: auth status)
amdahl auth token
amdahl status
amdahl optimize [<file>... | -] [--channel email|linkedin] [--evidence off|workspace]
                [--on-unsupported flag|remove] [--tries] [--context <file.json>]
amdahl keys create --name <name> [--preset read-only|agent|internal|admin] [--expires 30d|90d|365d] [--no-browser]
amdahl keys list
amdahl keys revoke <id|prefix> [--yes] [--no-browser]
amdahl workspace list | amdahl workspace use <profile>
amdahl install claude-code|codex|cursor [--print] [--force]
amdahl skills add <publisher>/<skill> [-g] [--agents] [--force] [--accept-warning] [--site <origin>]
```

Global flags: `--profile`, `--api-url`, `--api-key`, `--json`, `--no-color`,
`-h`, `-v`. With `--json`, data goes to stdout and messages to stderr.

## Skills

`skills add` installs one skill from the library at https://amdahl.ai/skills.
It needs no sign-in.

```sh
npx amdahl skills add <publisher>/<skill>
# the skill's link works too, with or without .md:
npx amdahl skills add https://amdahl.ai/skills/<publisher>/<skill>
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
  `credentials.json` (mode 0600) with a one-time warning.
  `AMDAHL_CREDENTIAL_STORE=keychain|file` forces either.

## Keys

`keys create` generates the key on your machine and sends only its sha256 hash
and 14-character prefix. You approve the request in the console by typing the
code shown in the terminal; then the key is printed once and stored nowhere.

## Exit codes

| code | meaning |
|---|---|
| 0 | ok |
| 1 | general (`login_timeout`, `state_mismatch`, optimize `ok: false`, a `skills add` refusal) |
| 2 | usage |
| 3 | not signed in (401, `invalid_grant`, no credential) |
| 4 | forbidden (403, `oauth_required`, `cli_client_required`, `not_admin`) |
| 5 | no workspace |
| 6 | rate limited or quota (429) |
| 7 | approval denied, expired or locked out |
| 8 | network or 5xx |
| 9 | `skills add` did not install a skill amdahl.ai's security review flagged: no terminal to ask, `-y`, `--json` or an agent ran it, and no `--accept-warning` (nothing was written) |
| 130 | stopped with Ctrl+C at a question (nothing was written) |

## Development

Needs Node.js 20 or later and pnpm 9 (`corepack enable` picks up the version
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
