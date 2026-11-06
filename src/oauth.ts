// src/oauth.ts
//
// The OAuth pieces the CLI uses against the Amdahl authorization server:
// endpoint discovery, PKCE (S256), the token exchange and refresh (form
// encoded, RFC 6749), revocation (RFC 7009) and the loopback redirect
// listener on 127.0.0.1 (RFC 8252). The public client id is `amdahl-cli`.

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { amdahlCommand } from './command-name'
import { CliError, EXIT, NETWORK_HINT } from './errors'
import type { Io } from './io'
import type { Secrets } from './secrets'

/** The first-party OAuth client the server seeds for the CLI. */
export const CLI_OAUTH_CLIENT_ID = 'amdahl-cli'

/** The scopes the CLI asks for (the server clamps to these). */
export const CLI_OAUTH_SCOPES = ['data:read', 'connections:read', 'messages:execute']

/** The endpoints the CLI uses from the discovery document. */
export interface OAuthEndpoints {
  authorization_endpoint: string
  token_endpoint: string
  revocation_endpoint: string
}

/** PKCE pair plus the CSRF `state`. */
export interface PkcePair {
  verifier: string
  challenge: string
  state: string
}

/**
 * A 64-character verifier (48 random bytes, base64url), its S256 challenge,
 * and a 32-byte hex state.
 */
export function createPkce(): PkcePair {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(32).toString('hex')
  return { verifier, challenge, state }
}

/** The token response fields the CLI reads. */
interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
}

/** Fetch with transport failures mapped to exit 8. */
async function send(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new CliError('network_error', `Could not reach ${new URL(url).host}: ${message}`, EXIT.network, NETWORK_HINT)
  }
}

/** Read the authorization server metadata. */
export async function discover(apiUrl: string): Promise<OAuthEndpoints> {
  const res = await send(`${apiUrl}/.well-known/oauth-authorization-server`)
  if (!res.ok) {
    throw new CliError(
      'discovery_failed',
      `Could not read the sign-in settings from ${apiUrl} (HTTP ${res.status}).`,
      res.status >= 500 ? EXIT.network : EXIT.general
    )
  }
  const body = (await res.json()) as Partial<OAuthEndpoints>
  return {
    authorization_endpoint: body.authorization_endpoint ?? `${apiUrl}/oauth/authorize`,
    token_endpoint: body.token_endpoint ?? `${apiUrl}/oauth/token`,
    revocation_endpoint: body.revocation_endpoint ?? `${apiUrl}/oauth/revoke`,
  }
}

/** POST a form-encoded body. */
function postForm(url: string, fields: Record<string, string>): Promise<Response> {
  return send(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
  })
}

/** Turn a token response into stored secrets. */
function toSecrets(io: Io, body: TokenResponse): Secrets {
  const ttl = Number.isFinite(body.expires_in) ? body.expires_in : 3600
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    access_expires_at: new Date(io.now() + ttl * 1000).toISOString(),
  }
}

/** Exchange an authorization code for tokens. */
export async function exchangeCode(
  io: Io,
  endpoints: OAuthEndpoints,
  input: { code: string; redirectUri: string; verifier: string }
): Promise<Secrets> {
  const res = await postForm(endpoints.token_endpoint, {
    grant_type: 'authorization_code',
    code: input.code,
    client_id: CLI_OAUTH_CLIENT_ID,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string }
    throw new CliError(
      body.error ?? 'token_exchange_failed',
      body.error_description ?? `The sign-in could not be completed (HTTP ${res.status}).`,
      res.status >= 500 ? EXIT.network : EXIT.unauthenticated
    )
  }
  return toSecrets(io, (await res.json()) as TokenResponse)
}

/**
 * Refresh an access token. Returns `'invalid_grant'` when the refresh token
 * is dead (the caller clears it, exit 3). A 5xx or a network failure throws
 * exit 8 and the caller KEEPS the tokens: the server being down is not a
 * reason to sign the user out.
 */
export async function refreshTokens(
  io: Io,
  apiUrl: string,
  refreshToken: string
): Promise<Secrets | 'invalid_grant'> {
  const endpoints = await discover(apiUrl)
  const res = await postForm(endpoints.token_endpoint, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLI_OAUTH_CLIENT_ID,
  })
  if (res.ok) return toSecrets(io, (await res.json()) as TokenResponse)
  if (res.status >= 500) {
    throw new CliError(
      'server_error',
      `The Amdahl API could not refresh your sign-in (HTTP ${res.status}). Your sign-in is kept; try again.`,
      EXIT.network
    )
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (body.error === 'invalid_grant' || res.status === 400 || res.status === 401) return 'invalid_grant'
  throw new CliError(body.error ?? 'refresh_failed', `Refresh failed (HTTP ${res.status}).`, EXIT.general)
}

/** Revoke one token. Returns whether the server accepted it. */
export async function revokeToken(endpoints: OAuthEndpoints, token: string): Promise<boolean> {
  try {
    const res = await postForm(endpoints.revocation_endpoint, {
      token,
      client_id: CLI_OAUTH_CLIENT_ID,
    })
    return res.ok
  } catch {
    return false
  }
}

/** Build the authorize URL. The scope is space-separated, encoded as %20. */
export function authorizeUrl(
  endpoints: OAuthEndpoints,
  input: { redirectUri: string; pkce: PkcePair; workspace?: string }
): string {
  const params: [string, string][] = [
    ['response_type', 'code'],
    ['client_id', CLI_OAUTH_CLIENT_ID],
    ['redirect_uri', input.redirectUri],
    ['code_challenge', input.pkce.challenge],
    ['code_challenge_method', 'S256'],
    ['state', input.pkce.state],
    ['scope', CLI_OAUTH_SCOPES.join(' ')],
  ]
  if (input.workspace) params.push(['workspace', input.workspace])
  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  return `${endpoints.authorization_endpoint}?${query}`
}

/**
 * The refusals a sign-in with another email fixes. The browser keeps the
 * address it signed in with (amdahl-app redeems its refresh cookie silently),
 * so running the CLI again alone would hit the same refusal: the loopback page
 * links the server's sign-in page instead, which returns to the same
 * authorize request while the terminal keeps waiting.
 */
export const SIGN_IN_AGAIN: Record<string, { why: string; label: string }> = {
  not_work_email: { why: 'Amdahl needs your work email.', label: 'Sign in with your work email' },
  subdomain_email: { why: 'Use your main company email.', label: 'Sign in again' },
  email_unconfirmed: { why: 'Check your inbox to confirm your email, then try again.', label: 'Try again' },
}

/** What the terminal says while the loopback waits: the page's words, then its link. */
export function signInAgainLine(reason: string, url: string): string {
  const again = SIGN_IN_AGAIN[reason]
  return again ? `${again.why} ${again.label}:\n\n  ${url}\n` : ''
}

/**
 * The sentence for a sign-in with no workspace. `reason` is the server's
 * self-serve answer (`authorizeWorkspaces.ts` in amdahl-app): each names the
 * one thing to do. Without a reason, the two original messages, frozen by the
 * contract: create one, or join the waitlist.
 */
export function noBusinessMessage(consoleUrl: string, mayCreate: boolean, reason?: string): string {
  switch (reason) {
    case undefined:
      return mayCreate
        ? `You're signed in, but you don't have a workspace yet. Create one at ${consoleUrl}/new, then run \`${amdahlCommand('login')}\` again.`
        : `You're signed in, but you don't have access yet. Amdahl is in beta: join the waitlist at ${consoleUrl}/new, then run \`${amdahlCommand('login')}\` again once you're in.`
    case 'domain_has_workspace':
      return `Your company already has an Amdahl workspace. Ask its admins to let you in at ${consoleUrl}, then try again.`
    case 'invite_only':
      return "Your company's Amdahl workspace is invite-only. Ask a colleague in it to invite you, then try again."
    case 'not_work_email':
    case 'subdomain_email':
    case 'email_unconfirmed': {
      const again = SIGN_IN_AGAIN[reason]!
      return `${again.why} Run this again, then choose "${again.label}" in the browser.`
    }
    case 'daily_cap':
      return "Amdahl isn't taking more new workspaces today. Try again tomorrow."
    case 'paused':
      return 'New workspaces are paused for now. Try again later.'
    case 'domain_used':
      return 'Your company already used its free workspace. Email hello@amdahl.ai to get access.'
    default:
      return "Amdahl couldn't create your workspace just now. Try again in a few minutes."
  }
}

/** What arrived on the loopback callback. */
export type CallbackResult =
  | { kind: 'code'; code: string }
  | { kind: 'no_business'; mayCreate: boolean; reason?: string }
  | { kind: 'error'; error: string; description?: string }

/** A listening loopback server. */
export interface Loopback {
  redirectUri: string
  /** Resolves with the first callback that ends the sign-in, or rejects with a CliError. */
  result: Promise<CallbackResult>
  /** The authorize URL the browser was sent to: a sign-in with another email returns to it. */
  setAuthorizeUrl: (url: string) => void
  close: () => void
}

/** The server's sign-in page, returning to the same authorize request. */
function signInAgainUrl(authorize: string): string {
  const url = new URL(authorize)
  return `${url.origin}/login?redirect=${encodeURIComponent(`${url.pathname}${url.search}`)}`
}

/** Escape text for the loopback page. */
function html(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Amdahl CLI</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;line-height:1.5">${body}</body></html>`
}

/**
 * Listen on `127.0.0.1:<port>/callback` (port 0 picks a free one). The first
 * request carrying our `state` settles `result`, except a refusal another
 * email fixes ({@link SIGN_IN_AGAIN}): its page links the server's sign-in
 * page, `onSignInAgain` tells the terminal, and the listener keeps waiting
 * for the retry. A different `state` rejects with exit 1 `state_mismatch`.
 * Times out with exit 1 `login_timeout`, or exit 5 with the refusal when the
 * retry never came.
 *
 * @param consoleUrl - the console origin the no-workspace page links to.
 */
export async function startLoopback(
  io: Io,
  input: {
    port: number
    state: string
    consoleUrl: string
    timeoutMs: number
    onSignInAgain?: (reason: string, url: string) => void
  }
): Promise<Loopback> {
  let authorize: string | null = null
  let refused: string | null = null
  let settle!: (value: CallbackResult) => void
  let fail!: (err: CliError) => void
  const result = new Promise<CallbackResult>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  // Settling before the caller awaits must not surface as an unhandled
  // rejection; the caller still sees the rejection when it awaits.
  result.catch(() => {})
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
      return
    }
    const send = (status: number, body: string) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' })
      res.end(page(body))
    }
    if (url.searchParams.get('state') !== input.state) {
      send(400, `<p>This sign-in did not match the one your terminal started. Run <code>${amdahlCommand('login')}</code> again.</p>`)
      fail(new CliError('state_mismatch', 'The sign-in response did not match this login (state mismatch).', EXIT.general))
      return
    }
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    if (error === 'no_business') {
      const mayCreate = url.searchParams.get('may_create') === 'true'
      const reason = url.searchParams.get('reason') ?? undefined
      const again = reason ? SIGN_IN_AGAIN[reason] : undefined
      if (again && authorize) {
        refused = reason!
        const retry = signInAgainUrl(authorize)
        send(200, `<p>${html(again.why)}</p><p><a href="${html(retry)}">${html(again.label)} →</a></p>`)
        input.onSignInAgain?.(reason!, retry)
        return
      }
      send(200, `<p>${html(noBusinessMessage(input.consoleUrl, mayCreate, reason))}</p>`)
      settle({ kind: 'no_business', mayCreate, reason })
    } else if (error) {
      send(400, `<p>Sign-in failed: ${html(url.searchParams.get('error_description') ?? error)}</p>`)
      settle({ kind: 'error', error, description: url.searchParams.get('error_description') ?? undefined })
    } else if (code) {
      send(200, '<p>Signed in. You can close this tab.</p>')
      settle({ kind: 'code', code })
    } else {
      send(400, '<p>Missing code.</p>')
      settle({ kind: 'error', error: 'invalid_request', description: 'The callback carried no code.' })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) =>
      reject(
        new CliError(
          'port_unavailable',
          `Could not listen on 127.0.0.1:${input.port} (${err.code ?? err.message}).`,
          EXIT.general,
          'Pass a different --port, or omit it to pick a free one.'
        )
      )
    )
    server.listen(input.port, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  const timer = setTimeout(() => {
    fail(
      refused
        ? new CliError('no_business', noBusinessMessage(input.consoleUrl, false, refused), EXIT.noWorkspace)
        : new CliError('login_timeout', 'Timed out waiting for the browser sign-in.', EXIT.general, `Run \`${amdahlCommand('login')}\` again.`)
    )
  }, input.timeoutMs)
  timer.unref?.()
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    result,
    setAuthorizeUrl: (url) => {
      authorize = url
    },
    close: () => {
      clearTimeout(timer)
      server.closeAllConnections?.()
      server.close()
    },
  }
}

/**
 * The console origin for an API origin, used in messages that send the user
 * to the console. AMDAHL_CONSOLE_URL wins; then the known hosts; then the
 * production console.
 */
export function consoleUrlFor(io: Io, apiUrl: string): string {
  const override = io.env.AMDAHL_CONSOLE_URL
  if (override) return override.replace(/\/+$/, '')
  const host = new URL(apiUrl).host
  if (host === 'staging.amdahl.ai') return 'https://stagingui.amdahl.ai'
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) return 'http://localhost:4000'
  return 'https://console.amdahl.ai'
}
