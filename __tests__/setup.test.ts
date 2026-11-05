// Bare `amdahl`: the guided setup in a terminal, and the usage (exit 2) everywhere
// else. Detection, the already-set-up path, sign-in, and one `install` per
// ticked client, all through the fake process boundary.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { USAGE } from '../src/args'
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
const CODEX_TRY = 'Try it: run `codex mcp login amdahl`, then open Codex and say "make this email sound less like AI"'
const CLAUDE_TRY = 'Try it: in Claude Code, run /mcp once to connect, then say "make this email sound less like AI"'
const TITLE = 'Amdahl · predictive ML for GTM\n'
const lastLine = (text: string) => text.trimEnd().split('\n').pop()
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
    expect(io.prompts).toEqual(['Set up in: [  Claude Code |   Cursor |   Codex]'])
    expect(r.stderr).not.toContain('Usage:')
  })

  it.each<[string, (io: FakeIo) => void]>([
    ['stdout is not a terminal', (io) => (io.stdoutIsTTY = false)],
    ['stdin is not a terminal', (io) => (io.stdinIsTTY = false)],
    ['stderr, where the menu draws, is not a terminal', (io) => (io.stderrIsTTY = false)],
    ['AMDAHL_NO_PROMPT=1', (io) => (io.env.AMDAHL_NO_PROMPT = '1')],
    ['CI is set', (io) => (io.env.CI = 'true')],
    ['Claude Code runs it (CLAUDECODE)', (io) => (io.env.CLAUDECODE = '1')],
    ['Cursor runs it (CURSOR_AGENT)', (io) => (io.env.CURSOR_AGENT = '1')],
  ])('prints the usage and exits 2 when %s', async (_label, change) => {
    const io = terminal()
    change(io)
    const r = await cli(io)
    expect(r.code).toBe(2)
    expect(r.stderr).toBe(USAGE)
    expect(r.stdout).toBe('')
    expect(io.prompts).toEqual([])
    expect(io.run).not.toHaveBeenCalled()
  })

  it('keeps the usage for a bare global flag such as --json, and --help as it was', async () => {
    const io = terminal()
    const json = await cli(io, '--json')
    expect(json.code).toBe(2)
    expect(json.stderr).toBe(USAGE)
    const noColor = await cli(io, '--no-color')
    expect(noColor.code).toBe(2)
    const help = await cli(io, '--help')
    expect(help).toMatchObject({ code: 0, stdout: USAGE })
    expect(io.prompts).toEqual([])
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
    expect(io.prompts).toEqual(['Set up in: [  Claude Code | x Cursor | x Codex]'])
    // The .cursor folder is enough; PATH is only asked about the other two.
    expect(ran(io, 'which')).toEqual(['claude', 'codex'])
  })

  it('with none found, offers all three unticked', async () => {
    const io = terminal()
    io.answers.push('none')
    const r = await cli(io)
    expect(io.prompts).toEqual(['Set up in: [  Claude Code |   Cursor |   Codex]'])
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
    expect(io.prompts).toEqual(['Set up in: [x Claude Code | x Cursor |   Codex]'])
    expect(ran(io, 'claude')).toEqual(['mcp get amdahl', `mcp add --scope user --transport http amdahl ${server!.url}/mcp`])
    expect(readFileSync(join(io.homedir, '.codex', 'config.toml'), 'utf8')).toContain(`url = "${server!.url}/mcp"`)
    expect(readFileSync(skillAt(io, '.claude', 'skills'), 'utf8')).toBe(SKILL_TEXT)
    expect(readFileSync(skillAt(io, '.agents', 'skills'), 'utf8')).toBe(SKILL_TEXT)
    expect(existsSync(join(io.homedir, '.cursor', 'mcp.json'))).toBe(false)
    // One line a step: no paths, no profile, no notes.
    expect(r.stdout).toBe(`${TITLE}✓ Signed in · Acme\n✓ Added to Claude Code\n✓ Added to Codex\n${CLAUDE_TRY}\n`)
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
    expect(r.stdout.trimEnd().split('\n').pop()).toBe('Try it: open Cursor and say "make this email sound less like AI"')
  })

  it('signs in through the browser first when there is no sign-in, and prints no link when the browser answers', async () => {
    const io = await atServer(false)
    io.answers.push('3')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.opened).toHaveLength(1)
    expect(io.opened[0]).toContain('/oauth/authorize')
    expect(r.stderr).toBe('Opening your browser…\n')
    expect(r.stdout).toBe(`${TITLE}✓ Signed in · Acme\n✓ Added to Codex\n${CODEX_TRY}\n`)
  })

  it('without `claude` on PATH, prints the Claude Code command and tries the next client', async () => {
    const io = await atServer(true)
    io.answers.push('1,2')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`! Claude Code: \`claude\` is not on your PATH. Once it is, run:\n  claude mcp add --scope user --transport http amdahl ${server!.url}/mcp\n✓ Added to Cursor\n`)
    expect(r.stdout.trimEnd().split('\n').pop()).toBe('Try it: open Cursor and say "make this email sound less like AI"')
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
    expect(io.prompts).toEqual(['Set up in: [x Claude Code |   Cursor |   Codex]'])
    expect(ran(io, 'claude').filter((c) => c.startsWith('mcp add'))).toEqual([])
    expect(readFileSync(skillAt(io, '.claude', 'skills'), 'utf8')).toBe(SKILL_TEXT)
    expect(r.stdout).toContain('✓ Claude Code already has Amdahl\n')
    expect(r.stdout + r.stderr).not.toContain('do-not-print')
    expect(lastLine(r.stdout)).toBe('Try it: open Claude Code and say "make this email sound less like AI"')
    // Set up now: the next run asks nothing.
    const again = await cli(io)
    expect(again.stdout).toContain("You're set up in Claude Code.\n")
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
    expect(r.stderr).toBe('Stopped.\n')
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
    expect(r.stdout).toBe(
      'Amdahl · predictive ML for GTM\nYou\'re set up in Claude Code and Cursor.\nTry it: open Claude Code and say "make this email sound less like AI"\n'
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
    expect(r.stdout).toBe(
      'Amdahl · predictive ML for GTM\nYou\'re set up in Cursor. (Could not reach Amdahl to check your sign-in.)\nTry it: open Cursor and say "make this email sound less like AI"\n'
    )
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

  it('with any other flag beside it, prints the usage as before', async () => {
    const io = terminal()
    const r = await cli(io, '--verbose', '--json')
    expect(r.code).toBe(2)
    expect(r.stderr).toBe(USAGE)
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
    expect(r.stderr).toMatch(/^Opening your browser…\nYour browser did not open\. Open this link to sign in:\n\n {2}http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?/)
    expect(r.stdout).toContain('✓ Signed in · Acme\n')
  })

  it('prints the link once the browser has not answered for a while, and keeps waiting', async () => {
    const io = await atServer(false)
    io.browserGraceMs = 20
    slowBrowser(io, 200)
    io.answers.push('3')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(r.stderr.match(/Finish in your browser, or open this link:\n\n {2}http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?/g)).toHaveLength(1)
    expect(r.stdout).toContain('✓ Signed in · Acme\n')
  })

  it('a new user creates their workspace in the browser and lands back in the same setup', async () => {
    server = await startMockServer({ selfServe: true })
    const io = terminal({ AMDAHL_API_URL: server.url })
    io.browserGraceMs = 20
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
    expect(r.stderr).toContain('Finish in your browser, or open this link:')
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
