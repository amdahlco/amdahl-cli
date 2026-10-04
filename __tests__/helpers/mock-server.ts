// A local stand-in for the Amdahl server: the OAuth server (discovery, authorize,
// token, revoke) and the API routes the CLI calls, with the contract's shapes.
// It enforces what the real server enforces where a CLI bug would hide:
// PKCE S256 is verified, the token endpoint takes only form bodies, and the
// key-request routes take only an `amdahl-cli` OAuth token.

import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export const BIZ = '11111111-1111-4111-8111-111111111111'
export const USER = '22222222-2222-4222-8222-222222222222'
export const API_KEY = `amdhl_${'a'.repeat(48)}`

export interface LoggedRequest {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

export interface MockOptions {
  /** Answer authorize with `error=no_business`. */
  noBusiness?: { mayCreate: boolean }
  /** Answer authorize with a different state. */
  wrongState?: boolean
  /** Never answer authorize (the login times out). */
  hangAuthorize?: boolean
  refresh?: 'ok' | 'invalid_grant' | '5xx'
  /** Polls before the request is decided. */
  pollsBeforeDecision?: number
  decision?: 'approved' | 'denied' | 'expired'
  /** The optimize result body (inside `data`). */
  optimizeResult?: Record<string, unknown>
  /** Access token lifetime in seconds. */
  expiresIn?: number
  /** Answer every /oauth/revoke with a 503. */
  failRevoke?: boolean
  /** Answer setup/status with the degraded shape: no workspace, connections unavailable. */
  degradedStatus?: boolean
}

export interface MockServer {
  url: string
  log: LoggedRequest[]
  options: MockOptions
  /** Every token the server has issued. */
  issued: { access: string[]; refresh: string[] }
  revoked: string[]
  keyRequests: Map<string, Record<string, unknown>>
  close: () => Promise<void>
}

const b64url = (buf: Buffer) => buf.toString('base64url')

export async function startMockServer(options: MockOptions = {}): Promise<MockServer> {
  const log: LoggedRequest[] = []
  const issued = { access: [] as string[], refresh: [] as string[] }
  const revoked: string[] = []
  const keyRequests = new Map<string, Record<string, unknown>>()
  const codes = new Map<string, { challenge: string; redirectUri: string }>()
  const keys = [
    {
      id: '33333333-3333-4333-8333-333333333333',
      user_id: USER,
      name: 'old laptop',
      key_prefix: 'amdhl_deadbeef',
      scopes: ['data:read'],
      last_used_at: null,
      created_at: '2026-09-01T00:00:00Z',
      revoked: false,
      bundle_name: 'mcp_read_only',
      creator_email: 'dev@example.com',
      creator_display_name: 'Dev',
      is_mine: true,
      expires_at: '2026-12-01T00:00:00Z',
      request_count: 0,
    },
  ]
  let n = 0
  let base = ''

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  }
  const err = (res: ServerResponse, status: number, code: string, message = code) =>
    json(res, status, { error: { code, message } })

  const bearer = (req: IncomingMessage): string | null => {
    const h = req.headers.authorization
    return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : null
  }
  const authKind = (req: IncomingMessage): 'oauth' | 'api_key' | null => {
    const t = bearer(req)
    if (!t) return null
    if (t === API_KEY) return 'api_key'
    if (issued.access.includes(t) && !revoked.includes(t)) return 'oauth'
    return null
  }

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString('utf8')))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', base)
      const path = url.pathname
      log.push({ method: req.method ?? 'GET', path, headers: req.headers, body })
      const form = () => {
        if (!String(req.headers['content-type']).startsWith('application/x-www-form-urlencoded')) return null
        return new URLSearchParams(body)
      }

      if (path === '/.well-known/oauth-authorization-server') {
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          revocation_endpoint: `${base}/oauth/revoke`,
        })
      }

      if (path === '/oauth/authorize') {
        const q = url.searchParams
        const redirectUri = q.get('redirect_uri') ?? ''
        if (
          q.get('client_id') !== 'amdahl-cli' ||
          q.get('response_type') !== 'code' ||
          q.get('code_challenge_method') !== 'S256' ||
          q.get('scope') !== 'data:read connections:read messages:execute' ||
          !/^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(redirectUri)
        ) {
          return json(res, 400, { error: 'invalid_request' })
        }
        if (options.hangAuthorize) return json(res, 200, { waiting: true })
        const state = options.wrongState ? 'not-the-state' : (q.get('state') ?? '')
        let location: string
        if (options.noBusiness) {
          location = `${redirectUri}?error=no_business&may_create=${options.noBusiness.mayCreate}&state=${state}`
        } else {
          const code = `code_${++n}`
          codes.set(code, { challenge: q.get('code_challenge') ?? '', redirectUri })
          location = `${redirectUri}?code=${code}&state=${state}`
        }
        res.writeHead(302, { Location: location }).end()
        return
      }

      if (path === '/oauth/token') {
        const f = form()
        if (!f) return json(res, 400, { error: 'invalid_request', error_description: 'form body required' })
        const issue = () => {
          const access = `at_${++n}`
          const refresh = `rt_${++n}`
          issued.access.push(access)
          issued.refresh.push(refresh)
          return json(res, 200, {
            access_token: access,
            refresh_token: refresh,
            token_type: 'Bearer',
            expires_in: options.expiresIn ?? 3600,
          })
        }
        if (f.get('grant_type') === 'authorization_code') {
          const entry = codes.get(f.get('code') ?? '')
          const verifier = f.get('code_verifier') ?? ''
          const challenge = b64url(createHash('sha256').update(verifier).digest())
          if (
            !entry ||
            f.get('client_id') !== 'amdahl-cli' ||
            entry.redirectUri !== f.get('redirect_uri') ||
            entry.challenge !== challenge ||
            verifier.length !== 64
          ) {
            return json(res, 400, { error: 'invalid_grant' })
          }
          codes.delete(f.get('code') ?? '')
          return issue()
        }
        if (f.get('grant_type') === 'refresh_token') {
          if (options.refresh === '5xx') return json(res, 503, { error: 'server_error' })
          if (options.refresh === 'invalid_grant' || !issued.refresh.includes(f.get('refresh_token') ?? '')) {
            return json(res, 400, { error: 'invalid_grant' })
          }
          return issue()
        }
        return json(res, 400, { error: 'unsupported_grant_type' })
      }

      if (path === '/oauth/revoke') {
        const f = form()
        if (!f?.get('token')) return json(res, 400, { error: 'invalid_request' })
        if (options.failRevoke) return json(res, 503, { error: 'temporarily_unavailable' })
        revoked.push(f.get('token') ?? '')
        return json(res, 200, {})
      }

      const kind = authKind(req)
      if (path.startsWith('/api/') && !kind) return err(res, 401, 'unauthenticated', 'Authentication required')

      if (path === '/api/platform/v1/me/context') {
        return json(res, 200, {
          user_id: USER,
          business_id: BIZ,
          scopes: ['data:read', 'connections:read', 'messages:execute'],
          auth_method: kind,
          email: 'dev@example.com',
          workspace: { id: BIZ, name: 'Acme', slug: 'acme' },
          role: 'editor',
          client_id: kind === 'oauth' ? 'amdahl-cli' : null,
        })
      }

      if (path === '/api/platform/v1/setup/status') {
        return json(res, 200, {
          data: {
            workspace: options.degradedStatus ? null : { id: BIZ, name: 'Acme', slug: 'acme' },
            caller: { user_id: USER, email: 'dev@example.com', role: 'editor', auth_method: kind, client_id: null, scopes: [] },
            optimize: { allowed: true, blocker: null, quota: { limit: 1000, used: 12, remaining: 988, resets_at: '2026-11-01T00:00:00Z' } },
            connections: options.degradedStatus
              ? { omitted: 'unavailable' }
              : { total: 3, healthy: 2, needs_attention: [{ id: 'c1', connector_type: 'gong', name: 'Gong', status: 'error' }] },
          },
        })
      }

      if (path === '/api/platform/v1/cli/key-requests' && req.method === 'POST') {
        if (kind !== 'oauth') return err(res, 403, 'cli_client_required')
        const input = JSON.parse(body) as Record<string, unknown>
        if (input.action === 'create') {
          if (!/^[0-9a-f]{64}$/.test(String(input.key_hash)) || !/^amdhl_[0-9a-f]{8}$/.test(String(input.key_prefix))) {
            return err(res, 400, 'invalid_input')
          }
        } else if (input.action !== 'revoke') {
          return err(res, 400, 'invalid_input')
        }
        const id = `44444444-4444-4444-8444-${String(++n).padStart(12, '0')}`
        keyRequests.set(id, { ...input, polls: 0 })
        return json(res, 201, {
          request_id: id,
          user_code: 'BCDF-GHJK',
          approve_url: `https://console.example.com/cli/approve?business_id=${BIZ}&request_id=${id}`,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          interval: 3,
        })
      }

      const poll = path.match(/^\/api\/platform\/v1\/cli\/key-requests\/([^/]+)$/)
      if (poll && req.method === 'GET') {
        if (kind !== 'oauth') return err(res, 403, 'cli_client_required')
        const id = poll[1] ?? ''
        const entry = keyRequests.get(id)
        if (!entry) return err(res, 404, 'request_not_found')
        entry.polls = Number(entry.polls) + 1
        const decided = Number(entry.polls) > (options.pollsBeforeDecision ?? 1)
        const status = decided ? (options.decision ?? 'approved') : 'pending'
        const out: Record<string, unknown> = { request_id: id, action: entry.action, status, expires_at: new Date(Date.now() + 600_000).toISOString() }
        if (status === 'approved' && entry.action === 'create') {
          out.key = { id: '55555555-5555-4555-8555-555555555555', key_prefix: entry.key_prefix, name: entry.name, bundle_name: entry.bundle_name, expires_at: '2027-01-01T00:00:00Z' }
        }
        if (entry.action === 'revoke') out.key_id = entry.key_id
        return json(res, 200, out)
      }

      if (path === `/api/team/${BIZ}/mcp-keys` && req.method === 'GET') {
        return json(res, 200, { keys })
      }

      if (path === '/api/platform/v1/messages/optimize' && req.method === 'POST') {
        const input = JSON.parse(body) as { message?: string }
        return json(res, 200, {
          data: options.optimizeResult ?? { ok: true, message: `better: ${input.message}`, summary: 'Tighter opener.', unchanged: false, run_id: 'r1' },
        })
      }

      return err(res, 404, 'not_found')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url: base,
    log,
    options,
    issued,
    revoked,
    keyRequests,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}
