// Credential precedence, the API base order, OAuth-only commands, and the
// refresh split: invalid_grant clears the sign-in (exit 3), a 5xx keeps it
// (exit 8).

import { describe, expect, it, afterEach } from 'vitest'
import { createCtx, resolveCredential } from '../src/context'
import { createOutput } from '../src/output'
import { createSecretStore, keychainAccount } from '../src/secrets'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { API_KEY, startMockServer, type MockServer } from './helpers/mock-server'

let server: MockServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

function ctxFor(io: FakeIo, flags: Record<string, string | boolean | undefined> = {}) {
  return createCtx(io, createOutput(io, false, true), flags)
}

async function loggedIn(options: Parameters<typeof startMockServer>[0] = {}) {
  server = await startMockServer(options)
  const io = fakeIo({ AMDAHL_API_URL: server.url })
  const r = await cli(io, 'login', '--json')
  expect(r.code).toBe(0)
  return io
}

describe('credential precedence', () => {
  it('flag > AMDAHL_KEY > AMDAHL_API_KEY > AMDAHL_ACCESS_TOKEN > profile', async () => {
    const io = await loggedIn()
    const env = io.env
    env.AMDAHL_ACCESS_TOKEN = 'tok_access'
    expect((await resolveCredential(ctxFor(io))).source).toBe('env:AMDAHL_ACCESS_TOKEN')
    env.AMDAHL_API_KEY = 'tok_api'
    expect((await resolveCredential(ctxFor(io))).source).toBe('env:AMDAHL_API_KEY')
    env.AMDAHL_KEY = 'tok_key'
    expect(await resolveCredential(ctxFor(io))).toEqual({ source: 'env:AMDAHL_KEY', token: 'tok_key' })
    expect(await resolveCredential(ctxFor(io, { 'api-key': 'tok_flag' }))).toEqual({ source: 'flag', token: 'tok_flag' })
    delete env.AMDAHL_KEY
    delete env.AMDAHL_API_KEY
    delete env.AMDAHL_ACCESS_TOKEN
    expect((await resolveCredential(ctxFor(io))).source).toBe('profile')
  })

  it('whoami reports the winning source', async () => {
    const io = await loggedIn()
    io.env.AMDAHL_KEY = API_KEY
    const r = await cli(io, 'whoami', '--json')
    expect(r.json).toMatchObject({ source: 'env:AMDAHL_KEY', auth_method: 'api_key', token_preview: 'amdhl_aaaa...' })
    expect(JSON.stringify(r.json)).not.toContain(API_KEY)
  })

  it('keys create, keys revoke and auth token need the stored sign-in (exit 4)', async () => {
    const io = await loggedIn()
    io.env.AMDAHL_KEY = API_KEY
    for (const argv of [
      ['keys', 'create', '--name', 'x', '--json'],
      ['keys', 'revoke', 'amdhl_deadbeef', '--yes', '--json'],
      ['auth', 'token', '--json'],
    ]) {
      const r = await cli(io, ...argv)
      expect(r.code).toBe(4)
      expect(r.json.error.code).toBe('oauth_required')
    }
  })

  it('the API base is --api-url, then AMDAHL_API_URL, then the profile, then production', async () => {
    const io = fakeIo()
    expect(ctxFor(io).apiUrl).toBe('https://app.amdahl.ai')
    io.env.AMDAHL_API_URL = 'https://staging.amdahl.ai/'
    expect(ctxFor(io).apiUrl).toBe('https://staging.amdahl.ai')
    expect(ctxFor(io, { 'api-url': 'http://localhost:3001' }).apiUrl).toBe('http://localhost:3001')
    expect((await cli(io, 'status', '--api-url', 'ftp://x', '--json')).code).toBe(2)
  })

  it('never sends a profile token to a different host', async () => {
    const io = await loggedIn()
    const r = await cli(io, 'whoami', '--api-url', 'https://evil.example.com', '--json')
    expect(r.code).toBe(2)
    expect(r.json.error.code).toBe('profile_host_mismatch')
  })

  it('auth token prints the bare token, or JSON', async () => {
    const io = await loggedIn()
    const bare = await cli(io, 'auth', 'token')
    expect(bare.stdout).toBe(`${server?.issued.access[0]}\n`)
    const json = await cli(io, 'auth', 'token', '--json')
    expect(json.json).toEqual({ ok: true, access_token: server?.issued.access[0], expires_at: expect.any(String) })
  })
})

describe('refresh', () => {
  async function expiredLogin(refresh: 'ok' | 'invalid_grant' | '5xx') {
    // An access token with 30 s left is refreshed (the threshold is 60 s).
    const io = await loggedIn({ expiresIn: 30, refresh })
    return io
  }

  it('refreshes a token with under 60 s left and stores the new one', async () => {
    const io = await expiredLogin('ok')
    const r = await cli(io, 'whoami', '--json', '--show-token')
    expect(r.code).toBe(0)
    expect(r.json.token).toBe(server?.issued.access[1])
  })

  it('invalid_grant clears the sign-in and exits 3', async () => {
    const io = await expiredLogin('invalid_grant')
    const r = await cli(io, 'whoami', '--json')
    expect(r.code).toBe(3)
    expect(r.json.error.code).toBe('invalid_grant')
    const account = keychainAccount(server?.url ?? '', 'acme')
    expect(await createSecretStore(io).get(account)).toBeNull()
  })

  it('a 5xx keeps the tokens and exits 8', async () => {
    const io = await expiredLogin('5xx')
    const r = await cli(io, 'whoami', '--json')
    expect(r.code).toBe(8)
    const account = keychainAccount(server?.url ?? '', 'acme')
    expect(await createSecretStore(io).get(account)).not.toBeNull()
  })
})
