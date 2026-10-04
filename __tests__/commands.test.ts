// Key format, exit-code map, argument errors, optimize, keys edge cases,
// install (codex TOML idempotence, cursor merge, claude-code), workspace
// profiles and the version.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import pkg from '../package.json'
import { parseCommandLine } from '../src/args'
import { EXIT, exitForHttp } from '../src/errors'
import { generateKey } from '../src/keygen'
import { SKILL_TEXT } from '../src/skill'
import { VERSION } from '../src/version'
import { cli, fakeIo } from './helpers/fake-io'
import { startMockServer, type MockServer } from './helpers/mock-server'

let server: MockServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

async function loggedIn(options: Parameters<typeof startMockServer>[0] = {}) {
  server = await startMockServer(options)
  const io = fakeIo({ AMDAHL_API_URL: server.url })
  expect((await cli(io, 'login', '--json')).code).toBe(0)
  return io
}

describe('key generation', () => {
  it('is amdhl_ + 48 hex, hashed with sha256, with a 14-char prefix', () => {
    const k = generateKey()
    expect(k.secret).toMatch(/^amdhl_[0-9a-f]{48}$/)
    expect(k.hash).toBe(createHash('sha256').update(k.secret).digest('hex'))
    expect(k.prefix).toHaveLength(14)
    expect(k.prefix).toMatch(/^amdhl_[0-9a-f]{8}$/)
    expect(generateKey().secret).not.toBe(k.secret)
  })
})

describe('exit codes', () => {
  it('maps statuses and server codes', () => {
    expect(exitForHttp(401)).toBe(EXIT.unauthenticated)
    expect(exitForHttp(403)).toBe(EXIT.forbidden)
    expect(exitForHttp(403, 'cli_client_required')).toBe(4)
    expect(exitForHttp(403, 'not_admin')).toBe(4)
    expect(exitForHttp(429)).toBe(6)
    expect(exitForHttp(429, 'too_many_pending')).toBe(6)
    expect(exitForHttp(200, 'quota_exceeded')).toBe(6)
    expect(exitForHttp(410)).toBe(7)
    expect(exitForHttp(500)).toBe(8)
    expect(exitForHttp(0)).toBe(8)
    expect(exitForHttp(404)).toBe(1)
    expect(exitForHttp(400, 'invalid_grant')).toBe(3)
  })

  it('usage errors exit 2', async () => {
    const io = fakeIo()
    expect((await cli(io, 'whoami', '--bogus')).code).toBe(2)
    expect((await cli(io, 'nope')).code).toBe(2)
    expect((await cli(io, 'keys')).code).toBe(2)
    expect((await cli(io)).code).toBe(2)
    const r = await cli(io, 'keys', 'create', '--json')
    expect(r.code).toBe(2)
    expect(r.json.error.code).toBe('usage')
  })

  it('auth login / logout / status are aliases', () => {
    expect(parseCommandLine(['auth', 'login', '--workspace', 'acme']).command).toBe('login')
    expect(parseCommandLine(['auth', 'logout', '--all']).command).toBe('logout')
    expect(parseCommandLine(['auth', 'status', '--show-token']).command).toBe('whoami')
    expect(parseCommandLine(['auth', 'token']).command).toBe('auth token')
    expect(parseCommandLine(['--json', 'keys', 'revoke', 'abc', '--yes'])).toMatchObject({
      command: 'keys revoke',
      args: ['abc'],
      flags: { json: true, yes: true },
    })
  })

  it('a network failure exits 8', async () => {
    const io = fakeIo({ AMDAHL_API_URL: 'http://127.0.0.1:1', AMDAHL_KEY: 'amdhl_x' })
    const r = await cli(io, 'status', '--json')
    expect(r.code).toBe(8)
    expect(r.json.error.code).toBe('network_error')
  })

  it('status prints the degraded shape the server sends when a read fails', async () => {
    const io = await loggedIn({ degradedStatus: true })
    const r = await cli(io, 'status')
    expect(r.code).toBe(0)
    expect(r.stdout + r.stderr).toContain('Workspace:  unknown')
    expect(r.stdout + r.stderr).toContain('Connections: could not be read right now')
  })

  it('--version and --help', async () => {
    const io = fakeIo()
    expect((await cli(io, '--version')).stdout).toBe('0.1.3\n')
    expect((await cli(io, '-v')).stdout).toBe('0.1.3\n')
    expect((await cli(io, '--help')).stdout).toContain('Usage: amdahl')
    expect(VERSION).toBe(pkg.version)
  })

  it('--help lists what you can do, and --json does not change it', async () => {
    const io = fakeIo()
    const help = (await cli(io, '--help')).stdout
    expect(help).toMatchSnapshot()
    expect(help).toContain('For everything Amdahl can do: https://docs.amdahl.ai/skills/amdahl/SKILL.md')
    expect((await cli(io, '--help', '--json')).stdout).toBe(help)
  })
})

describe('optimize', () => {
  it('runs files one after another and returns an array for several', async () => {
    const io = await loggedIn()
    const dir = io.homedir
    writeFileSync(join(dir, 'a.md'), 'first draft')
    writeFileSync(join(dir, 'b.md'), 'second draft')
    writeFileSync(join(dir, 'ctx.json'), JSON.stringify({ rules: ['be brief'], voice_examples: [], facts: [] }))
    const r = await cli(io, 'optimize', join(dir, 'a.md'), join(dir, 'b.md'), '--context', join(dir, 'ctx.json'), '--tries', '--json')
    expect(r.code).toBe(0)
    expect(r.json).toHaveLength(2)
    expect(r.json[1]).toMatchObject({ ok: true, file: join(dir, 'b.md'), result: { message: 'better: second draft' } })
    const bodies = server!.log.filter((l) => l.path.endsWith('/messages/optimize')).map((l) => JSON.parse(l.body))
    expect(bodies[0]).toEqual({ message: 'first draft', include_tries: true, context: { rules: ['be brief'], voice_examples: [], facts: [] } })
  })

  it('prints only the rewrite on stdout without --json', async () => {
    const io = await loggedIn()
    writeFileSync(join(io.homedir, 'a.md'), 'draft')
    const r = await cli(io, 'optimize', join(io.homedir, 'a.md'))
    expect(r.stdout).toBe('better: draft\n')
  })

  it('an ok:false result exits 1 and prints its reason', async () => {
    const io = await loggedIn({ optimizeResult: { ok: false, reason: 'optimizer_timeout', detail: 'Took too long.' } })
    io.stdinIsTTY = false
    io.stdinText = 'draft'
    const r = await cli(io, 'optimize', '--json')
    expect(r.code).toBe(1)
    expect(r.json).toMatchObject({ ok: false, file: '-', result: { ok: false, reason: 'optimizer_timeout' } })
    expect(r.stderr).toContain('optimizer_timeout')
  })

  it('a quota refusal exits 6', async () => {
    const io = await loggedIn({
      optimizeResult: { ok: false, success: false, error: { code: 'quota_exceeded', message: 'Monthly limit reached.' } },
    })
    io.stdinIsTTY = false
    io.stdinText = 'draft'
    const r = await cli(io, 'optimize', '--json')
    expect(r.code).toBe(6)
    expect(r.json.error.code).toBe('quota_exceeded')
  })

  it('no file on a TTY is a usage error; a bad flag value too', async () => {
    const io = await loggedIn()
    expect((await cli(io, 'optimize')).code).toBe(2)
    expect((await cli(io, 'optimize', '-', '--channel', 'fax')).code).toBe(2)
  })
})

describe('keys edge cases', () => {
  it('a denied request exits 7', async () => {
    const io = await loggedIn({ decision: 'denied' })
    const r = await cli(io, 'keys', 'create', '--name', 'x', '--no-browser', '--json')
    expect(r.code).toBe(7)
    expect(r.json.error.code).toBe('request_denied')
    expect(r.stdout).not.toContain('amdhl_')
  })

  it('an expired request exits 7', async () => {
    const io = await loggedIn({ decision: 'expired' })
    const r = await cli(io, 'keys', 'create', '--name', 'x', '--no-browser', '--json')
    expect(r.code).toBe(7)
    expect(r.json.error.code).toBe('request_expired')
  })

  it('defaults to read-only for 90 days', async () => {
    const io = await loggedIn()
    await cli(io, 'keys', 'create', '--name', 'x', '--no-browser', '--json')
    const [req] = [...server!.keyRequests.values()]
    expect(req).toMatchObject({ bundle_name: 'mcp_read_only', expires_in_days: 90 })
    expect(io.opened.filter((u) => u.includes('/cli/approve'))).toEqual([])
  })

  it('rejects an unknown preset or expiry', async () => {
    const io = await loggedIn()
    expect((await cli(io, 'keys', 'create', '--name', 'x', '--preset', 'god')).code).toBe(2)
    expect((await cli(io, 'keys', 'create', '--name', 'x', '--expires', 'never')).code).toBe(2)
  })

  it('revoke without --yes exits 2 when non-interactive', async () => {
    const io = await loggedIn()
    io.env.AMDAHL_NO_PROMPT = '1'
    const r = await cli(io, 'keys', 'revoke', 'amdhl_deadbeef', '--json')
    expect(r.code).toBe(2)
    expect(server!.keyRequests.size).toBe(0)
  })

  it('revoke aborts when the typed name does not match', async () => {
    const io = await loggedIn()
    io.answers.push('wrong')
    const r = await cli(io, 'keys', 'revoke', 'amdhl_deadbeef', '--json')
    expect(r.code).toBe(1)
    expect(server!.keyRequests.size).toBe(0)
  })

  it('revoke --yes skips the prompt and sends the key id', async () => {
    const io = await loggedIn()
    const r = await cli(io, 'keys', 'revoke', '33333333-3333-4333-8333-333333333333', '--yes', '--json')
    expect(r.code).toBe(0)
    const [req] = [...server!.keyRequests.values()]
    expect(req).toMatchObject({ action: 'revoke', key_id: '33333333-3333-4333-8333-333333333333' })
  })
})

describe('install', () => {
  it('codex appends once, then reports unchanged', async () => {
    const io = fakeIo({ AMDAHL_API_URL: 'https://staging.amdahl.ai' })
    const path = join(io.homedir, '.codex', 'config.toml')
    mkdirSync(join(io.homedir, '.codex'))
    writeFileSync(path, 'model = "o3"\n')
    const first = await cli(io, 'install', 'codex', '--json')
    const skill = join(io.homedir, '.agents', 'skills', 'amdahl', 'SKILL.md')
    expect(first.json).toEqual({ ok: true, client: 'codex', action: 'wrote', path, skill: { action: 'wrote', path: skill } })
    const second = await cli(io, 'install', 'codex', '--json')
    expect(second.json).toEqual({ ok: true, client: 'codex', action: 'unchanged', path, skill: { action: 'unchanged', path: skill } })
    expect(readFileSync(path, 'utf8')).toBe(
      'model = "o3"\n\n[mcp_servers.amdahl]\nurl = "https://staging.amdahl.ai/mcp"\nrequired = true\n'
    )
  })

  it('codex leaves an existing amdahl section alone', async () => {
    const io = fakeIo()
    mkdirSync(join(io.homedir, '.codex'))
    const path = join(io.homedir, '.codex', 'config.toml')
    writeFileSync(path, '[mcp_servers.amdahl]\nurl = "https://elsewhere/mcp"\n')
    expect((await cli(io, 'install', 'codex', '--json')).json.action).toBe('unchanged')
    expect(readFileSync(path, 'utf8')).toContain('elsewhere')
  })

  it('cursor merges into mcpServers and never writes a token', async () => {
    const io = fakeIo({ AMDAHL_KEY: 'amdhl_should_not_appear' })
    mkdirSync(join(io.homedir, '.cursor'))
    const path = join(io.homedir, '.cursor', 'mcp.json')
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { url: 'x' } }, theme: 'dark' }))
    const r = await cli(io, 'install', 'cursor', '--json')
    expect(r.json).toEqual({
      ok: true,
      client: 'cursor',
      action: 'wrote',
      path,
      skill: { action: 'wrote', path: join(io.homedir, '.cursor', 'skills', 'amdahl', 'SKILL.md') },
    })
    const written = readFileSync(path, 'utf8')
    expect(JSON.parse(written)).toEqual({
      mcpServers: { other: { url: 'x' }, amdahl: { url: 'https://app.amdahl.ai/mcp' } },
      theme: 'dark',
    })
    expect(written).not.toContain('amdhl_')
    expect((await cli(io, 'install', 'cursor', '--json')).json.action).toBe('unchanged')
  })

  it('--print writes nothing', async () => {
    const io = fakeIo()
    const r = await cli(io, 'install', 'cursor', '--print', '--json')
    expect(r.json.action).toBe('printed')
    expect(r.json.skill).toEqual({ action: 'printed', path: join(io.homedir, '.cursor', 'skills', 'amdahl', 'SKILL.md') })
    expect(existsSync(join(io.homedir, '.cursor'))).toBe(false)
  })

  it('claude-code runs `claude mcp add` when claude is on PATH, else prints it', async () => {
    const io = fakeIo()
    const printed = await cli(io, 'install', 'claude-code', '--json')
    expect(printed.json).toEqual({
      ok: true,
      client: 'claude-code',
      action: 'printed',
      command: 'claude mcp add --transport http amdahl https://app.amdahl.ai/mcp',
      skill: { action: 'wrote', path: join(io.homedir, '.claude', 'skills', 'amdahl', 'SKILL.md') },
    })
    io.run.mockImplementation(async () => ({ code: 0, stdout: '', stderr: '' }))
    const ran = await cli(io, 'install', 'claude-code', '--json')
    expect(ran.json.action).toBe('ran')
    expect(io.run).toHaveBeenLastCalledWith('claude', ['mcp', 'add', '--transport', 'http', 'amdahl', 'https://app.amdahl.ai/mcp'])
  })

  it('claude-code installs the bundled skill next to the MCP server', async () => {
    const io = fakeIo()
    io.run.mockImplementation(async () => ({ code: 0, stdout: '', stderr: '' }))
    const path = join(io.homedir, '.claude', 'skills', 'amdahl', 'SKILL.md')
    const r = await cli(io, 'install', 'claude-code')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(
      `Added Amdahl to Claude Code. Run /mcp in Claude Code to sign in.\nAdded the Amdahl skill (what Amdahl can do) at ${path}.\n`
    )
    expect(readFileSync(path, 'utf8')).toBe(SKILL_TEXT)
    expect((await cli(io, 'install', 'claude-code', '--json')).json.skill).toEqual({ action: 'unchanged', path })
  })

  it('keeps a changed skill file unless --force', async () => {
    const io = fakeIo()
    io.run.mockImplementation(async () => ({ code: 0, stdout: '', stderr: '' }))
    const path = join(io.homedir, '.claude', 'skills', 'amdahl', 'SKILL.md')
    mkdirSync(join(io.homedir, '.claude', 'skills', 'amdahl'), { recursive: true })
    writeFileSync(path, 'my notes\n')
    const kept = await cli(io, 'install', 'claude-code', '--json')
    expect(kept.code).toBe(0)
    expect(kept.json.skill).toEqual({ action: 'kept', path })
    expect(kept.stderr).toBe(`Kept your changed ${path}; run again with --force to replace it with the current Amdahl skill.\n`)
    expect(readFileSync(path, 'utf8')).toBe('my notes\n')
    const forced = await cli(io, 'install', 'claude-code', '--force', '--json')
    expect(forced.json.skill).toEqual({ action: 'replaced', path })
    expect(readFileSync(path, 'utf8')).toBe(SKILL_TEXT)
  })

  it('claude-code --print shows the skill path and writes nothing', async () => {
    const io = fakeIo()
    const path = join(io.homedir, '.claude', 'skills', 'amdahl', 'SKILL.md')
    const r = await cli(io, 'install', 'claude-code', '--print')
    expect(r.stdout).toBe(`claude mcp add --transport http amdahl https://app.amdahl.ai/mcp\n# Amdahl skill: ${path}\n`)
    expect(existsSync(join(io.homedir, '.claude'))).toBe(false)
    expect(io.run).not.toHaveBeenCalled()
  })

  it('the bundled skill is the amdahl SKILL.md', () => {
    const bundled = readFileSync(join(__dirname, '..', 'skill', 'SKILL.md'), 'utf8')
    expect(SKILL_TEXT).toBe(bundled)
    expect(bundled).toMatch(/^---\nname: amdahl\ndescription: .+\n---\n/)
  })

  it('an unknown client is a usage error', async () => {
    expect((await cli(fakeIo(), 'install', 'vim')).code).toBe(2)
  })
})

describe('workspace profiles', () => {
  it('lists profiles and switches the default', async () => {
    const io = await loggedIn()
    const list = await cli(io, 'workspace', 'list', '--json')
    expect(list.json).toEqual({
      ok: true,
      default: 'acme',
      profiles: [{ name: 'acme', workspace: { id: expect.any(String), name: 'Acme', slug: 'acme' }, email: 'dev@example.com', api_url: server!.url }],
    })
    expect((await cli(io, 'workspace', 'use', 'nope')).code).toBe(2)
    expect((await cli(io, 'workspace', 'use', 'acme', '--json')).json).toEqual({ ok: true, default: 'acme' })
  })
})
