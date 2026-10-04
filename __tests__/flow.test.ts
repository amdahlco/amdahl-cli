// The whole CLI against a mock Amdahl server: login -> whoami -> status ->
// keys create -> keys list -> keys revoke -> optimize -> logout, each with
// --json, checking the contract's output shapes, exit codes, file modes and
// that the key secret never leaves the process.

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { BIZ, startMockServer, type MockServer } from './helpers/mock-server'

let server: MockServer
let io: FakeIo

beforeEach(async () => {
  server = await startMockServer()
  io = fakeIo({ AMDAHL_API_URL: server.url })
})
afterEach(async () => {
  await server.close()
})

const mode = (path: string) => statSync(path).mode & 0o777

describe('login -> keys -> logout', () => {
  it('runs the full flow with the contract shapes', async () => {
    // login
    const login = await cli(io, 'login', '--json')
    expect(login.code).toBe(0)
    expect(login.json).toEqual({
      ok: true,
      profile: 'acme',
      user: { id: expect.any(String), email: 'dev@example.com' },
      workspace: { id: BIZ, name: 'Acme', slug: 'acme' },
      scopes: ['data:read', 'connections:read', 'messages:execute'],
      api_url: server.url,
    })
    const openEvent = login.stderr.split('\n').find((l) => l.includes('"open_url"'))
    expect(JSON.parse(openEvent ?? '{}')).toMatchObject({ event: 'open_url' })

    const configDir = join(io.env.XDG_CONFIG_HOME ?? '', 'amdahl')
    expect(mode(join(configDir, 'config.json'))).toBe(0o600)
    expect(mode(join(configDir, 'credentials.json'))).toBe(0o600)
    const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'))
    expect(config.default_profile).toBe('acme')
    expect(JSON.stringify(config)).not.toContain('at_')
    // The token exchange was form-encoded.
    const token = server.log.find((r) => r.path === '/oauth/token')
    expect(token?.headers['content-type']).toContain('application/x-www-form-urlencoded')

    // whoami: source profile, token previewed only
    const who = await cli(io, 'whoami', '--json')
    expect(who.code).toBe(0)
    expect(who.json).toMatchObject({
      ok: true,
      source: 'profile',
      profile: 'acme',
      role: 'editor',
      auth_method: 'oauth',
      client_id: 'amdahl-cli',
    })
    expect(who.json.token).toBeUndefined()
    expect(who.json.token_preview).toMatch(/^.{1,10}\.\.\.$/)
    const shown = await cli(io, 'whoami', '--json', '--show-token')
    expect(shown.json.token).toBe(server.issued.access[0])

    // status
    const status = await cli(io, 'status', '--json')
    expect(status.code).toBe(0)
    expect(status.json).toMatchObject({
      ok: true,
      source: 'profile',
      optimize: { allowed: true, blocker: null, quota: { remaining: 988 } },
      connections: { total: 3, healthy: 2 },
    })

    // keys create
    const created = await cli(io, 'keys', 'create', '--name', 'CI', '--preset', 'agent', '--expires', '30d', '--json')
    expect(created.code).toBe(0)
    const secret: string = created.json.secret
    expect(secret).toMatch(/^amdhl_[0-9a-f]{48}$/)
    expect(created.json.key).toMatchObject({ key_prefix: secret.slice(0, 14), name: 'CI', bundle_name: 'mcp_customer_agent' })
    const approve = created.stderr.split('\n').find((l) => l.includes('"approve"'))
    expect(JSON.parse(approve ?? '{}')).toMatchObject({ event: 'approve', user_code: 'BCDF-GHJK', url: expect.stringContaining('/cli/approve?business_id=') })
    const [req] = [...server.keyRequests.values()]
    expect(req).toMatchObject({
      action: 'create',
      name: 'CI',
      bundle_name: 'mcp_customer_agent',
      expires_in_days: 30,
      key_hash: createHash('sha256').update(secret).digest('hex'),
      key_prefix: secret.slice(0, 14),
      device_name: 'test-host',
    })
    // The secret never reached the server, in any request.
    for (const r of server.log) {
      expect(r.body).not.toContain(secret)
      expect(JSON.stringify(r.headers)).not.toContain(secret)
      expect(r.path).not.toContain(secret)
    }
    // ...and is stored nowhere.
    expect(readFileSync(join(configDir, 'credentials.json'), 'utf8')).not.toContain(secret)
    expect(readFileSync(join(configDir, 'config.json'), 'utf8')).not.toContain(secret)

    // keys list
    const list = await cli(io, 'keys', 'list', '--json')
    expect(list.code).toBe(0)
    expect(list.json.keys[0]).toEqual({
      id: '33333333-3333-4333-8333-333333333333',
      key_prefix: 'amdhl_deadbeef',
      name: 'old laptop',
      bundle_name: 'mcp_read_only',
      created_at: '2026-09-01T00:00:00Z',
      expires_at: '2026-12-01T00:00:00Z',
      last_used_at: null,
      is_mine: true,
      creator_email: 'dev@example.com',
    })

    // keys revoke (by prefix, confirmed by typing the name)
    io.answers.push('old laptop')
    const revoke = await cli(io, 'keys', 'revoke', 'amdhl_deadbeef', '--json')
    expect(revoke.code).toBe(0)
    expect(revoke.json).toEqual({ ok: true, revoked_key_id: '33333333-3333-4333-8333-333333333333' })

    // optimize
    io.stdinIsTTY = false
    io.stdinText = 'Hi there'
    const opt = await cli(io, 'optimize', '-', '--channel', 'email', '--json')
    expect(opt.code).toBe(0)
    expect(opt.json).toMatchObject({ ok: true, file: '-', result: { ok: true, message: 'better: Hi there' } })
    io.stdinIsTTY = true

    // logout revokes both tokens, then forgets the profile
    const access = server.issued.access[0]
    const refresh = server.issued.refresh[0]
    const out = await cli(io, 'logout', '--json')
    expect(out.json).toEqual({ ok: true, profiles: ['acme'], revoked: true, not_revoked: [] })
    expect(server.revoked).toEqual([access, refresh])
    const after = await cli(io, 'whoami', '--json')
    expect(after.code).toBe(3)
    expect(after.json).toEqual({
      ok: false,
      error: { code: 'not_signed_in', message: 'Not signed in. Run `amdahl login`, or set AMDAHL_KEY.' },
    })
  })

  it('logout --all names each profile whose tokens the server could not revoke', async () => {
    // Two profiles on two hosts: the first revokes, the second answers 503.
    const broken = await startMockServer({ failRevoke: true })
    try {
      expect((await cli(io, 'login', '--profile', 'good', '--json')).code).toBe(0)
      io.env.AMDAHL_API_URL = broken.url
      expect((await cli(io, 'login', '--profile', 'bad', '--json')).code).toBe(0)

      const out = await cli(io, 'logout', '--all', '--json')
      expect(out.code).toBe(0)
      expect(out.json).toEqual({
        ok: true,
        profiles: ['good', 'bad'],
        revoked: false,
        not_revoked: ['bad'],
      })
      // Both sign-ins are forgotten locally, whatever the server said.
      const list = await cli(io, 'workspace', 'list', '--json')
      expect(list.json).toMatchObject({ profiles: [] })

      // The healthy host revoked both of its tokens.
      expect(server.revoked).toHaveLength(2)
    } finally {
      await broken.close()
    }
  })

  it('logout --all without --json lists the profiles it could not revoke', async () => {
    const broken = await startMockServer({ failRevoke: true })
    try {
      io.env.AMDAHL_API_URL = broken.url
      await cli(io, 'login', '--profile', 'one', '--json')
      await cli(io, 'login', '--profile', 'two', '--json')
      const out = await cli(io, 'logout', '--all')
      expect(out.code).toBe(0)
      expect(out.stdout + out.stderr).toContain('could not revoke the tokens for one, two')
    } finally {
      await broken.close()
    }
  })

  it('--no-browser prints the URL and does not open a browser', async () => {
    const pending = cli(io, 'login', '--no-browser', '--json')
    // Drive the "browser" from the stderr event, as the e2e harness does.
    for (let i = 0; i < 100 && !io.err.join('').includes('open_url'); i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    const line = io.err.join('').split('\n').find((l) => l.includes('open_url')) ?? '{}'
    const { url } = JSON.parse(line) as { url: string }
    expect(url).toContain('code_challenge_method=S256')
    expect(url).toContain('scope=data%3Aread%20connections%3Aread%20messages%3Aexecute')
    const res = await fetch(url, { redirect: 'manual' })
    await fetch(res.headers.get('location') ?? '')
    const result = await pending
    expect(result.code).toBe(0)
    expect(io.opened).toEqual([])
  })

  it('passes --workspace through to authorize', async () => {
    await cli(io, 'login', '--workspace', 'acme', '--json')
    const authorize = server.log.find((r) => r.path === '/oauth/authorize')
    expect(authorize).toBeDefined()
    expect(io.opened[0]).toContain('&workspace=acme')
  })
})
