// Bare `amdahl`: the guided setup in a terminal, the same setup with no
// question for an agent or a pipe, and the usage (exit 2) in CI. Detection,
// the already-set-up path, sign-in, one `install` per ticked client, and
// Claude Code without `claude` on PATH, all through the fake process boundary
// in a temp home.

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { USAGE } from '../src/args'
import { ciVariable } from '../src/ci'
import { PASTE_PROMPT, VERSION_RULE } from '../src/commands/optimize'
import { FOUND_TAG, MENU_HINT, NEW_USER, NONE_FOUND, QUESTION, TERMINAL, noSetupLine, wrapLine } from '../src/commands/setup'
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
const ASK = '"Use Amdahl to make this sound less like AI"'
// What an agent run ends with.
const AGENT_ASK = `paste an email and say ${ASK}`
const CODEX_TRY = `Try it: ${AGENT_ASK} in Codex.\nBefore that, run \`codex mcp login amdahl\` once to connect Amdahl.`
const CURSOR_TRY = `Try it: ${AGENT_ASK} in Cursor.\nBefore that, sign in when Cursor asks, the first time you use Amdahl.`
// What a person's run ends with, for each tool.
const NEW = `${NEW_USER}\n`
const claudeScreen = (already = false) =>
  `${already ? '✓ Claude Code already has Amdahl.' : '✓ Added Amdahl to Claude Code.'}\nOne step left, in Claude Code:\n  1. If it's open, quit and reopen it. Type /mcp, pick amdahl, sign in.\n  2. Paste an email and say: ${ASK}\n`
const cursorScreen = (already = false) =>
  `${already ? '✓ Cursor already has Amdahl.' : '✓ Added Amdahl to Cursor.'}\nOne step left, in Cursor:\n  1. If it's open, quit and reopen it. In Customize > MCPs, sign in to amdahl.\n  2. In chat, paste an email, say: ${ASK}\n`
/** Codex without `codex` on PATH: the steps, to run by hand. */
const codexSteps = (lead = NEW, already = false) =>
  `${already ? '✓ Codex already has Amdahl.' : '✓ Added Amdahl to Codex.'}\n${lead}One step left, in your terminal:\n  1. Run: codex mcp login amdahl\n  2. In codex, paste an email, say: ${ASK}\n`
const TITLE = 'Amdahl · predictive ML for GTM\n'
const HINT = "Browser didn't open? Press Enter for the link.\n"
// A finished sign-in erases the one-line hint: up one line, clear to the end of the screen.
const ERASE = '\r\u001b[1A\u001b[0J'
const REWRITING = 'Amdahl is rewriting it. This can take a minute.\n'
const NEXT_TIME = 'Next time: amdahl optimize draft.txt\n'
/** The menu as the fake records it: the three tools, then "This terminal". */
const menu = (rows: string) => `${QUESTION} [${rows} |   ${TERMINAL}]`
const ran = (io: FakeIo, command: string) => io.run.mock.calls.filter((c) => c[0] === command).map((c) => (c[1] as string[]).join(' '))
const NOTHING_PICKED = `Nothing picked, so nothing changed.\nTo try it here, run amdahl again and tick "This terminal".\nUsing the Claude or ChatGPT app? Connect it at https://amdahl.ai/connect\n`

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
    expect(r.stdout).toBe(`${TITLE}${NOTHING_PICKED}`)
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

  it.each<[Record<string, string>, string]>([
    [{ JENKINS_URL: 'https://jenkins.example.com/' }, 'JENKINS_URL'],
    [{ BUILD_NUMBER: '42', JENKINS_HOME: '/var/jenkins_home' }, 'BUILD_NUMBER with JENKINS_HOME'],
    [{ TF_BUILD: 'True' }, 'TF_BUILD'],
    [{ CODEBUILD_BUILD_ID: 'proj:0b1c' }, 'CODEBUILD_BUILD_ID'],
    [{ TEAMCITY_VERSION: '2025.07' }, 'TEAMCITY_VERSION'],
    [{ GITHUB_ACTIONS: 'true' }, 'GITHUB_ACTIONS'],
    [{ GITLAB_CI: 'true' }, 'GITLAB_CI'],
    [{ BUILDKITE: 'true' }, 'BUILDKITE'],
    [{ CIRCLECI: 'true' }, 'CIRCLECI'],
  ])('a CI system that may not set CI (%o) is CI: usage, exit 2, nothing written', async (vars, name) => {
    expect(ciVariable(vars)).toBe(name)
    // With no terminal, as on a build agent: without the check this would set up every client found.
    const io = noTerminal(vars)
    for (const dir of ['.claude', '.cursor', '.codex']) mkdirSync(join(io.homedir, dir))
    const r = await cli(io)
    expect(r.code).toBe(2)
    expect(r.stderr).toBe(`${noSetupLine(`${name} is set`)}${USAGE}`)
    expect(r.stdout).toBe('')
    expect(io.run).not.toHaveBeenCalled()
    expect(existsSync(join(io.homedir, '.claude.json'))).toBe(false)
    expect(existsSync(join(io.homedir, '.cursor', 'mcp.json'))).toBe(false)
    expect(existsSync(join(io.homedir, '.codex', 'config.toml'))).toBe(false)
  })

  it('is not CI for BUILD_NUMBER alone, or a CI variable set to false or 0', async () => {
    for (const env of [{ BUILD_NUMBER: '42' }, { GITHUB_ACTIONS: 'false' }, { TF_BUILD: '0' }, { CI: 'false' }, {}]) {
      expect(ciVariable(env)).toBeNull()
    }
    const io = noTerminal({ BUILD_NUMBER: '42', AMDAHL_API_URL: 'http://127.0.0.1:9' })
    mkdirSync(join(io.homedir, '.cursor'))
    expect((await cli(io)).code).toBe(0)
    expect(existsSync(join(io.homedir, '.cursor', 'mcp.json'))).toBe(true)
  })

  it('keeps the usage for --json, takes --no-color, and --help is as it was', async () => {
    const io = terminal()
    const json = await cli(io, '--json')
    expect(json.code).toBe(2)
    expect(json.stderr).toBe(`${noSetupLine('it has no --json output')}${USAGE}`)
    io.answers.push('none')
    const noColor = await cli(io, '--no-color')
    expect(noColor).toMatchObject({ code: 0, stdout: `${TITLE}${NOTHING_PICKED}` })
    const help = await cli(io, '--help')
    expect(help).toMatchObject({ code: 0, stdout: USAGE })
    expect(io.prompts).toHaveLength(1)
  })

  it('`amdahl setup` is bare `amdahl`', async () => {
    const io = terminal()
    io.answers.push('none')
    expect(await cli(io, 'setup')).toMatchObject({ code: 0, stdout: `${TITLE}${NOTHING_PICKED}` })
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
    await cli(io)
    expect(io.prompts).toEqual([menu('  Claude Code | x Cursor | x Codex')])
    // The .cursor folder is enough; PATH is only asked about the other two.
    expect(ran(io, 'which')).toEqual(['claude', 'codex'])
  })

  it('with none found, offers all three and this terminal, unticked, and the marker starts on this terminal', async () => {
    const io = terminal()
    io.answers.push('none')
    const r = await cli(io)
    expect(io.prompts).toEqual([menu('  Claude Code |   Cursor |   Codex')])
    expect(io.tickOptions[0]).toMatchObject({ ticked: [false, false, false, false], initial: 3, note: NONE_FOUND })
    expect(r.stdout).toBe(`${TITLE}${NOTHING_PICKED}`)
    expect(existsSync(join(io.homedir, '.claude'))).toBe(false)
  })

  it('under npx, the empty pick names `npx -y amdahl`', async () => {
    const io = terminal({ npm_command: 'exec' })
    io.answers.push('none')
    const r = await cli(io)
    expect(r.stdout).toContain('To try it here, run npx -y amdahl again and tick "This terminal".\n')
  })
})

describe('bare amdahl: setting up the AI tools', () => {
  it('sets up each ticked tool, and only those, with no sign-in here, then numbered steps for each', async () => {
    const io = await atServer(false)
    mkdirSync(join(io.homedir, '.cursor'))
    commands(io, ['claude'])
    io.answers.push('1,3') // Claude Code and Codex; Cursor was found but is left unticked
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([menu('x Claude Code | x Cursor |   Codex')])
    expect(io.opened).toEqual([])
    expect(server!.log.filter((l) => l.path.startsWith('/oauth') || l.path.includes('/cli/'))).toEqual([])
    expect(ran(io, 'claude')).toEqual(['mcp get amdahl', `mcp add --scope user --transport http amdahl ${server!.url}/mcp`])
    expect(readFileSync(join(io.homedir, '.codex', 'config.toml'), 'utf8')).toContain(`url = "${server!.url}/mcp"`)
    expect(readFileSync(skillAt(io, '.claude', 'skills'), 'utf8')).toBe(SKILL_TEXT)
    expect(readFileSync(skillAt(io, '.agents', 'skills'), 'utf8')).toBe(SKILL_TEXT)
    expect(existsSync(join(io.homedir, '.cursor', 'mcp.json'))).toBe(false)
    // One screen a tool, no paths, no profile, no notes; the new-user line once.
    expect(r.stdout).toBe(`${TITLE}${claudeScreen()}${NEW}\n${codexSteps('')}`)
    expect(r.stderr).toBe('')
    // Each screen is six lines or fewer.
    for (const screen of r.stdout.slice(TITLE.length).split('\n\n')) expect(screen.trimEnd().split('\n').length).toBeLessThanOrEqual(6)
  })

  it.each([
    ['with `codex` on PATH', ['codex']],
    ['without it', []],
  ])('every line of every tool screen fits 80 columns, %s', async (_label, path) => {
    const io = await atServer(false)
    commands(io, path)
    io.enters.push(true)
    io.answers.push('1,2,3')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(r.stdout.split('\n').filter((line) => [...line].length > 80)).toEqual([])
  })

  it('in a terminal narrower than a screen, breaks lines between words, under the text of a numbered step', async () => {
    const io = await atServer(false)
    io.columns = () => 60
    mkdirSync(join(io.homedir, '.claude'))
    io.answers.push('')
    const r = await cli(io)
    expect(r.stdout).toBe(
      `${TITLE}✓ Added Amdahl to Claude Code.\nOne step left, in Claude Code:\n  1. If it's open, quit and reopen it. Type /mcp, pick\n     amdahl, sign in.\n  2. Paste an email and say: "Use Amdahl to make this sound\n     less like AI"\nNew to Amdahl? The sign-in sets up your free workspace.\n`
    )
    expect(wrapLine('x'.repeat(70), 60)).toEqual(['x'.repeat(70)])
    expect(wrapLine('short', undefined)).toEqual(['short'])
  })

  it('Claude Code alone: the screen agu asked for, and nothing written before the pick', async () => {
    const io = await atServer(false)
    mkdirSync(join(io.homedir, '.claude'))
    io.answers.push('')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(
      `${TITLE}✓ Added Amdahl to Claude Code.\nOne step left, in Claude Code:\n  1. If it's open, quit and reopen it. Type /mcp, pick amdahl, sign in.\n  2. Paste an email and say: "Use Amdahl to make this sound less like AI"\nNew to Amdahl? The sign-in sets up your free workspace.\n`
    )
    expect(io.opened).toEqual([])
    expect(JSON.parse(readFileSync(join(io.homedir, '.claude.json'), 'utf8')).mcpServers.amdahl).toEqual({ type: 'http', url: `${server!.url}/mcp` })
  })

  it('Cursor alone: its own screen', async () => {
    const io = await atServer(false)
    mkdirSync(join(io.homedir, '.cursor'))
    io.answers.push('')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(JSON.parse(readFileSync(join(io.homedir, '.cursor', 'mcp.json'), 'utf8'))).toEqual({ mcpServers: { amdahl: { url: `${server!.url}/mcp` } } })
    expect(existsSync(join(io.homedir, '.codex'))).toBe(false)
    expect(r.stdout).toBe(`${TITLE}${cursorScreen()}${NEW}`)
    expect(io.opened).toEqual([])
  })

  it('Codex on PATH: Enter runs `codex mcp login amdahl` on this terminal, then the one thing to try', async () => {
    const io = await atServer(false)
    commands(io, ['codex'])
    io.enters.push(true)
    io.answers.push('')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.runInteractive.mock.calls).toEqual([['codex', ['mcp', 'login', 'amdahl']]])
    expect(r.stdout).toBe(
      `${TITLE}✓ Added Amdahl to Codex.\n${NEW}Press Enter to sign Codex in to Amdahl (opens your browser).\n✓ Codex is connected.\nRun codex, paste an email and say: ${ASK}\n`
    )
    expect(io.opened).toEqual([])
    expect(io.keys).toBeNull()
  })

  it('Codex on PATH: a sign-in that does not finish says how to try again', async () => {
    const io = await atServer(false)
    commands(io, ['codex'])
    io.runInteractive.mockResolvedValue(1)
    io.enters.push(true)
    io.answers.push('')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("Press Enter to sign Codex in to Amdahl (opens your browser).\n\nCodex didn't finish signing in. To try again, run: codex mcp login amdahl\nRun codex, paste an email and say:")
  })

  it('Codex on PATH: Ctrl+C at "Press Enter" skips its sign-in and says how to do it later', async () => {
    const io = await atServer(false)
    commands(io, ['codex'])
    io.enters.push(false)
    io.answers.push('')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.runInteractive).not.toHaveBeenCalled()
    expect(r.stdout).toContain(`Skipped. To connect it later, run: codex mcp login amdahl\nRun codex, paste an email and say: ${ASK}\n`)
    expect(readFileSync(join(io.homedir, '.codex', 'config.toml'), 'utf8')).toContain('[mcp_servers.amdahl]')
  })

  it('Codex on PATH on Windows: no Enter offer (its `.cmd` shim cannot be spawned), the login step to run by hand', async () => {
    const io = await atServer(false)
    io.platform = 'win32'
    io.run.mockImplementation(async (command: string, args: string[]) => ({ code: command === 'where' && args[0] === 'codex' ? 0 : 1, stdout: '', stderr: '' }))
    io.answers.push('')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`${TITLE}${codexSteps()}`)
    expect(io.runInteractive).not.toHaveBeenCalled()
  })

  it('Codex found by its folder only: the login step to run by hand', async () => {
    const io = await atServer(false)
    mkdirSync(join(io.homedir, '.codex'))
    io.answers.push('')
    const r = await cli(io)
    expect(r.stdout).toBe(`${TITLE}${codexSteps()}`)
    expect(io.runInteractive).not.toHaveBeenCalled()
  })

  it('without `claude` anywhere, adds Amdahl to Claude Code\'s settings file itself, then the next tool', async () => {
    const io = await atServer(false)
    io.answers.push('1,2')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`${TITLE}${claudeScreen()}${NEW}\n${cursorScreen()}`)
    expect(r.stdout).not.toContain('PATH')
    expect(JSON.parse(readFileSync(join(io.homedir, '.claude.json'), 'utf8'))).toEqual({ mcpServers: { amdahl: { type: 'http', url: `${server!.url}/mcp` } } })
  })

  it('a tool that fails does not stop the others, and sets the exit code', async () => {
    const io = await atServer(false)
    mkdirSync(join(io.homedir, '.cursor'))
    writeFileSync(join(io.homedir, '.cursor', 'mcp.json'), '{not json')
    io.answers.push('2,3')
    const r = await cli(io)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(`Error: ${join(io.homedir, '.cursor', 'mcp.json')} is not valid JSON; not changing it.`)
    expect(readFileSync(join(io.homedir, '.codex', 'config.toml'), 'utf8')).toContain('[mcp_servers.amdahl]')
    expect(r.stdout).toBe(`${TITLE}${codexSteps()}`)
  })

  it.each<[string, string | null]>([
    ['missing', null],
    ['an old shipped copy', OLD_SKILL],
  ])('Claude Code with Amdahl already added and the skill %s: the run asks nothing and brings the skill up to date', async (_label, skill) => {
    const io = await atServer(false)
    commands(io, ['claude'], `${server!.url}/mcp`)
    if (skill !== null) {
      mkdirSync(join(io.homedir, '.claude', 'skills', 'amdahl'), { recursive: true })
      writeFileSync(skillAt(io, '.claude', 'skills'), skill)
    }
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([])
    expect(ran(io, 'claude').filter((c) => c.startsWith('mcp add'))).toEqual([])
    expect(readFileSync(skillAt(io, '.claude', 'skills'), 'utf8')).toBe(SKILL_TEXT)
    expect(r.stdout).toContain("Amdahl is in Claude Code. You're all set.\n")
    expect(r.stdout + r.stderr).not.toContain('do-not-print')
  })

  it('a tool already set up beside one that is not: the menu, and "already has Amdahl" on its screen', async () => {
    const io = await atServer(false)
    cursorSetUp(io, `${server!.url}/mcp`)
    mkdirSync(join(io.homedir, '.claude'))
    io.answers.push('')
    const r = await cli(io)
    expect(io.prompts).toEqual([menu('x Claude Code | x Cursor |   Codex')])
    expect(r.stdout).toBe(`${TITLE}${claudeScreen()}${NEW}\n${cursorScreen(true)}`)
  })

  it('a file it cannot write is that tool\'s error (exit 1), and the next tool still runs', async () => {
    const io = await atServer(false)
    writeFileSync(join(io.homedir, '.cursor'), 'a file where the folder should be')
    io.answers.push('2,3')
    const r = await cli(io)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(`Error: Could not update ${join(io.homedir, '.cursor', 'mcp.json')} (`)
    expect(r.stderr).not.toContain('Could not reach the Amdahl API')
    expect(readFileSync(join(io.homedir, '.codex', 'config.toml'), 'utf8')).toContain('[mcp_servers.amdahl]')
    expect(r.stdout).toBe(`${TITLE}${codexSteps()}`)
  })

  it('an unexpected failure is reported for that tool, and the next tool still runs', async () => {
    const io = await atServer(false)
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
    expect(r.stdout).toBe(`${TITLE}${codexSteps()}`)
  })

  it('a key in the environment that Amdahl rejects does not matter to the tools: they set up', async () => {
    const io = await atServer(false, { AMDAHL_KEY: 'amdhl_rejected' })
    io.answers.push('3')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.opened).toEqual([])
    expect(r.stdout + r.stderr).not.toContain('amdhl_rejected')
    expect(existsSync(join(io.homedir, '.codex', 'config.toml'))).toBe(true)
  })

  it('works offline: the tools need nothing from Amdahl', async () => {
    const io = terminal({ AMDAHL_API_URL: 'http://127.0.0.1:9' })
    mkdirSync(join(io.homedir, '.cursor'))
    io.answers.push('')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`${TITLE}${cursorScreen()}${NEW}`)
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
  it('one tool: says so, the one thing to try, and how to finish if its sign-in is not done', async () => {
    const io = await atServer(false)
    cursorSetUp(io, `${server!.url}/mcp`)
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([])
    expect(io.opened).toEqual([])
    expect(r.stdout).toBe(
      `${TITLE}Amdahl is in Cursor. You're all set.\nPaste an email there and say: ${ASK}\nIf you've already signed in under Customize > MCPs, you're done.\nIf not: quit and reopen Cursor, then sign in to amdahl there.\nWant to try it here instead? Run: amdahl optimize\n`
    )
  })

  it('signed in here: the try-it line becomes what to do next in this terminal; an agent run is unchanged', async () => {
    const io = await atServer(true)
    cursorSetUp(io, `${server!.url}/mcp`)
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([])
    expect(r.stdout).toBe(
      `${TITLE}Amdahl is in Cursor. You're all set.\nPaste an email there and say: ${ASK}\nIf you've already signed in under Customize > MCPs, you're done.\nIf not: quit and reopen Cursor, then sign in to amdahl there.\nTry it here: amdahl optimize or amdahl search "your question"\nAdd data: amdahl connect, see it all: amdahl open\n`
    )
    // Reads no network: the saved sign-in is enough.
    const before = server!.log.length
    await cli(io)
    expect(server!.log.length).toBe(before)
    const npx = await cli(Object.assign(io, { env: { ...io.env, npm_command: 'exec' } }))
    for (const line of npx.stdout.split('\n')) expect(line.length).toBeLessThanOrEqual(80)
    const agent = await cli(Object.assign(io, { stdinIsTTY: false, env: { ...io.env, npm_command: undefined } }))
    expect(agent.stdout).toBe(`${TITLE}✓ Cursor already has Amdahl\n${CURSOR_TRY}\n`)
  })

  it('Claude Code set up by an agent, never signed in here: all set, with no menu and no sign-in', async () => {
    const io = await atServer(false, { npm_command: 'exec' })
    mkdirSync(join(io.homedir, '.claude'))
    // Yesterday's agent run.
    const agent = await cli(Object.assign(io, { stdinIsTTY: false }))
    expect(agent.code).toBe(0)
    io.stdinIsTTY = true
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([])
    expect(io.opened).toEqual([])
    expect(r.stdout).toBe(
      `${TITLE}Amdahl is in Claude Code. You're all set.\nPaste an email there and say: ${ASK}\nIf you've already run /mcp, you're done.\nIf not: quit and reopen Claude Code, type /mcp, pick amdahl, sign in.\nWant to try it here instead? Run: npx -y amdahl optimize\n`
    )
    for (const line of r.stdout.split('\n')) expect(line.length).toBeLessThanOrEqual(80)
  })

  it('Codex: names its login command', async () => {
    const io = await atServer(false)
    mkdirSync(join(io.homedir, '.codex'))
    writeFileSync(join(io.homedir, '.codex', 'config.toml'), `[mcp_servers.amdahl]\nurl = "${server!.url}/mcp"\n`)
    mkdirSync(join(io.homedir, '.agents', 'skills', 'amdahl'), { recursive: true })
    writeFileSync(skillAt(io, '.agents', 'skills'), SKILL_TEXT)
    const r = await cli(io)
    expect(io.prompts).toEqual([])
    expect(r.stdout).toContain("Amdahl is in Codex. You're all set.\nPaste an email there and say:")
    expect(r.stdout).toContain("If you've already run codex mcp login amdahl, you're done.\n")
  })

  it('several tools: the step for each, in one list', async () => {
    const io = await atServer(false)
    cursorSetUp(io, `${server!.url}/mcp`)
    commands(io, ['claude'], `${server!.url}/mcp`)
    mkdirSync(join(io.homedir, '.claude', 'skills', 'amdahl'), { recursive: true })
    writeFileSync(skillAt(io, '.claude', 'skills'), SKILL_TEXT)
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([])
    expect(r.stdout).toBe(
      `${TITLE}Amdahl is in Claude Code and Cursor. You're all set.\nPaste an email in either and say: ${ASK}\nIf you've already signed each one in, you're done. If not:\n  Claude Code: quit and reopen it, type /mcp, pick amdahl, sign in\n  Cursor: quit and reopen it, then in Customize > MCPs, sign in to amdahl\nWant to try it here instead? Run: amdahl optimize\n`
    )
    expect(r.stdout + r.stderr).not.toContain('do-not-print')
    expect(ran(io, 'claude')).toEqual(['mcp get amdahl'])
  })

  it.each<[string, (io: FakeIo, mcpUrl: string) => void]>([
    ['a found tool is not set up', (io) => mkdirSync(join(io.homedir, '.codex'))],
    ['Cursor points elsewhere', (io) => writeFileSync(join(io.homedir, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { amdahl: { url: 'https://elsewhere/mcp' } } }))],
    ['Claude Code has no amdahl server', (io) => commands(io, ['claude'])],
  ])('asks again when %s', async (_label, change) => {
    const io = await atServer(false)
    cursorSetUp(io, `${server!.url}/mcp`)
    commands(io, [])
    change(io, `${server!.url}/mcp`)
    io.answers.push('none')
    await cli(io)
    expect(io.prompts).toHaveLength(1)
  })

  it('a missing skill alone does not ask again: it is put back quietly', async () => {
    const io = await atServer(false)
    cursorSetUp(io, `${server!.url}/mcp`)
    rmSync(skillAt(io, '.cursor', 'skills'))
    const r = await cli(io)
    expect(io.prompts).toEqual([])
    expect(readFileSync(skillAt(io, '.cursor', 'skills'), 'utf8')).toBe(SKILL_TEXT)
    expect(r.stdout).toContain("Amdahl is in Cursor. You're all set.\n")
  })

  it('needs no network', async () => {
    const io = terminal({ AMDAHL_API_URL: 'http://127.0.0.1:9' })
    cursorSetUp(io, 'http://127.0.0.1:9/mcp')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("Amdahl is in Cursor. You're all set.\n")
  })
})

describe('bare amdahl: this terminal', () => {
  it('signs in through the browser, asks for a paste, and shows Amdahl\'s version', async () => {
    const io = await atServer(false)
    io.answers.push('4', 'Hi Sam,\n\nQuick question about Q3.')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.opened).toHaveLength(1)
    expect(io.prompts).toEqual([menu('  Claude Code |   Cursor |   Codex'), PASTE_PROMPT])
    expect(PASTE_PROMPT).toBe('Paste an email or LinkedIn message, then press Enter on an empty line:')
    expect(r.stdout).toBe(`${TITLE}${NEW}✓ Signed in · Acme\nbetter: Hi Sam,\n\nQuick question about Q3.\n`)
    expect(r.stderr).toBe(`Opening your browser…\n${HINT}${ERASE}${REWRITING}${VERSION_RULE}\nRun: r1\nSent it? amdahl sent r1\nOr say how it went: amdahl feedback r1\n${NEXT_TIME}`)
    const bodies = server!.log.filter((l) => l.path.endsWith('/messages/optimize')).map((l) => JSON.parse(l.body))
    expect(bodies).toEqual([{ message: 'Hi Sam,\n\nQuick question about Q3.' }])
  })

  it('prints what Amdahl did under the message, and the pbpaste line on a Mac', async () => {
    server = await startMockServer({ optimizeResult: { ok: true, message: 'Hi Sam, short one.', what_changed: 'Wrote this message from the context you sent.', omitted: [{ what: 'a', why: 'Nothing you sent backs it.' }] } })
    const io = terminal({ AMDAHL_API_URL: server.url, npm_command: 'exec' })
    io.platform = 'darwin'
    io.answers.push('4', 'draft')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(r.stderr.endsWith(`${VERSION_RULE}\nLeft out 1 thing: Nothing you sent backs it.\nNext time: npx -y amdahl optimize draft.txt,\nor pbpaste | npx -y amdahl optimize -\n`)).toBe(true)
  })

  it('already signed in: says so, and asks for the paste with no browser', async () => {
    const io = await atServer(true)
    io.answers.push('4', 'draft')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.opened).toEqual([])
    expect(r.stdout).toBe(`${TITLE}✓ Signed in · Acme\nbetter: draft\n`)
  })

  it('with a tool: the tool first, with no sign-in for it, then the try-out', async () => {
    const io = await atServer(false)
    mkdirSync(join(io.homedir, '.cursor'))
    io.answers.push('2,4', 'draft')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.opened).toHaveLength(1)
    expect(r.stdout).toBe(`${TITLE}${cursorScreen()}${NEW}\n✓ Signed in · Acme\nbetter: draft\n`)
    expect(existsSync(join(io.homedir, '.cursor', 'mcp.json'))).toBe(true)
  })

  it('nothing pasted: sends nothing and says how to try it later', async () => {
    const io = await atServer(true)
    io.answers.push('4', '')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(server!.log.filter((l) => l.path.endsWith('/messages/optimize'))).toEqual([])
    expect(r.stderr).toBe(`Nothing pasted, so nothing was sent.\n${NEXT_TIME}`)
  })

  it('an optimizer that cannot rewrite it: its reason, exit 1', async () => {
    server = await startMockServer({ optimizeResult: { ok: false, reason: 'optimizer_timeout', detail: 'Took too long.' } })
    const io = terminal({ AMDAHL_API_URL: server.url })
    expect((await cli(io, 'login', '--json')).code).toBe(0)
    io.answers.push('4', 'draft')
    const r = await cli(io)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Not optimized (optimizer_timeout): Took too long.\n')
  })

  it('Ctrl+C at the paste, with a tool set up: says the tool is still set up (exit 130)', async () => {
    const io = await atServer(true)
    mkdirSync(join(io.homedir, '.cursor'))
    io.answers.push('2,4', null)
    const r = await cli(io)
    expect(r.code).toBe(130)
    expect(r.stderr).toBe('Stopped. Amdahl is still set up in Cursor.\n')
    expect(existsSync(join(io.homedir, '.cursor', 'mcp.json'))).toBe(true)
  })

  it('Ctrl+C at the paste, alone: nothing changed', async () => {
    const io = await atServer(true)
    io.answers.push('4', null)
    const r = await cli(io)
    expect(r.code).toBe(130)
    expect(r.stderr).toBe('Stopped. Nothing changed.\n')
  })

  it('a key in the environment that Amdahl rejects: says so, opens no browser, sends nothing (exit 3)', async () => {
    const io = await atServer(false, { AMDAHL_KEY: 'amdhl_rejected', npm_lifecycle_event: 'npx' })
    io.answers.push('4')
    const r = await cli(io)
    expect(r.code).toBe(3)
    expect(io.opened).toEqual([])
    expect(r.stderr).toBe("Amdahl rejected the key in AMDAHL_KEY, so a message can't be tried here. Fix it, or unset it and run `npx -y amdahl login`.\n")
    expect(r.stdout + r.stderr).not.toContain('amdhl_rejected')
  })

  it('Amdahl cannot be reached at the sign-in: names the next step', async () => {
    const io = terminal({ AMDAHL_API_URL: 'http://127.0.0.1:9' })
    io.answers.push('4')
    const r = await cli(io)
    expect(r.code).toBe(8)
    expect(r.stderr).toBe('Error: Could not reach 127.0.0.1:9: fetch failed\nCheck your internet connection, then run the same command again.\n')
  })
})

describe('bare amdahl: --verbose', () => {
  it('is the one flag that still runs the setup, and it adds the files and the profile', async () => {
    const io = await atServer(false)
    mkdirSync(join(io.homedir, '.codex'))
    io.answers.push('3,4', 'draft')
    const r = await cli(io, '--verbose')
    expect(r.code).toBe(0)
    expect(io.prompts).toHaveLength(2)
    expect(r.stdout).toContain('✓ Signed in · Acme\n  Signed in as dev@example.com to Acme (acme). Profile: acme.\n')
    expect(r.stdout).toContain(`✓ Added Amdahl to Codex.\n  Added Amdahl to ${join(io.homedir, '.codex', 'config.toml')}.`)
    expect(r.stdout).toContain(skillAt(io, '.agents', 'skills'))
  })

  it('without --verbose, no path, profile or email is printed', async () => {
    const io = await atServer(false)
    io.answers.push('1,2,3,4', 'draft')
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
    io.answers.push('4', '')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(r.stderr).toMatch(/^Opening your browser…\nBrowser didn't open\? Press Enter for the link\.\nYour browser did not open\. Open this link to sign in:\n\n {2}http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?/)
    expect(r.stdout).toContain('✓ Signed in · Acme\n')
  })

  it('Enter prints the link once, and it keeps waiting', async () => {
    const io = await atServer(false)
    slowBrowser(io, 200)
    io.answers.push('4', '')
    const run = cli(io)
    await vi.waitFor(() => expect(io.keys).not.toBeNull())
    io.keys!.enter()
    io.keys!.enter()
    const r = await run
    expect(r.code).toBe(0)
    expect(r.stderr).toBe(`Opening your browser…\n${HINT}Open this link to sign in:\n\n  ${io.opened[0]}\nNothing pasted, so nothing was sent.\n${NEXT_TIME}`)
    expect(r.stdout).toContain('✓ Signed in · Acme\n')
    expect(io.keys).toBeNull()
  })

  it('Ctrl+C while it waits stops (exit 130), and lets go of the terminal', async () => {
    const io = await atServer(false)
    slowBrowser(io, 0, true, async () => {})
    io.answers.push('4')
    const run = cli(io)
    await vi.waitFor(() => expect(io.keys).not.toBeNull())
    io.keys!.cancel()
    const r = await run
    expect(r.code).toBe(130)
    expect(r.stderr).toBe(`Opening your browser…\n${HINT}Stopped. Nothing changed.\n`)
    expect(r.stdout).toBe(`${TITLE}${NEW}`)
    expect(io.keys).toBeNull()
  })

  it('Ctrl+C while it waits, with a tool set up first: the tool stays set up, and it says so', async () => {
    const io = await atServer(false)
    mkdirSync(join(io.homedir, '.cursor'))
    slowBrowser(io, 0, true, async () => {})
    io.answers.push('2,4')
    const run = cli(io)
    await vi.waitFor(() => expect(io.keys).not.toBeNull())
    io.keys!.cancel()
    const r = await run
    expect(r.code).toBe(130)
    expect(r.stderr).toBe(`Opening your browser…\n${HINT}Stopped. Amdahl is still set up in Cursor.\n`)
    expect(existsSync(join(io.homedir, '.cursor', 'mcp.json'))).toBe(true)
  })

  it('in a terminal that shows hyperlinks, the line links the sign-in page, and Enter still prints the link', async () => {
    server = await startMockServer()
    const io = terminal({ AMDAHL_API_URL: server.url, NO_COLOR: undefined, TERM_PROGRAM: 'iTerm.app' })
    slowBrowser(io, 200)
    io.answers.push('4', '')
    const run = cli(io)
    await vi.waitFor(() => expect(io.keys).not.toBeNull())
    const url = io.opened[0]!
    io.keys!.enter()
    const r = await run
    expect(r.code).toBe(0)
    expect(r.stderr).toBe(
      `Opening your browser…\nBrowser didn't open? \u001b]8;;${url}\u001b\\Open the sign-in page\u001b]8;;\u001b\\\nOpen this link to sign in:\n\n  ${url}\nNothing pasted, so nothing was sent.\n${NEXT_TIME}`
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
    io.answers.push('4', 'draft')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(r.stderr.startsWith(`Opening your browser…\n${HINT}${ERASE}`)).toBe(true)
    expect(r.stdout).toBe(`${TITLE}${NEW}✓ Signed in · Acme\nbetter: draft\n`)
  })

  it('a sign-in the server gives no workspace stops with its one next step (exit 5)', async () => {
    server = await startMockServer({ noBusiness: { mayCreate: false, reason: 'invite_only' } })
    const io = terminal({ AMDAHL_API_URL: server.url })
    io.answers.push('4')
    const r = await cli(io)
    expect(r.code).toBe(5)
    expect(r.stderr).toContain("Error: Your company's Amdahl workspace is invite-only. Ask a colleague in it to invite you, then try again.\n")
    expect(io.prompts).toHaveLength(1)
  })

  it('a personal email: the page offers another sign-in, and the setup finishes in the same run', async () => {
    server = await startMockServer({ noBusiness: { mayCreate: false, reason: 'not_work_email', times: 1 } })
    const io = terminal({ AMDAHL_API_URL: server.url })
    // First visit: refused. The person picks "Sign in with your work email →", which returns to the same authorize URL.
    slowBrowser(io, 0, true, async (url) => {
      await followAuthorize(url)
      await followAuthorize(url)
    })
    io.answers.push('4', 'draft')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(r.stderr).toMatch(/Amdahl needs your work email\. Sign in with your work email:\n\n {2}http:\/\/127\.0\.0\.1:\d+\/login\?redirect=%2Foauth%2Fauthorize%3F\S+\n/)
    expect(r.stdout).toBe(`${TITLE}${NEW}✓ Signed in · Acme\nbetter: draft\n`)
  })

  it('prints no control characters from the server: a workspace name cannot drive the terminal', async () => {
    server = await startMockServer({ workspaceName: 'Acme\u001b]0;pwned\u0007\u001b[2J' })
    const io = terminal({ AMDAHL_API_URL: server.url })
    io.answers.push('4', 'draft')
    const r = await cli(io, '--verbose')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('✓ Signed in · Acme]0;pwned[2J\n')
    expect(r.stdout).not.toMatch(/[\u0000-\u0009\u000b-\u001f]/)
    io.answers.push('4', 'draft')
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
    expect(r.stdout).toBe(`${TITLE}✓ Added to Claude Code\nTry it: paste an email and say "Use Amdahl to make this sound less like AI" in Claude Code.\nBefore that, restart Claude Code and run /mcp once to connect Amdahl.\n`)
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
      `${TITLE}✓ Added to Claude Code\n✓ Added to Codex\nTry it: ${AGENT_ASK} in any of them.\nBefore that, connect each one once:\n  Claude Code: run /mcp\n  Codex: run \`codex mcp login amdahl\`\n`
    )
  })

  it('all three, run again: says each is already there, and still names every step', async () => {
    const io = noTerminal(offline)
    for (const dir of ['.claude', '.cursor', '.codex']) mkdirSync(join(io.homedir, dir))
    expect((await cli(io)).code).toBe(0)
    const again = await cli(io)
    expect(again.code).toBe(0)
    expect(again.stdout).toBe(
      `${TITLE}✓ Claude Code already has Amdahl\n✓ Cursor already has Amdahl\n✓ Codex already has Amdahl\nTry it: ${AGENT_ASK} in any of them.\nBefore that, connect each one once:\n  Claude Code: run /mcp\n  Cursor: sign in when it asks, on first use\n  Codex: run \`codex mcp login amdahl\`\n`
    )
  })

  it('finds none: says so, names the install command, writes nothing, exits 1', async () => {
    const io = noTerminal({ ...offline, npm_command: 'exec' })
    const r = await cli(io)
    expect(r.code).toBe(1)
    expect(r.stdout).toBe(TITLE)
    expect(r.stderr).toBe("Didn't find Claude Code, Cursor or Codex on this computer, so nothing changed.\nTo set up a client, run `npx -y amdahl install claude-code` (or cursor, codex).\n")
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
  it('asks where Amdahl should work, tags and ticks only the tools it found, then this terminal, with the hint to continue', async () => {
    const io = terminal()
    mkdirSync(join(io.homedir, '.claude'))
    io.answers.push('none')
    await cli(io)
    expect(io.prompts).toEqual([menu('x Claude Code |   Cursor |   Codex')])
    expect(io.tickOptions[0]).toEqual({
      ticked: [true, false, false, false],
      tags: [FOUND_TAG, undefined, undefined, undefined],
      note: undefined,
      initial: undefined,
      hint: MENU_HINT,
      color: false,
    })
    expect([QUESTION, TERMINAL, FOUND_TAG, MENU_HINT]).toEqual(['Where should Amdahl work?', 'This terminal', 'found on your machine', '↑↓ move · Space tick/untick · Enter continue'])
  })

  it('found none: says so under the question, offers amdahl.ai/connect for the apps, and ticks none', async () => {
    const io = terminal()
    io.answers.push('none')
    await cli(io)
    expect(io.tickOptions[0]).toMatchObject({ ticked: [false, false, false, false], tags: [undefined, undefined, undefined, undefined], note: NONE_FOUND })
    expect(NONE_FOUND).toBe("We didn't find Claude Code, Cursor or Codex on this computer.\nUsing the Claude or ChatGPT app? Connect it at https://amdahl.ai/connect")
  })

  it('a ~/.claude.json alone means Claude Code is here', async () => {
    const io = terminal()
    writeFileSync(join(io.homedir, '.claude.json'), '{}')
    io.answers.push('none')
    await cli(io)
    expect(io.tickOptions[0]).toMatchObject({ ticked: [true, false, false, false] })
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

  it('writes through a dangling symbolic link to the file it names, and keeps the link', async () => {
    const io = agent()
    const real = join(io.homedir, 'dotfiles', 'claude.json')
    symlinkSync(real, join(io.homedir, '.claude.json'))
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(JSON.parse(readFileSync(real, 'utf8'))).toEqual({ mcpServers: { amdahl: { type: 'http', url } } })
    expect(lstatSync(join(io.homedir, '.claude.json')).isSymbolicLink()).toBe(true)
    expect(statSync(real).mode & 0o777).toBe(0o600)
    expect(existsSync(`${real}.amdahl-backup`)).toBe(false)
    expect((await cli(io)).stdout).toContain('✓ Claude Code already has Amdahl\n')
  })

  it('follows a chain of links, relative ones too, to a target not created yet', async () => {
    const io = agent()
    mkdirSync(join(io.homedir, 'a'))
    symlinkSync('a/link2', join(io.homedir, '.claude.json'))
    symlinkSync('../real.json', join(io.homedir, 'a', 'link2'))
    expect((await cli(io)).code).toBe(0)
    expect(JSON.parse(readFileSync(join(io.homedir, 'real.json'), 'utf8')).mcpServers.amdahl.url).toBe(url)
    expect(lstatSync(join(io.homedir, '.claude.json')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(io.homedir, 'a', 'link2')).isSymbolicLink()).toBe(true)
  })

  it.each([['an array', '[{"name":"x"}]'], ['a string', '"x"'], ['null', 'null']])('leaves a ~/.claude.json whose mcpServers is %s alone (exit 1)', async (_label, value) => {
    const io = agent()
    const path = join(io.homedir, '.claude.json')
    const text = `{"theme":"dark","mcpServers":${value}}`
    writeFileSync(path, text)
    const r = await cli(io)
    expect(r.code).toBe(1)
    expect(r.stderr).toBe(`Error: The "mcpServers" in ${path} is not a JSON object; not changing it.\nFix the file, or move it away, then run the same command again.\n`)
    expect(readFileSync(path, 'utf8')).toBe(text)
    expect(existsSync(`${path}.amdahl-backup`)).toBe(false)
  })

  it.each<[string, string, string, string]>([
    ['Claude Code', '.claude.json', '{"mcpServers":[{"name":"keep me"}]}', ''],
    ['Cursor', join('.cursor', 'mcp.json'), '{"mcpServers":[{"name":"keep me"}]}', '2'],
  ])('in the menu, %s with a non-object mcpServers is reported and left alone', async (_label, file, text, pick) => {
    const io = await atServer(false)
    mkdirSync(join(io.homedir, '.cursor'), { recursive: true })
    writeFileSync(join(io.homedir, file), text)
    io.answers.push(pick || '1')
    const r = await cli(io)
    expect(r.code).toBe(1)
    expect(io.opened).toEqual([])
    expect(r.stderr).toContain(`Error: The "mcpServers" in ${join(io.homedir, file)} is not a JSON object; not changing it.\n`)
    expect(readFileSync(join(io.homedir, file), 'utf8')).toBe(text)
  })

  it('install cursor refuses a non-object mcpServers instead of dropping it', async () => {
    const io = fakeIo()
    mkdirSync(join(io.homedir, '.cursor'))
    const path = join(io.homedir, '.cursor', 'mcp.json')
    writeFileSync(path, '{"mcpServers":["keep me"]}')
    const r = await cli(io, 'install', 'cursor', '--json')
    expect(r.code).toBe(1)
    expect(r.json.error.code).toBe('invalid_config')
    expect(readFileSync(path, 'utf8')).toBe('{"mcpServers":["keep me"]}')
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

  it('in the menu, a broken ~/.claude.json is reported, left alone, and nobody is sent to the browser', async () => {
    const io = await atServer(false)
    writeFileSync(join(io.homedir, '.claude.json'), '{oops')
    io.answers.push('')
    const r = await cli(io)
    expect(r.code).toBe(1)
    expect(io.opened).toEqual([])
    expect(r.stderr).toBe(`Error: ${join(io.homedir, '.claude.json')} is not valid JSON; not changing it.\nFix the file, or move it away, then run the same command again.\n`)
    expect(r.stdout).toBe(TITLE)
  })

  it('in the menu, only the broken tool is dropped: the others still set up, and the try-out still runs', async () => {
    const io = await atServer(false)
    mkdirSync(join(io.homedir, '.cursor'))
    writeFileSync(join(io.homedir, '.cursor', 'mcp.json'), '{oops')
    io.answers.push('2,3,4', 'draft')
    const r = await cli(io)
    expect(r.code).toBe(1)
    expect(io.opened).toHaveLength(1)
    expect(r.stdout).toBe(`${TITLE}${codexSteps()}\n✓ Signed in · Acme\nbetter: draft\n`)
    expect(readFileSync(join(io.homedir, '.cursor', 'mcp.json'), 'utf8')).toBe('{oops')
  })

  it("agu's case: Claude Code found by its folder, not on PATH: set up with no sign-in, and the next run says it's all set", async () => {
    const io = await atServer(false)
    mkdirSync(join(io.homedir, '.claude'))
    io.answers.push('')
    const r = await cli(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([menu('x Claude Code |   Cursor |   Codex')])
    expect(io.opened).toEqual([])
    expect(r.stdout).toBe(`${TITLE}${claudeScreen()}${NEW}`)
    expect(JSON.parse(readFileSync(join(io.homedir, '.claude.json'), 'utf8')).mcpServers.amdahl).toEqual({ type: 'http', url: `${server!.url}/mcp` })
    // Run again: set up, asks nothing.
    const again = await cli(io)
    expect(again.stdout).toContain("Amdahl is in Claude Code. You're all set.\n")
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
