// Login edge cases: PKCE + state, the loopback no_business answer (exit 5 with
// the exact message), a state mismatch (exit 1) and the timeout (exit 1).

import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { authorizeUrl, consoleUrlFor, createPkce } from '../src/oauth'
import { cli, fakeIo } from './helpers/fake-io'
import { startMockServer, type MockServer } from './helpers/mock-server'

let server: MockServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

describe('PKCE and state', () => {
  it('makes a 64-char verifier, its S256 challenge and a 32-byte hex state', () => {
    const p = createPkce()
    expect(p.verifier).toMatch(/^[A-Za-z0-9_-]{64}$/)
    expect(p.challenge).toBe(createHash('sha256').update(p.verifier).digest('base64url'))
    expect(p.state).toMatch(/^[0-9a-f]{64}$/)
    expect(createPkce().state).not.toBe(p.state)
  })

  it('builds the authorize URL in the contract order', () => {
    const p = { verifier: 'v', challenge: 'c', state: 's' }
    const url = authorizeUrl(
      { authorization_endpoint: 'https://x/oauth/authorize', token_endpoint: '', revocation_endpoint: '' },
      { redirectUri: 'http://127.0.0.1:5/callback', pkce: p, workspace: 'acme' }
    )
    expect(url).toBe(
      'https://x/oauth/authorize?response_type=code&client_id=amdahl-cli&redirect_uri=http%3A%2F%2F127.0.0.1%3A5%2Fcallback&code_challenge=c&code_challenge_method=S256&state=s&scope=data%3Aread%20connections%3Aread%20messages%3Aexecute&workspace=acme'
    )
  })
})

describe('the loopback answer', () => {
  it('no_business with may_create=true exits 5 with the create message', async () => {
    server = await startMockServer({ noBusiness: { mayCreate: true } })
    const io = fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_CONSOLE_URL: 'https://console.example.com' })
    const r = await cli(io, 'login', '--json')
    expect(r.code).toBe(5)
    expect(r.json).toEqual({
      ok: false,
      error: {
        code: 'no_business',
        message:
          "You're signed in, but you don't have a workspace yet. Create one at https://console.example.com/new, then run `amdahl login` again.",
      },
    })
  })

  it('no_business with may_create=false exits 5 with the waitlist message', async () => {
    server = await startMockServer({ noBusiness: { mayCreate: false } })
    const io = fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_CONSOLE_URL: 'https://console.example.com' })
    const r = await cli(io, 'login')
    expect(r.code).toBe(5)
    expect(r.stderr).toContain(
      "You're signed in, but you don't have access yet. Amdahl is in beta: join the waitlist at https://console.example.com/new, then run `amdahl login` again once you're in."
    )
  })

  it('a state mismatch exits 1 and saves nothing', async () => {
    server = await startMockServer({ wrongState: true })
    const io = fakeIo({ AMDAHL_API_URL: server.url })
    const r = await cli(io, 'login', '--json')
    expect(r.code).toBe(1)
    expect(r.json.error.code).toBe('state_mismatch')
    expect(server.log.some((l) => l.path === '/oauth/token')).toBe(false)
    expect((await cli(io, 'whoami')).code).toBe(3)
  })

  it('times out with login_timeout (exit 1)', async () => {
    server = await startMockServer({ hangAuthorize: true })
    const io = fakeIo({ AMDAHL_API_URL: server.url })
    io.loginTimeoutMs = 200
    const r = await cli(io, 'login', '--json')
    expect(r.code).toBe(1)
    expect(r.json.error.code).toBe('login_timeout')
  })
})

describe('console origin', () => {
  it('maps the known API hosts and honours AMDAHL_CONSOLE_URL', () => {
    const io = fakeIo()
    expect(consoleUrlFor(io, 'https://app.amdahl.ai')).toBe('https://console.amdahl.ai')
    expect(consoleUrlFor(io, 'https://staging.amdahl.ai')).toBe('https://stagingui.amdahl.ai')
    io.env.AMDAHL_CONSOLE_URL = 'https://c.example.com/'
    expect(consoleUrlFor(io, 'https://app.amdahl.ai')).toBe('https://c.example.com')
  })
})
