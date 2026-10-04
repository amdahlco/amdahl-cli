# @amdahl/cli

The `amdahl` command line. It signs you in with your console account, checks
that a workspace can optimize, rewrites messages, manages API keys (each one
approved in the console), and points MCP clients at Amdahl.

## Install

Needs Node.js 20 or later.

```sh
# Run once, with no install
npx @amdahl/cli login

# Or install the `amdahl` command
npm i -g @amdahl/cli
amdahl login
```

## Quick start

```sh
amdahl login                 # sign in through the browser with your console account
amdahl whoami                # the account, workspace and role you are signed in as
amdahl status                # can this workspace optimize, and what blocks it
amdahl optimize draft.md     # rewrite one message (or pipe it in with -)
amdahl install claude-code   # point an MCP client at Amdahl (also codex, cursor)
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
amdahl install claude-code|codex|cursor [--print]
```

Global flags: `--profile`, `--api-url`, `--api-key`, `--json`, `--no-color`,
`-h`, `-v`. With `--json`, data goes to stdout and messages to stderr.

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
| 1 | general (`login_timeout`, `state_mismatch`, optimize `ok: false`) |
| 2 | usage |
| 3 | not signed in (401, `invalid_grant`, no credential) |
| 4 | forbidden (403, `oauth_required`, `cli_client_required`, `not_admin`) |
| 5 | no workspace |
| 6 | rate limited or quota (429) |
| 7 | approval denied, expired or locked out |
| 8 | network or 5xx |

## Development

Needs Node.js 20 or later and pnpm 9 (`corepack enable` picks up the version
pinned in `package.json`).

```sh
pnpm install
pnpm build         # dist/amdahl.js, one file, no runtime deps
pnpm test          # vitest, against a local mock server
pnpm type-check
pnpm smoke:pack    # pack, install offline, run --version
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues as described in
[SECURITY.md](SECURITY.md), not in public issues.

## Releases

`.github/workflows/publish.yml` publishes to npm. To release:

1. In a PR, bump the version in `package.json` and `src/version.ts` together.
   The workflow refuses a version that does not match both, or one that is
   already on npm.
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
