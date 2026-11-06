// Bare `amdahl`: the guided setup in a terminal, the same setup with no
// question for an agent or a pipe, and the usage (exit 2) in CI. Detection,
// the already-set-up path, sign-in, one `install` per ticked client, and
// Claude Code without `claude` on PATH, all through the fake process boundary
// in a temp home.

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { USAGE } from '../src/args'
import { FOUND_TAG, MENU_HINT, NONE_FOUND, QUESTION, noSetupLine } from '../src/commands/setup'
import { SKILL_TEXT } from '../src/skill'
import { cli, fakeIo, followAuthorize, type FakeIo } from './helpers/fake-io'
import { startMockServer, type MockServer } from './helpers/mock-server'

let server: MockServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

/** A person's terminal: stdin, stdout and stderr are all a TTY (colour off, so output compares as text). */
function terminal(env: Record<string, string | undefined> = {}): FakeIo {
  const io = fakeIo({ NO_COLOR: '1', ...env })
  io.stdoutIsTTY = true
  io.stderrIsTTY = true
  return io
}

/** A terminal against the mock server, optionally signed in already. */
async function atServer(signedIn: boolean, env: Record<string, string> = {}): Promise<FakeIo> {
  server = await startMockServer()
  const io = terminal({ AMDAHL_API_URL: server.url, ...env })
  if (signedIn) expect((await cli(io, 'login', '--json')).code).toBe(0)
  io.opened.length = 0
  return io
}

/**
 * Fake `which` and `claude`: `onPath` names the commands found; `claude mcp
 * get amdahl` answers `mcpUrl` when given, else "not found"; anything else exits 0.
 */
function commands(io: FakeIo, onPath: string[], mcpUrl?: string) {
  io.run.mockImplementation(async (command: string, args: string[]) => {
    if (command === 'which') return { code: onPath.includes(args[0] ?? '') ? 0 : 1, stdout: '', stderr: '' }
    if (command === 'claude' && args[0] === 'mcp' && args[1] === 'get') {
      return mcpUrl
        ? { code: 0, stdout: `amdahl:\n  Scope: User config\n  Type: http\n  URL: ${mcpUrl}\n  Headers:\n    X-Secret: do-not-print\n`, stderr: '' }
        : { code: 1, stdout: '', stderr: 'No MCP server named "amdahl".' }
    }
    return { code: 0, stdout: '', stderr: '' }
  })
}

const skillAt = (io: FakeIo, ...dir: string[]) => join(io.homedir, ...dir, 'amdahl', 'SKILL.md')
const OLD_SKILL = readFileSync(join(__dirname, 'fixtures', 'skill-0.1.3.md'), 'utf8')
const ASK = 'say "make this email sound less like AI"'
const CODEX_TRY = `Try it: ${ASK} in Codex.\nBefore that, run \`codex mcp login amdahl\` once to connect Amdahl.`
const CLAUDE_TRY = `Try it: ${ASK} in Claude Code.\nBefore that, run /mcp once in Claude Code to connect Amdahl.`
const CURSOR_TRY = `Try it: ${ASK} in Cursor.\nBefore that, sign in when Cursor asks, the first time you use Amdahl.`
const TITLE = 'Amdahl · predictive ML for GTM\n'
const HINT = "Browser didn't open? Press Enter for the link.\n"
// A finished sign-in erases the one-line hint: up one line, clear to the end of the screen.
const ERASE = '\r\u001b[1A\u001b[0J'
/** The menu as the fake records it. */
const menu = (rows: string) => `${QUESTION} [${rows}]`
/** The last two lines: the thing to try and the step that connects the client. */
const lastLine = (text: string) => text.trimEnd().split('\n').slice(-2).join('\n')
const ran = (io: FakeIo, command: string) => io.run.mock.calls.filter((c) => c[0] === command).map((c) => (c[1] as string[]).join(' '))

/** Cursor, already pointed at `mcpUrl`, with the current skill. */
function cursorSetUp(io: FakeIo, mcpUrl: string) {
  mkdirSync(join(io.homedir, '.cursor', 'skills', 'amdahl'), { recursive: true })
  writeFileSync(join(io.homedir, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { amdahl: { url: mcpUrl } } }))
  writeFileSync(skillAt(io, '.cursor', 'skills'), SKILL_TEXT)
}

describe('bare amdahl: when it guides', () => {
  it('runs the setup in a terminal', async () => {
    const io = terminal()
    io.answers.push('none')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`${TITLE}Nothing picked, so nothing changed.\n`)
    expect(io.prompts).toEqual([menu('  Claude Code |   Cursor |   Codex')])
    expect(r.stderr).not.toContain('Usage:')
  })

  it.each<[string, (io: FakeIo) => void, string]>([
    ['AMDAHL_NO_PROMPT=1', (io) => (io.env.AMDAHL_NO_PROMPT = '1'), 'AMDAHL_NO_PROMPT=1 is set'],
    ['CI is set', (io) => (io.env.CI = 'true'), 'CI is set'],
    ['CI=1, even with an agent', (io) => Object.assign(io.env, { CI: '1', CLAUDECODE: '1' }), 'CI is set'],
    ['CI=1 with no terminal', (io) => Object.assign(io, { stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false, env: { ...io.env, CI: '1' } }), 'CI is set'],
  ])('says why, prints the usage and exits 2 when %s', async (_label, change, reason) => {
    const io = terminal()
    mkdirSync(join(io.homedir, '.cursor'))
    change(io)
    const r = await cli(io)
    expect(r.code).toBe(2)
    expect(r.stderr).toBe(`${noSetupLine(reason)}${USAGE}`)
    expect(r.stderr.split('\n').slice(0, 3)).toEqual([`Setup did not run: ${reason}.`, 'To set up a client, run `amdahl install claude-code` (or cursor, codex).', ''])
    expect(r.stdout).toBe('')
    expect(io.prompts).toEqual([])
    expect(io.run).not.toHaveBeenCalled()
    expect(existsSync(join(io.homedir, '.cursor', 'mcp.json'))).toBe(false)
  })

  it('keeps the usage for --json, takes --no-color, and --help is as it was', async () => {
    const io = terminal()
    const json = await cli(io, '--json')
    expect(json.code).toBe(2)
    expect(json.stderr).toBe(`${noSetupLine('it has no --json output')}${USAGE}`)
    io.answers.push('none')
    const noColor = await cli(io, '--no-color')
    expect(noColor).toMatchObject({ code: 0, stdout: `${TITLE}Nothing picked, so nothing changed.\n` })
    const help = await cli(io, '--help')
    expect(help).toMatchObject({ code: 0, stdout: USAGE })
    expect(io.prompts).toHaveLength(1)
  })

  it('`amdahl setup` is bare `amdahl`', async () => {
    const io = terminal()
    io.answers.push('none')
    expect(await cli(io, 'setup')).toMatchObject({ code: 0, stdout: `${TITLE}Nothing picked, so nothing changed.\n` })
    expect((await cli(io, 'setup', 'now')).code).toBe(2)
  })

  it('the usage names bare amdahl as the guided setup', () => {
    expect(USAGE).toMatch(/^ {2}amdahl {2,}Set up Claude Code, Cursor or Codex/m)
  })
})

describe('bare amdahl: detection', () => {
  it('ticks the clients it finds: a command on PATH or a folder in home', async () => {
    const io = terminal()
    mkdirSync(join(io.homedir, '.cursor'))
    commands(io, ['codex'])
    io.answers.push('none')
    const r = await cli(io)
    expect(io.prompts).toEqual([menu('  Claude Code | x Cursor | x Codex')])
    // The .cursor folder is enough; PATH is only asked about the other two.
    expect(ran(io, 'which')).toEqual(['claude', 'codex'])
  })

  it('with none found, offers all three unticked', async () => {
    const io = terminal()
    io.answers.push('none')
    const r = await cli(io)
    expect(io.prompts).toEqual([menu('  Claude Code |   Cursor |   Codex')])
    expect(r.stdout).toBe(`${TITLE}Nothing picked, so nothing changed.\n`)
    expect(existsSync(join(io.homedir, '.claude'))).toBe(false)
  })
})

describe('bare amdahl: setting up', () => {
  it('runs install for each ticked client, and only those', async () => {
    const io = await atServer(true)
    mkdirSync(join(io.homedir, '.cursor'))
    commands(io, ['claude'])
    io.answers.push('1,3') // Claude Code and Codex; Cursor was found but is left unticked
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([menu('x Claude Code | x Cursor |   Codex')])
    expect(ran(io, 'claude')).toEqual(['mcp get amdahl', `mcp add --scope user --transport http amdahl ${server!.url}/mcp`])
    expect(readFileSync(join(io.homedir, '.codex', 'config.toml'), 'utf8')).toContain(`url = "${server!.url}/mcp"`)
    expect(readFileSync(skillAt(io, '.claude', 'skills'), 'utf8')).toBe(SKILL_TEXT)
    expect(readFileSync(skillAt(io, '.agents', 'skills'), 'utf8')).toBe(SKILL_TEXT)
    expect(existsSync(join(io.homedir, '.cursor', 'mcp.json'))).toBe(false)
    // One line a step: no paths, no profile, no notes.
    // One line a step, then the step that connects each client: no paths, no profile, no notes.
    expect(r.stdout).toBe(
      `${TITLE}✓ Signed in · Acme\n✓ Added to Claude Code\n✓ Added to Codex\nTry it: ${ASK} in any of them.\nBefore that, connect each one once:\n  Claude Code: run /mcp\n  Codex: run \`codex mcp login amdahl\`\n`
    )
    expect(r.stderr).toBe('')
  })

  it('Enter accepts the clients it found', async () => {
    const io = await atServer(true)
    mkdirSync(join(io.homedir, '.cursor'))
    io.answers.push('')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(JSON.parse(readFileSync(join(io.homedir, '.cursor', 'mcp.json'), 'utf8'))).toEqual({ mcpServers: { amdahl: { url: `${server!.url}/mcp` } } })
    expect(existsSync(join(io.homedir, '.codex'))).toBe(false)
    expect(lastLine(r.stdout)).toBe(CURSOR_TRY)
  })

  it('signs in through the browser first when there is no sign-in, and prints no link when the browser answers', async () => {
    const io = await atServer(false)
    io.answers.push('3')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.opened).toHaveLength(1)
    expect(io.opened[0]).toContain('/oauth/authorize')
    expect(r.stderr).toBe(`Opening your browser…\n${HINT}${ERASE}`)
    expect(r.stdout).toBe(`${TITLE}✓ Signed in · Acme\n✓ Added to Codex\n${CODEX_TRY}\n`)
    // The wait for Enter ended with the sign-in.
    expect(io.listened).toBe(1)
    expect(io.keys).toBeNull()
  })

  it('without `claude` anywhere, adds Amdahl to Claude Code\'s settings file itself, then the next client', async () => {
    const io = await atServer(true)
    io.answers.push('1,2')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('✓ Added to Claude Code\n✓ Added to Cursor\n')
    expect(r.stdout).not.toContain('PATH')
    expect(JSON.parse(readFileSync(join(io.homedir, '.claude.json'), 'utf8'))).toEqual({ mcpServers: { amdahl: { type: 'http', url: `${server!.url}/mcp` } } })
    expect(r.stdout).toContain('  Claude Code: run /mcp\n  Cursor: sign in when it asks, on first use\n')
  })

  it('a client that fails does not stop the others, and sets the exit code', async () => {
    const io = await atServer(true)
    mkdirSync(join(io.homedir, '.cursor'))
    writeFileSync(join(io.homedir, '.cursor', 'mcp.json'), '{not json')
    io.answers.push('2,3')
    const r = await cli(io)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(`Error: ${join(io.homedir, '.cursor', 'mcp.json')} is not valid JSON; not changing it.`)
    expect(readFileSync(join(io.homedir, '.codex', 'config.toml'), 'utf8')).toContain('[mcp_servers.amdahl]')
    expect(lastLine(r.stdout)).toBe(CODEX_TRY)
  })

  it.each<[string, string | null]>([
    ['missing', null],
    ['an old shipped copy', OLD_SKILL],
  ])('Claude Code with Amdahl already added and the skill %s: adds the skill, skips `claude mcp add`', async (_label, skill) => {
    const io = await atServer(true)
    commands(io, ['claude'], `${server!.url}/mcp`)
    if (skill !== null) {
      mkdirSync(join(io.homedir, '.claude', 'skills', 'amdahl'), { recursive: true })
      writeFileSync(skillAt(io, '.claude', 'skills'), skill)
    }
    io.answers.push('')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([menu('x Claude Code |   Cursor |   Codex')])
    expect(ran(io, 'claude').filter((c) => c.startsWith('mcp add'))).toEqual([])
    expect(readFileSync(skillAt(io, '.claude', 'skills'), 'utf8')).toBe(SKILL_TEXT)
    expect(r.stdout).toContain('✓ Claude Code already has Amdahl\n')
    expect(r.stdout + r.stderr).not.toContain('do-not-print')
    expect(lastLine(r.stdout)).toBe(CLAUDE_TRY)
    // Set up now: the next run asks nothing, and still names /mcp.
    const again = await cli(io)
    expect(again.stdout).toBe(`${TITLE}You're set up in Claude Code.\n${CLAUDE_TRY}\n`)
    expect(io.prompts).toHaveLength(1)
  })

  it('a file it cannot write is that client\'s error (exit 1), and the next client still runs', async () => {
    const io = await atServer(true)
    writeFileSync(join(io.homedir, '.cursor'), 'a file where the folder should be')
    io.answers.push('2,3')
    const r = await cli(io)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(`Error: Could not update ${join(io.homedir, '.cursor', 'mcp.json')} (`)
    expect(r.stderr).not.toContain('Could not reach the Amdahl API')
    expect(readFileSync(join(io.homedir, '.codex', 'config.toml'), 'utf8')).toContain('[mcp_servers.amdahl]')
    expect(lastLine(r.stdout)).toBe(CODEX_TRY)
  })

  it('an unexpected failure is reported for that client, and the next client still runs', async () => {
    const io = await atServer(true)
    io.run.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'claude' && args[1] === 'add') throw new Error('spawn blew up')
      return { code: command === 'which' && args[0] !== 'claude' ? 1 : command === 'claude' ? 1 : 0, stdout: '', stderr: '' }
    })
    io.answers.push('1,3')
    const r = await cli(io)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Error: Could not set up Claude Code: spawn blew up\n')
    expect(r.stderr).not.toContain('Could not reach the Amdahl API')
    expect(existsSync(join(io.homedir, '.codex', 'config.toml'))).toBe(true)
    expect(lastLine(r.stdout)).toBe(CODEX_TRY)
  })

  it('a key in the environment that Amdahl rejects: says so, skips the browser sign-in, still installs', async () => {
    const io = await atServer(false, { AMDAHL_KEY: 'amdhl_rejected' })
    io.answers.push('3')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.opened).toEqual([])
    expect(r.stderr).toContain('Amdahl rejected the key in AMDAHL_KEY. Skipping the browser sign-in, because that key would still be used instead.')
    expect(r.stdout + r.stderr).not.toContain('amdhl_rejected')
    expect(existsSync(join(io.homedir, '.codex', 'config.toml'))).toBe(true)
  })

  it('Ctrl+C at the question stops with exit 130 and writes nothing', async () => {
    const io = terminal()
    mkdirSync(join(io.homedir, '.cursor'))
    io.answers.push(null)
    const r = await cli(io)
    expect(r.code).toBe(130)
    expect(r.stderr).toBe('Stopped. Nothing changed.\n')
    expect(existsSync(join(io.homedir, '.cursor', 'mcp.json'))).toBe(false)
  })
})

describe('bare amdahl: already set up', () => {
  it('Codex keeps its login step on a run that changes nothing: whether it ran cannot be told', async () => {
    const io = await atServer(true)
    mkdirSync(join(io.homedir, '.codex'))
    io.answers.push('')
    expect(lastLine((await cli(io)).stdout)).toBe(CODEX_TRY)
    const again = await cli(io)
    expect(io.prompts).toHaveLength(1)
    expect(again.stdout).toBe(`${TITLE}You're set up in Codex.\n${CODEX_TRY}\n`)
  })

  it('Codex keeps its login step when the setup asks again and its config is already there', async () => {
    const io = await atServer(true)
    mkdirSync(join(io.homedir, '.codex'))
    writeFileSync(join(io.homedir, '.codex', 'config.toml'), `[mcp_servers.amdahl]\nurl = "${server!.url}/mcp"\n`)
    io.answers.push('')
    const r = await cli(io)
    expect(r.stdout).toBe(`${TITLE}✓ Signed in · Acme\n✓ Codex already has Amdahl\n${CODEX_TRY}\n`)
  })

  it('says so and asks nothing', async () => {
    const io = await atServer(true)
    cursorSetUp(io, `${server!.url}/mcp`)
    commands(io, ['claude'], `${server!.url}/mcp`)
    mkdirSync(join(io.homedir, '.claude', 'skills', 'amdahl'), { recursive: true })
    writeFileSync(skillAt(io, '.claude', 'skills'), SKILL_TEXT)
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([])
    // The step that connects each client, every run: whoever runs it again because one "does not work" needs it most.
    expect(r.stdout).toBe(
      `${TITLE}You're set up in Claude Code and Cursor.\nTry it: ${ASK} in any of them.\nBefore that, connect each one once:\n  Claude Code: run /mcp\n  Cursor: sign in when it asks, on first use\n`
    )
    expect(r.stdout + r.stderr).not.toContain('do-not-print')
    expect(ran(io, 'claude')).toEqual(['mcp get amdahl'])
  })

  it.each<[string, (io: FakeIo, mcpUrl: string) => void]>([
    ['a found client is not set up', (io) => mkdirSync(join(io.homedir, '.codex'))],
    ['the skill is missing', (io) => rmSync(skillAt(io, '.cursor', 'skills'))],
    ['Cursor points elsewhere', (io) => writeFileSync(join(io.homedir, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { amdahl: { url: 'https://elsewhere/mcp' } } }))],
    ['Claude Code has no amdahl server', (io) => commands(io, ['claude'])],
  ])('asks again when %s', async (_label, change) => {
    const io = await atServer(true)
    cursorSetUp(io, `${server!.url}/mcp`)
    commands(io, [])
    change(io, `${server!.url}/mcp`)
    io.answers.push('none')
    await cli(io)
    expect(io.prompts).toHaveLength(1)
  })

  it('still says so when Amdahl cannot be reached to check the sign-in', async () => {
    const io = await atServer(true)
    cursorSetUp(io, `${server!.url}/mcp`)
    await server!.close()
    server = null
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([])
    expect(r.stdout).toBe(`${TITLE}You're set up in Cursor. (Could not reach Amdahl to check your sign-in.)\n${CURSOR_TRY}\n`)
  })

  it('asks again, and signs in, when every client is set up but there is no sign-in', async () => {
    const io = await atServer(false)
    cursorSetUp(io, `${server!.url}/mcp`)
    io.answers.push('')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toHaveLength(1)
    expect(io.opened).toHaveLength(1)
    expect(r.stdout).toContain('✓ Cursor already has Amdahl\n')
  })
})

describe('bare amdahl: --verbose', () => {
  it('is the one flag that still runs the setup, and it adds the files and the profile', async () => {
    const io = await atServer(false)
    io.answers.push('3')
    const r = await cli(io, '--verbose')
    expect(r.code).toBe(0)
    expect(io.prompts).toHaveLength(1)
    expect(r.stdout).toContain('✓ Signed in · Acme\n  Signed in as dev@example.com to Acme (acme). Profile: acme.\n')
    expect(r.stdout).toContain(`✓ Added to Codex\n  Added Amdahl to ${join(io.homedir, '.codex', 'config.toml')}.`)
    expect(r.stdout).toContain(skillAt(io, '.agents', 'skills'))
    expect(lastLine(r.stdout)).toBe(CODEX_TRY)
  })

  it('without --verbose, no path, profile or email is printed', async () => {
    const io = await atServer(false)
    io.answers.push('1,2,3')
    commands(io, ['claude'])
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(r.stdout + r.stderr).not.toContain(io.homedir)
    expect(r.stdout + r.stderr).not.toMatch(/Profile|dev@example\.com|acme\)/)
  })

  it('with --json beside it, says why and prints the usage', async () => {
    const io = terminal()
    const r = await cli(io, '--verbose', '--json')
    expect(r.code).toBe(2)
    expect(r.stderr).toBe(`${noSetupLine('it has no --json output')}${USAGE}`)
    expect(io.prompts).toEqual([])
  })
})

describe('bare amdahl: the browser sign-in', () => {
  /** A browser that reaches the authorize URL only after `ms`, like a person who takes a while. */
  function slowBrowser(io: FakeIo, ms: number, opened = true, walk: (url: string) => Promise<void> = followAuthorize) {
    io.openUrl = async (url) => {
      io.opened.push(url)
      setTimeout(() => void walk(url), ms)
      return opened
    }
  }

  it('prints the link at once when the browser could not be opened', async () => {
    const io = await atServer(false)
    slowBrowser(io, 50, false)
    io.answers.push('3')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(r.stderr).toMatch(/^Opening your browser…\nBrowser didn't open\? Press Enter for the link\.\nYour browser did not open\. Open this link to sign in:\n\n {2}http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?/)
    expect(r.stdout).toContain('✓ Signed in · Acme\n')
  })

  it('Enter prints the link once, and it keeps waiting', async () => {
    const io = await atServer(false)
    slowBrowser(io, 200)
    io.answers.push('3')
    const run = cli(io)
    await vi.waitFor(() => expect(io.keys).not.toBeNull())
    io.keys!.enter()
    io.keys!.enter()
    const r = await run
    expect(r.code).toBe(0)
    expect(r.stderr).toBe(`Opening your browser…\n${HINT}Open this link to sign in:\n\n  ${io.opened[0]}\n`)
    expect(r.stdout).toContain('✓ Signed in · Acme\n')
    expect(io.keys).toBeNull()
  })

  it('Ctrl+C while it waits stops (exit 130), sets nothing up, and lets go of the terminal', async () => {
    const io = await atServer(false)
    slowBrowser(io, 0, true, async () => {})
    io.answers.push('3')
    const run = cli(io)
    await vi.waitFor(() => expect(io.keys).not.toBeNull())
    io.keys!.cancel()
    const r = await run
    expect(r.code).toBe(130)
    expect(r.stderr).toBe(`Opening your browser…\n${HINT}Stopped. Nothing changed.\n`)
    expect(r.stdout).toBe(TITLE)
    expect(io.keys).toBeNull()
    expect(ran(io, 'codex')).toEqual([])
  })

  it('in a terminal that shows hyperlinks, the line links the sign-in page, and Enter still prints the link', async () => {
    server = await startMockServer()
    const io = terminal({ AMDAHL_API_URL: server.url, NO_COLOR: undefined, TERM_PROGRAM: 'iTerm.app' })
    slowBrowser(io, 200)
    io.answers.push('3')
    const run = cli(io)
    await vi.waitFor(() => expect(io.keys).not.toBeNull())
    const url = io.opened[0]!
    io.keys!.enter()
    const r = await run
    expect(r.code).toBe(0)
    expect(r.stderr).toBe(
      `Opening your browser…\nBrowser didn't open? \u001b]8;;${url}\u001b\\Open the sign-in page\u001b]8;;\u001b\\\nOpen this link to sign in:\n\n  ${url}\n`
    )
  })

  it('--no-browser prints the link at once and waits for no key', async () => {
    const io = await atServer(false)
    const run = cli(io, 'login', '--no-browser')
    await vi.waitFor(() => expect(io.err.join('')).toContain('/oauth/authorize?'))
    const url = /(http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?\S+)/.exec(io.err.join(''))![1]!
    await followAuthorize(url)
    const r = await run
    expect(r.code).toBe(0)
    expect(r.stderr).toBe(`Open this URL in a browser to sign in:\n\n  ${url}\n`)
    expect(io.listened).toBe(0)
  })

  it('a new user creates their workspace in the browser and lands back in the same setup', async () => {
    server = await startMockServer({ selfServe: true })
    const io = terminal({ AMDAHL_API_URL: server.url })
    // The person signs in, sees the create page, clicks Create, and the server returns to the same authorize request.
    slowBrowser(io, 100, true, async (url) => {
      const page = await fetch(url).then((res) => res.text())
      expect(page).toContain('/oauth/authorize/self-serve')
      const created = await fetch(`${server!.url}/oauth/authorize/self-serve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ return_to: url.slice(server!.url.length) }).toString(),
        redirect: 'manual',
      })
      await followAuthorize(`${server!.url}${created.headers.get('location')}`)
    })
    io.answers.push('3')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(r.stderr).toBe(`Opening your browser…\n${HINT}${ERASE}`)
    expect(r.stdout).toBe(`${TITLE}✓ Signed in · Acme\n✓ Added to Codex\n${CODEX_TRY}\n`)
  })

  it('a sign-in the server gives no workspace stops with its one next step (exit 5), and sets nothing up', async () => {
    server = await startMockServer({ noBusiness: { mayCreate: false, reason: 'invite_only' } })
    const io = terminal({ AMDAHL_API_URL: server.url })
    io.answers.push('3')
    const r = await cli(io)
    expect(r.code).toBe(5)
    expect(r.stderr).toContain("Error: Your company's Amdahl workspace is invite-only. Ask a colleague in it to invite you, then try again.\n")
    expect(existsSync(join(io.homedir, '.codex'))).toBe(false)
  })

  it('a personal email: the page offers another sign-in, and the setup finishes in the same run', async () => {
    server = await startMockServer({ noBusiness: { mayCreate: false, reason: 'not_work_email', times: 1 } })
    const io = terminal({ AMDAHL_API_URL: server.url })
    // First visit: refused. The person picks "Sign in with your work email →", which returns to the same authorize URL.
    slowBrowser(io, 0, true, async (url) => {
      await followAuthorize(url)
      await followAuthorize(url)
    })
    io.answers.push('3')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(r.stderr).toMatch(/Amdahl needs your work email\. Sign in with your work email:\n\n {2}http:\/\/127\.0\.0\.1:\d+\/login\?redirect=%2Foauth%2Fauthorize%3F\S+\n/)
    expect(r.stdout).toBe(`${TITLE}✓ Signed in · Acme\n✓ Added to Codex\n${CODEX_TRY}\n`)
  })

  it('prints no control characters from the server: a workspace name cannot drive the terminal', async () => {
    server = await startMockServer({ workspaceName: 'Acme\u001b]0;pwned\u0007\u001b[2J' })
    const io = terminal({ AMDAHL_API_URL: server.url })
    io.answers.push('3')
    const r = await cli(io, '--verbose')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('✓ Signed in · Acme]0;pwned[2J\n')
    expect(r.stdout).not.toMatch(/[\u0000-\u0009\u000b-\u001f]/)
    const again = await cli(io)
    expect(again.stdout).not.toMatch(/[\u0000-\u0009\u000b-\u001f]/)
  })
})

/** No terminal at all: how an agent's shell tool, or a pipe, runs a command. */
function noTerminal(env: Record<string, string | undefined> = {}): FakeIo {
  const io = fakeIo({ NO_COLOR: '1', ...env })
  io.stdinIsTTY = false
  io.stdoutIsTTY = false
  io.stderrIsTTY = false
  return io
}

/** An executable `claude` at `path`, under the temp home. */
function fakeClaudeAt(path: string) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o755)
}

describe('bare amdahl, run by an agent or with no terminal', () => {
  // No server: it must not sign in, or reach Amdahl at all.
  const offline = { AMDAHL_API_URL: 'http://127.0.0.1:9' }

  it('Claude Code (CLAUDECODE): sets up Claude Code only, asks nothing, signs in nowhere', async () => {
    const io = noTerminal({ ...offline, CLAUDECODE: '1' })
    mkdirSync(join(io.homedir, '.cursor'))
    mkdirSync(join(io.homedir, '.codex'))
    commands(io, ['claude'])
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([])
    expect(io.opened).toEqual([])
    expect(ran(io, 'claude')).toEqual(['mcp get amdahl', 'mcp add --scope user --transport http amdahl http://127.0.0.1:9/mcp'])
    expect(existsSync(join(io.homedir, '.cursor', 'mcp.json'))).toBe(false)
    expect(existsSync(join(io.homedir, '.codex', 'config.toml'))).toBe(false)
    // A running Claude Code session sees the new server once restarted.
    expect(r.stdout).toBe(`${TITLE}✓ Added to Claude Code\nTry it: ${ASK} in Claude Code.\nBefore that, restart Claude Code and run /mcp once to connect Amdahl.\n`)
    expect(r.stderr).toBe('')
  })

  it('Claude Code in a terminal is still an agent run', async () => {
    const io = terminal({ ...offline, CLAUDECODE: '1' })
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([])
    expect(r.stdout).toContain('✓ Added to Claude Code\n')
  })

  it('Cursor (CURSOR_AGENT): sets up Cursor only', async () => {
    const io = noTerminal({ ...offline, CURSOR_AGENT: '1' })
    mkdirSync(join(io.homedir, '.codex'))
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(JSON.parse(readFileSync(join(io.homedir, '.cursor', 'mcp.json'), 'utf8'))).toEqual({ mcpServers: { amdahl: { url: 'http://127.0.0.1:9/mcp' } } })
    expect(existsSync(join(io.homedir, '.codex', 'config.toml'))).toBe(false)
    expect(r.stdout).toBe(`${TITLE}✓ Added to Cursor\n${CURSOR_TRY}\n`)
  })

  it.each<[string, (io: FakeIo) => void]>([
    ['no terminal at all (Codex sets no variable)', () => {}],
    ['stdout piped', (io) => Object.assign(io, { stdinIsTTY: true, stderrIsTTY: true })],
    ['stdin piped', (io) => Object.assign(io, { stdoutIsTTY: true, stderrIsTTY: true })],
    ['stderr redirected', (io) => Object.assign(io, { stdinIsTTY: true, stdoutIsTTY: true })],
  ])('%s: sets up every client it finds, and names each one\'s step', async (_label, change) => {
    const io = noTerminal(offline)
    change(io)
    mkdirSync(join(io.homedir, '.claude'))
    mkdirSync(join(io.homedir, '.codex'))
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([])
    expect(io.opened).toEqual([])
    expect(JSON.parse(readFileSync(join(io.homedir, '.claude.json'), 'utf8')).mcpServers.amdahl).toEqual({ type: 'http', url: 'http://127.0.0.1:9/mcp' })
    expect(readFileSync(join(io.homedir, '.codex', 'config.toml'), 'utf8')).toContain('[mcp_servers.amdahl]')
    expect(existsSync(join(io.homedir, '.cursor'))).toBe(false)
    expect(r.stdout).toBe(
      `${TITLE}✓ Added to Claude Code\n✓ Added to Codex\nTry it: ${ASK} in any of them.\nBefore that, connect each one once:\n  Claude Code: run /mcp\n  Codex: run \`codex mcp login amdahl\`\n`
    )
  })

  it('all three, run again: says each is already there, and still names every step', async () => {
    const io = noTerminal(offline)
    for (const dir of ['.claude', '.cursor', '.codex']) mkdirSync(join(io.homedir, dir))
    expect((await cli(io)).code).toBe(0)
    const again = await cli(io)
    expect(again.code).toBe(0)
    expect(again.stdout).toBe(
      `${TITLE}✓ Claude Code already has Amdahl\n✓ Cursor already has Amdahl\n✓ Codex already has Amdahl\nTry it: ${ASK} in any of them.\nBefore that, connect each one once:\n  Claude Code: run /mcp\n  Cursor: sign in when it asks, on first use\n  Codex: run \`codex mcp login amdahl\`\n`
    )
  })

  it('finds none: says so, names the install command, writes nothing, exits 1', async () => {
    const io = noTerminal({ ...offline, npm_command: 'exec' })
    const r = await cli(io)
    expect(r.code).toBe(1)
    expect(r.stdout).toBe(TITLE)
    expect(r.stderr).toBe("Didn't find Claude Code, Cursor or Codex on this computer, so nothing changed.\nTo set up a client, run `npx amdahl install claude-code` (or cursor, codex).\n")
    expect(readdirSync(io.homedir).sort()).toEqual(['project'])
  })

  it('a client that fails prints its error, the rest still run, and the exit code is the failure\'s', async () => {
    const io = noTerminal(offline)
    mkdirSync(join(io.homedir, '.cursor'))
    mkdirSync(join(io.homedir, '.codex'))
    writeFileSync(join(io.homedir, '.cursor', 'mcp.json'), '{not json')
    const r = await cli(io)
    expect(r.code).toBe(1)
    expect(r.stderr).toBe(`Error: ${join(io.homedir, '.cursor', 'mcp.json')} is not valid JSON; not changing it.\nFix the file, or move it away, then run the same command again.\n`)
    expect(r.stdout).toBe(`${TITLE}✓ Added to Codex\n${CODEX_TRY}\n`)
  })

  it('--verbose adds the files', async () => {
    const io = noTerminal({ ...offline, CURSOR_AGENT: '1' })
    const r = await cli(io, '--verbose')
    expect(r.stdout).toContain(`✓ Added to Cursor\n  Added Amdahl to ${join(io.homedir, '.cursor', 'mcp.json')}.`)
  })
})

describe('bare amdahl: the menu', () => {
  it('asks where Amdahl should work, tags and ticks only the clients it found, with the hint to install', async () => {
    const io = terminal()
    mkdirSync(join(io.homedir, '.claude'))
    io.answers.push('none')
    await cli(io)
    expect(io.prompts).toEqual([menu('x Claude Code |   Cursor |   Codex')])
    expect(io.tickOptions[0]).toEqual({
      ticked: [true, false, false],
      tags: [FOUND_TAG, undefined, undefined],
      note: undefined,
      hint: MENU_HINT,
      color: false,
    })
    expect([QUESTION, FOUND_TAG, MENU_HINT]).toEqual(['Where should Amdahl work?', 'found on your machine', '↑↓ move · Space tick/untick · Enter to install'])
  })

  it('found none: says so under the question, and ticks none', async () => {
    const io = terminal()
    io.answers.push('none')
    await cli(io)
    expect(io.tickOptions[0]).toMatchObject({ ticked: [false, false, false], tags: [undefined, undefined, undefined], note: NONE_FOUND })
    expect(NONE_FOUND).toBe("We didn't find any of these on this computer. Tick the ones you use.")
  })

  it('a ~/.claude.json alone means Claude Code is here', async () => {
    const io = terminal()
    writeFileSync(join(io.homedir, '.claude.json'), '{}')
    io.answers.push('none')
    await cli(io)
    expect(io.tickOptions[0]).toMatchObject({ ticked: [true, false, false] })
  })

  it('asks in colour when colour is allowed', async () => {
    const io = terminal({ NO_COLOR: undefined })
    io.answers.push('none')
    await cli(io)
    expect(io.tickOptions[0]).toMatchObject({ color: true })
  })
})

describe('Claude Code without `claude` on PATH', () => {
  const url = 'http://127.0.0.1:9/mcp'
  const agent = () => noTerminal({ AMDAHL_API_URL: 'http://127.0.0.1:9', CLAUDECODE: '1' })

  it.each<[string, string[]]>([
    ["its installer's ~/.local/bin", ['.local', 'bin', 'claude']],
    ['the older ~/.claude/local', ['.claude', 'local', 'claude']],
  ])('runs the `claude` in %s', async (_label, parts) => {
    const io = agent()
    const path = join(io.homedir, ...parts)
    fakeClaudeAt(path)
    commands(io, [])
    const r = await cli(io)
    expect(r.code).toBe(0)
    const calls = io.run.mock.calls.filter((c) => c[0] === path).map((c) => (c[1] as string[]).join(' '))
    expect(calls).toEqual(['mcp get amdahl', `mcp add --scope user --transport http amdahl ${url}`])
    expect(existsSync(join(io.homedir, '.claude.json'))).toBe(false)
    expect(r.stdout).toContain('✓ Added to Claude Code\n')
  })

  it("runs the `claude` in npm's global bin, from npm's own variable or `npm prefix -g`", async () => {
    const io = agent()
    const prefix = join(io.homedir, 'npm-global')
    fakeClaudeAt(join(prefix, 'bin', 'claude'))
    io.env.npm_config_global_prefix = prefix
    commands(io, [])
    expect((await cli(io)).code).toBe(0)
    expect(io.run.mock.calls.some((c) => c[0] === join(prefix, 'bin', 'claude') && (c[1] as string[])[1] === 'add')).toBe(true)

    const asked = agent()
    const prefix2 = join(asked.homedir, 'npm-global')
    fakeClaudeAt(join(prefix2, 'bin', 'claude'))
    asked.run.mockImplementation(async (command: string, args: string[]) => {
      if (command === 'which') return { code: 1, stdout: '', stderr: '' }
      if (command === 'npm') return { code: 0, stdout: `${prefix2}\n`, stderr: '' }
      return { code: command === join(prefix2, 'bin', 'claude') && args[1] === 'get' ? 1 : 0, stdout: '', stderr: '' }
    })
    expect((await cli(asked)).code).toBe(0)
    expect(ran(asked, 'npm')).toEqual(['prefix -g'])
    expect(asked.run.mock.calls.some((c) => c[0] === join(prefix2, 'bin', 'claude') && (c[1] as string[])[1] === 'add')).toBe(true)
  })

  it('with no `claude` anywhere, writes the user-scope entry `claude mcp add --scope user` would, keeping every other key', async () => {
    const io = agent()
    const path = join(io.homedir, '.claude.json')
    const before = { numStartups: 12, projects: { '/x': { mcpServers: { local: { type: 'stdio', command: 'x' } } } }, mcpServers: { other: { type: 'http', url: 'https://other/mcp' } } }
    writeFileSync(path, JSON.stringify(before), { mode: 0o600 })
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ...before, mcpServers: { other: { type: 'http', url: 'https://other/mcp' }, amdahl: { type: 'http', url } } })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    // The file as it was, beside it; no temp file left behind.
    expect(JSON.parse(readFileSync(`${path}.amdahl-backup`, 'utf8'))).toEqual(before)
    expect(readdirSync(io.homedir).filter((f) => f.includes('.tmp'))).toEqual([])
    expect(r.stdout).toContain('✓ Added to Claude Code\n')
  })

  it('is idempotent: a second run changes nothing, not even the backup', async () => {
    const io = agent()
    const path = join(io.homedir, '.claude.json')
    writeFileSync(path, '{"theme":"dark"}')
    await cli(io)
    const written = readFileSync(path, 'utf8')
    const backup = readFileSync(`${path}.amdahl-backup`, 'utf8')
    const again = await cli(io)
    expect(again.stdout).toContain('✓ Claude Code already has Amdahl\n')
    expect(readFileSync(path, 'utf8')).toBe(written)
    expect(readFileSync(`${path}.amdahl-backup`, 'utf8')).toBe(backup)
  })

  it('points an `amdahl` entry at another URL here, and keeps its other fields', async () => {
    const io = agent()
    const path = join(io.homedir, '.claude.json')
    writeFileSync(path, JSON.stringify({ mcpServers: { amdahl: { type: 'http', url: 'https://old/mcp' } } }))
    await cli(io)
    expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers.amdahl).toEqual({ type: 'http', url })
  })

  it('a new ~/.claude.json is owner-only and needs no backup', async () => {
    const io = agent()
    await cli(io)
    const path = join(io.homedir, '.claude.json')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ mcpServers: { amdahl: { type: 'http', url } } })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(existsSync(`${path}.amdahl-backup`)).toBe(false)
  })

  it('writes in CLAUDE_CONFIG_DIR when it is set, as Claude Code does', async () => {
    const io = agent()
    const dir = join(io.homedir, 'claude-config')
    mkdirSync(dir)
    io.env.CLAUDE_CONFIG_DIR = dir
    await cli(io)
    expect(existsSync(join(dir, '.claude.json'))).toBe(true)
    expect(existsSync(join(io.homedir, '.claude.json'))).toBe(false)
  })

  it('follows a symbolic link (a dotfiles repo) and leaves the link in place', async () => {
    const io = agent()
    mkdirSync(join(io.homedir, 'dotfiles'))
    const real = join(io.homedir, 'dotfiles', 'claude.json')
    writeFileSync(real, '{"keep":1}')
    symlinkSync(real, join(io.homedir, '.claude.json'))
    await cli(io)
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({ keep: 1, mcpServers: { amdahl: { type: 'http', url } } })
    expect(readFileSync(join(io.homedir, '.claude.json'), 'utf8')).toBe(readFileSync(real, 'utf8'))
    expect(lstatSync(join(io.homedir, '.claude.json')).isSymbolicLink()).toBe(true)
    expect(existsSync(`${real}.amdahl-backup`)).toBe(true)
  })

  it.each([['not JSON', '{oops'], ['not an object', '[1,2]']])('leaves a ~/.claude.json that is %s alone (exit 1)', async (_label, text) => {
    const io = agent()
    const path = join(io.homedir, '.claude.json')
    writeFileSync(path, text)
    const r = await cli(io)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(`Error: ${path} `)
    expect(r.stderr).toContain('; not changing it.')
    expect(readFileSync(path, 'utf8')).toBe(text)
    expect(existsSync(`${path}.amdahl-backup`)).toBe(false)
  })

  it('in the menu, a broken ~/.claude.json is found before the sign-in, and nobody is sent to the browser for nothing', async () => {
    const io = await atServer(false)
    writeFileSync(join(io.homedir, '.claude.json'), '{oops')
    io.answers.push('')
    const r = await cli(io)
    expect(r.code).toBe(1)
    expect(io.opened).toEqual([])
    expect(r.stderr).toBe(`Error: ${join(io.homedir, '.claude.json')} is not valid JSON; not changing it.\nFix the file, or move it away, then run the same command again.\n`)
    expect(r.stdout).toBe(TITLE)
  })

  it('in the menu, only the broken client is dropped: the others still sign in and set up', async () => {
    const io = await atServer(false)
    mkdirSync(join(io.homedir, '.cursor'))
    writeFileSync(join(io.homedir, '.cursor', 'mcp.json'), '{oops')
    io.answers.push('2,3')
    const r = await cli(io)
    expect(r.code).toBe(1)
    expect(io.opened).toHaveLength(1)
    expect(r.stdout).toBe(`${TITLE}✓ Signed in · Acme\n✓ Added to Codex\n${CODEX_TRY}\n`)
  })

  it("agu's case: Claude Code found by its folder, not on PATH, not signed in: one sign-in, then Claude Code is set up", async () => {
    const io = await atServer(false)
    mkdirSync(join(io.homedir, '.claude'))
    io.answers.push('')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([menu('x Claude Code |   Cursor |   Codex')])
    expect(r.stdout).toBe(`${TITLE}✓ Signed in · Acme\n✓ Added to Claude Code\n${CLAUDE_TRY}\n`)
    expect(JSON.parse(readFileSync(join(io.homedir, '.claude.json'), 'utf8')).mcpServers.amdahl).toEqual({ type: 'http', url: `${server!.url}/mcp` })
    // Run again: set up, asks nothing, and still names /mcp.
    const again = await cli(io)
    expect(again.stdout).toBe(`${TITLE}You're set up in Claude Code.\n${CLAUDE_TRY}\n`)
    expect(io.prompts).toHaveLength(1)
  })

  it('`amdahl install claude-code` writes the same entry', async () => {
    const io = fakeIo()
    const r = await cli(io, 'install', 'claude-code', '--json')
    expect(r.code).toBe(0)
    expect(r.json).toMatchObject({ ok: true, client: 'claude-code', action: 'wrote', path: join(io.homedir, '.claude.json') })
    expect(JSON.parse(readFileSync(join(io.homedir, '.claude.json'), 'utf8'))).toEqual({ mcpServers: { amdahl: { type: 'http', url: 'https://app.amdahl.ai/mcp' } } })
    expect((await cli(io, 'install', 'claude-code', '--json')).json.action).toBe('unchanged')
  })
})

describe('bare amdahl: what it says when something goes wrong', () => {
  it('Amdahl cannot be reached at the sign-in: names the next step', async () => {
    const io = terminal({ AMDAHL_API_URL: 'http://127.0.0.1:9' })
    io.answers.push('3')
    const r = await cli(io)
    expect(r.code).toBe(8)
    expect(r.stderr).toBe('Error: Could not reach 127.0.0.1:9: fetch failed\nCheck your internet connection, then run the same command again.\n')
  })

  it('under npx, the rejected-key line says `npx amdahl login`', async () => {
    server = await startMockServer()
    const io = terminal({ AMDAHL_API_URL: server.url, AMDAHL_KEY: 'amdhl_rejected', npm_lifecycle_event: 'npx' })
    io.answers.push('3')
    const r = await cli(io)
    expect(r.stderr).toContain('unset it and run `npx amdahl login`.')
  })
})
