// Login edge cases: PKCE + state, the loopback no_business answer (exit 5 with
// the exact message), a state mismatch (exit 1) and the timeout (exit 1).

import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authorizeUrl, consoleUrlFor, createPkce } from '../src/oauth'
import { realIo } from '../src/io'
import { cli, fakeIo, followAuthorize } from './helpers/fake-io'
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

  it.each<[string, string]>([
    ['domain_has_workspace', 'Your company already has an Amdahl workspace. Ask its admins to let you in at https://console.example.com, then try again.'],
    ['invite_only', "Your company's Amdahl workspace is invite-only. Ask a colleague in it to invite you, then try again."],
    ['daily_cap', "Amdahl isn't taking more new workspaces today. Try again tomorrow."],
    ['something_new', "Amdahl couldn't create your workspace just now. Try again in a few minutes."],
  ])('no_business with reason=%s exits 5 with that reason\'s next step, on the terminal and the page', async (reason, message) => {
    server = await startMockServer({ noBusiness: { mayCreate: false, reason } })
    const io = fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_CONSOLE_URL: 'https://console.example.com' })
    let page: Promise<string> = Promise.resolve('')
    io.openUrl = async (url) => {
      const res = await fetch(url, { redirect: 'manual' })
      page = fetch(res.headers.get('location') ?? '').then((r) => r.text())
      return true
    }
    const r = await cli(io, 'login', '--json')
    expect(r.code).toBe(5)
    expect(r.json.error).toEqual({ code: 'no_business', message })
    // The page reaches the browser whole, though the CLI stops at once.
    expect(await page).toContain(message.replace(/'/g, '&#39;'))
  })

  describe.each<[string, string, string]>([
    ['not_work_email', 'Amdahl needs your work email.', 'Sign in with your work email'],
    ['subdomain_email', 'Use your main company email.', 'Sign in again'],
    ['email_unconfirmed', 'Check your inbox to confirm your email, then try again.', 'Try again'],
  ])('no_business with reason=%s: another sign-in fixes it', (reason, why, label) => {
    /** A browser that keeps the loopback page of each callback it reaches. */
    function browser(io: ReturnType<typeof fakeIo>) {
      const pages: string[] = []
      const visit = async (url: string) => {
        const res = await fetch(url, { redirect: 'manual' })
        pages.push(await fetch(res.headers.get('location') ?? '').then((r) => r.text()))
      }
      io.openUrl = async (url) => {
        io.opened.push(url)
        await visit(url)
        return true
      }
      return { pages, visit }
    }

    it('keeps waiting, and the page links the sign-in page back to the same request, so the retry lands in this run', async () => {
      server = await startMockServer({ noBusiness: { mayCreate: false, reason, times: 1 } })
      const io = fakeIo({ AMDAHL_API_URL: server.url })
      // Long enough for the refusal to arrive first under a loaded test run; the wait below outlasts it.
      io.browserGraceMs = 500
      const { pages, visit } = browser(io)
      const run = cli(io, 'login')
      await vi.waitFor(() => expect(pages).toHaveLength(1))
      const authorize = new URL(io.opened[0]!)
      const again = `${server.url}/login?redirect=${encodeURIComponent(`${authorize.pathname}${authorize.search}`)}`
      // The same words on the page and the terminal: the page links them, the terminal prints the URL.
      expect(pages[0]).toContain(`<p>${why}</p><p><a href="${again.replace(/&/g, '&#38;')}">${label} →</a></p></body>`)
      // Past the grace period: the authorize link, which would only sign in as the same address again, never prints.
      await new Promise((r) => setTimeout(r, 700))
      // The server's sign-in page returns the browser to the same authorize URL, signed in as someone else.
      await visit(io.opened[0]!)
      const r = await run
      expect(r.code).toBe(0)
      expect(r.stderr).toBe(`Opening your browser…\n${why} ${label}:\n\n  ${again}\n`)
      expect(r.stdout).toContain('Signed in as dev@example.com')
    })

    it('when no other sign-in comes, exits 5 with an honest next step', async () => {
      server = await startMockServer({ noBusiness: { mayCreate: false, reason } })
      const io = fakeIo({ AMDAHL_API_URL: server.url })
      io.loginTimeoutMs = 200
      browser(io)
      const r = await cli(io, 'login', '--json')
      expect(r.code).toBe(5)
      expect(r.json.error).toEqual({ code: 'no_business', message: `${why} Run this again, then choose "${label}" in the browser.` })
    })
  })

  it('the link waits for the browser, and --no-browser prints it at once', async () => {
    server = await startMockServer()
    const io = fakeIo({ AMDAHL_API_URL: server.url })
    const quick = await cli(io, 'login')
    expect(quick.stderr).toBe('Opening your browser…\n')
    io.openUrl = async () => false
    const noBrowser = cli(io, 'login', '--no-browser')
    await new Promise((r) => setTimeout(r, 50))
    const url = /(http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?\S+)/.exec(io.err.join(''))?.[1]
    expect(io.err.join('')).toMatch(/^Open this URL in a browser to sign in:\n\n {2}http/)
    await followAuthorize(url ?? '')
    expect((await noBrowser).code).toBe(0)
  })

  it('waits 15 minutes for the browser by default: time to create a workspace on the way', () => {
    expect(realIo().loginTimeoutMs).toBe(900_000)
    expect(realIo().browserGraceMs).toBe(5_000)
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
