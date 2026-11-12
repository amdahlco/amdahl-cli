// A local stand-in for the Amdahl server: the OAuth server (discovery, authorize,
// token, revoke) and the API routes the CLI calls, with the contract's shapes.
// It enforces what the real server enforces where a CLI bug would hide:
// PKCE S256 is verified, the token endpoint takes only form bodies, and the
// key-request routes take only an `amdahl-cli` OAuth token.

import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { batchProblems, feedbackProblem, reportSendProblem, reportSendRejection, searchProblem } from './strict'

export const BIZ = '11111111-1111-4111-8111-111111111111'
export const USER = '22222222-2222-4222-8222-222222222222'
export const API_KEY = `amdhl_${'a'.repeat(48)}`
/** A read-only key: it reads and searches, and the server refuses it messages:execute (optimize, feedback, sent). */
export const READONLY_KEY = `amdhl_${'b'.repeat(48)}`
/** An optimize run this workspace has (made an hour ago): `feedback` and `sent` find it. */
export const KNOWN_RUN = '88888888-8888-4888-8888-888888888888'
/** A well-formed run id this workspace does not have. */
export const UNKNOWN_RUN = '00000000-0000-4000-8000-000000000000'
/** The run id of item `index` of any batch the mock ran. */
export const batchRun = (index: number) => `99999999-9999-4999-8999-${String(index).padStart(12, '0')}`

export interface LoggedRequest {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

export interface MockOptions {
  /**
   * Answer authorize with `error=no_business` (and the self-serve `reason`,
   * when given): every time, or only the first `times` (a person who then
   * signs in with another email).
   */
  noBusiness?: { mayCreate: boolean; reason?: string; times?: number }
  /** The workspace name /me/context answers (default Acme). */
  workspaceName?: string
  /**
   * A signed-in person with no workspace yet: authorize answers the self-serve
   * create page until `POST /oauth/authorize/self-serve` creates one, which
   * returns to the same authorize request (as amdahl-app does with V0 on).
   */
  selfServe?: boolean
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
  /** Answer setup/status with no connection at all. */
  noConnections?: boolean
  /** Answer setup/status with an optimize blocker (and the quota used up for quota_exhausted). */
  blocker?: 'missing_scope' | 'role_too_low' | 'quota_exhausted'
  /** The search/query result body (inside `data`); the default is two rows and a cited answer. */
  searchResult?: Record<string, unknown>
  /** Research reads that answer `running` before the job completes. */
  researchPolls?: number
  /** The research answer's text (default: one sentence). */
  researchText?: string
  /** The research read is refused for want of `conversations:read`, though the key could start the job. */
  researchReadRefused?: boolean
  /** The research answer's `content_blocks` (default: none). */
  researchBlocks?: Record<string, unknown>[]
  /** The connections list (inside `data`). */
  connections?: Record<string, unknown>[]
  /** The connections list answers a 500. */
  connectionsError?: boolean
  /** The error code the server sends with a 401 (default `Unauthorized`, the server's own) and with a missing scope (default `forbidden`). */
  unauthenticatedCode?: string
  forbiddenCode?: string
  /** Status reads of a batch before it completes. */
  batchPolls?: number
  /** Of those reads, how many answer "one item running, none done" (with a falling estimate) before the batch completes. */
  batchRunningPolls?: number
  /** Item indexes that fail in a batch. */
  batchFailures?: number[]
  /** The message every batch item comes back with (default: `better: <draft>`). */
  batchMessage?: string
  /** The one-line summary every batch item comes back with (default: `Tighter opener.`). */
  batchSummary?: string
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
  const batches = new Map<string, { items: Record<string, unknown>[]; polls: number }>()
  // Run ids this workspace has, and when each was made.
  const runs = new Map<string, number>([[KNOWN_RUN, Date.now() - 3_600_000]])
  // Sends already reported, by run and send key.
  const reports = new Map<string, number>()
  let researchReads = 0
  let workspaceCreated = false
  let refusals = 0
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
  const authKind = (req: IncomingMessage): 'oauth' | 'api_key' | 'readonly' | null => {
    const t = bearer(req)
    if (!t) return null
    if (t === API_KEY) return 'api_key'
    if (t === READONLY_KEY) return 'readonly'
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
        if (options.selfServe && !workspaceCreated) {
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<form method="post" action="/oauth/authorize/self-serve"><input name="return_to" value="${url.pathname}${url.search}"></form>`)
          return
        }
        const state = options.wrongState ? 'not-the-state' : (q.get('state') ?? '')
        let location: string
        if (options.noBusiness && (options.noBusiness.times === undefined || refusals++ < options.noBusiness.times)) {
          const reason = options.noBusiness.reason ? `&reason=${options.noBusiness.reason}` : ''
          location = `${redirectUri}?error=no_business&may_create=${options.noBusiness.mayCreate}${reason}&state=${state}`
        } else {
          const code = `code_${++n}`
          codes.set(code, { challenge: q.get('code_challenge') ?? '', redirectUri })
          location = `${redirectUri}?code=${code}&state=${state}`
        }
        res.writeHead(302, { Location: location }).end()
        return
      }

      if (path === '/oauth/authorize/self-serve' && req.method === 'POST') {
        workspaceCreated = true
        res.writeHead(303, { Location: new URLSearchParams(body).get('return_to') ?? '/' }).end()
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
      if (path.startsWith('/api/') && !kind) return err(res, 401, options.unauthenticatedCode ?? 'Unauthorized', 'Authentication required')
      // The server refuses a call whose scope the credential lacks, in these words and as a 403 `forbidden`.
      const needsMessages = /^\/api\/platform\/v1\/messages\//.test(path)
      if (needsMessages && kind === 'readonly') return err(res, 403, options.forbiddenCode ?? 'forbidden', 'Missing required scope(s): messages:execute')

      if (path === '/api/platform/v1/me/context') {
        return json(res, 200, {
          user_id: USER,
          business_id: BIZ,
          scopes: ['data:read', 'connections:read', 'messages:execute'],
          auth_method: kind,
          email: 'dev@example.com',
          workspace: { id: BIZ, name: options.workspaceName ?? 'Acme', slug: 'acme' },
          role: 'editor',
          client_id: kind === 'oauth' ? 'amdahl-cli' : null,
        })
      }

      if (path === '/api/platform/v1/setup/status') {
        const blocker = options.blocker ?? null
        const used = blocker === 'quota_exhausted' ? 1000 : 12
        return json(res, 200, {
          data: {
            workspace: options.degradedStatus ? null : { id: BIZ, name: 'Acme', slug: 'acme' },
            caller: { user_id: USER, email: 'dev@example.com', role: 'editor', auth_method: kind, client_id: null, scopes: [] },
            optimize: { allowed: blocker === null, blocker, quota: { limit: 1000, used, remaining: 1000 - used, resets_at: '2026-12-01T00:00:00Z' } },
            connections: options.degradedStatus
              ? { omitted: 'unavailable' }
              : options.noConnections
                ? { total: 0, healthy: 0, needs_attention: [] }
                : { total: 3, healthy: 2, needs_attention: [{ id: 'c1', connector_type: 'gong', name: 'Gong', status: 'error' }] },
          },
        })
      }

      // search.query: a CLI OAuth token has no conversations:write, so a research handoff
      // falls back to the search with the server's note, as amdahl-app does.
      if (path === '/api/platform/v1/search/query' && req.method === 'POST') {
        const input = JSON.parse(body) as { query?: string; route?: string }
        const problem = searchProblem(input)
        if (problem) return json(res, 400, { data: { success: false, error: { code: 'invalid_argument', message: problem } } })
        if (input.route === 'research') {
          if (kind === 'api_key') {
            return json(res, 200, {
              data: {
                success: true,
                mode_ran: 'research',
                results: [],
                timing: { total_ms: 5 },
                research: { research_id: '66666666-6666-4666-8666-666666666666', chat_id: 'chat1', status: 'running', poll: 'Poll GET /research/:id' },
                notes: ['route:"research" was set, so this ask started a research job.'],
              },
            })
          }
          return json(res, 200, {
            data: {
              success: true,
              mode_ran: 'fuzzy',
              results: [{ id: 'r1', title: 'Discovery call', speaker: 'Dana', occurred_at: '2026-10-01T10:00:00Z', text: 'Pricing came up twice.' }],
              timing: { total_ms: 5 },
              notes: ['Starting a research job for this ask needs a credential that can start one (conversations:write); ran search instead.'],
            },
          })
        }
        return json(res, 200, {
          data: options.searchResult ?? {
            success: true,
            mode_ran: 'semantic',
            results: [
              { id: 'r1', title: 'Discovery call', speaker: 'Dana', occurred_at: '2026-10-01T10:00:00Z', text: 'Pricing came up twice.' },
              { id: 'r2', title: 'Renewal call', speaker: 'Sam', occurred_at: '2026-10-08T10:00:00Z', text: 'They asked for annual billing.' },
            ],
            timing: { total_ms: 5 },
            answer: {
              status: 'answered',
              text: 'Buyers raised [pricing](amdahl:cite?block=r1) and [annual billing](amdahl:cite?block=r2).',
              citations: [],
              model: 'm',
            },
          },
        })
      }

      const research = path.match(/^\/api\/platform\/v1\/research\/([^/]+)$/)
      if (research && req.method === 'GET') {
        if (kind !== 'api_key' || options.researchReadRefused) return err(res, 403, 'missing_scope', 'This credential lacks conversations:read.')
        researchReads++
        const done = researchReads > (options.researchPolls ?? 1)
        return json(res, 200, {
          data: {
            research_id: research[1],
            chat_id: 'chat1',
            status: done ? 'complete' : 'running',
            question: 'q',
            answer: done
              ? { text: options.researchText ?? 'Deals with a pricing objection closed less often [1](amdahl:cite?block=b1).', partial: false, partial_reason: null, content_blocks: options.researchBlocks ?? [], follow_ups: ['Which competitor came up most?'] }
              : null,
            error: null,
          },
        })
      }

      if (path === '/api/platform/v1/connections' && req.method === 'GET') {
        if (options.connectionsError) return err(res, 500, 'internal_error', 'Could not read the connections.')
        return json(res, 200, {
          data: options.connections ?? [
            { id: 'c0', connector_type: 'hubspot', connector: { type: 'hubspot', name: 'HubSpot', category: 'crm' }, name: 'HubSpot', status: 'connected', health: 'healthy', last_synced_at: '2026-11-11T08:00:00Z' },
            { id: 'c1', connector_type: 'gong', connector: { type: 'gong', name: 'Gong', category: 'calls' }, name: 'Sales calls', status: 'error', health: 'needs_reauth', last_synced_at: null },
          ],
        })
      }

      if (path === '/api/platform/v1/connections/catalog' && req.method === 'GET') {
        return json(res, 200, {
          data: [
            { type: 'hubspot', name: 'HubSpot', category: 'crm', authMethod: 'oauth', connectable: true, unavailableReason: null, selfServeAllowed: true },
            { type: 'gong', name: 'Gong', category: 'calls', authMethod: 'oauth', connectable: true, unavailableReason: null, selfServeAllowed: true },
            { type: 'slack', name: 'Slack', category: 'comms', authMethod: 'oauth', connectable: false, unavailableReason: 'planned', selfServeAllowed: false },
          ],
        })
      }

      if (path === '/api/platform/v1/messages/optimize/batch' && req.method === 'POST') {
        const input = JSON.parse(body) as { items?: Record<string, unknown>[] }
        const problems = batchProblems(input)
        if (problems.length) return json(res, 400, { error: { code: 'invalid_input', message: `Input failed schema validation: ${problems[0]}`, details: { errors: problems } } })
        const items = input.items ?? []
        const id = `77777777-7777-4777-8777-${String(++n).padStart(12, '0')}`
        batches.set(id, { items, polls: 0 })
        items.forEach((_, index) => runs.set(batchRun(index), Date.now()))
        return json(res, 202, { data: { ok: true, replayed: false, ...batchSummary(id, items, false) } })
      }

      const batch = path.match(/^\/api\/platform\/v1\/messages\/optimize\/batches\/([^/]+)$/)
      if (batch && req.method === 'GET') {
        // A malformed id and an unknown id are one not-found, as on the real route.
        const entry = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(batch[1] ?? '') ? batches.get(batch[1] ?? '') : undefined
        if (!entry) return err(res, 404, 'not_found')
        entry.polls++
        const reads = options.batchPolls ?? 1
        const done = entry.polls > reads
        // The last few reads before it completes see one item running and none done, the estimate falling.
        const running = !done && entry.polls > reads - (options.batchRunningPolls ?? 0) ? { eta: Math.max(60, 300 - entry.polls * 60) } : undefined
        const limit = Number(url.searchParams.get('limit') ?? 50)
        const after = Number(url.searchParams.get('cursor') ?? -1)
        const page = entry.items.map((item, index) => ({ item, index })).filter((x) => x.index > after).slice(0, limit)
        const last = page[page.length - 1]
        return json(res, 200, {
          data: {
            ...batchSummary(batch[1] ?? '', entry.items, done, running),
            items: page.map(({ item, index }) => ({
              index,
              item_id: (item.item_id as string | undefined) ?? null,
              status: done ? (options.batchFailures?.includes(index) ? 'failed' : 'done') : 'queued',
              result: !done
                ? null
                : options.batchFailures?.includes(index)
                  ? { ok: false, reason: 'optimizer_error', detail: 'It failed.' }
                  : { ok: true, message: options.batchMessage ?? `better: ${String(item.message)}`, summary: options.batchSummary ?? 'Tighter opener.', what_changed: 'Wrote this message from the context you sent.', run_id: batchRun(index), unchanged: false },
            })),
            next_cursor: last && last.index < entry.items.length - 1 ? String(last.index) : null,
          },
        })
      }

      const feedback = path.match(/^\/api\/platform\/v1\/messages\/optimize\/runs\/([^/]+)\/feedback$/)
      if (feedback && req.method === 'POST') {
        const input = JSON.parse(body) as Record<string, unknown>
        const problem = feedbackProblem(input)
        if (problem) return json(res, 400, { data: { success: false, error: { code: 'invalid_argument', message: problem } } })
        if (!runs.has(feedback[1] ?? '')) return json(res, 404, { data: { success: false, error: { code: 'not_found', message: 'No optimize run with this id from you in this workspace.' } } })
        return json(res, 200, { data: { success: true, feedback_id: 'fb1', run_id: feedback[1], rubric_miss: null, outcome: input.outcome ?? null, evidence: input.evidence } })
      }

      if (path === '/api/platform/v1/messages/report_send' && req.method === 'POST') {
        const input = JSON.parse(body) as { items: Record<string, unknown>[] }
        const problem = reportSendProblem(input)
        if (problem) return json(res, 400, { data: { success: false, error: { code: 'invalid_argument', message: problem } } })
        const items = input.items.map((item, index) => {
          const rejection = reportSendRejection(item, Date.now(), runs.get(String(item.run_id).toLowerCase()))
          if (rejection) return { index, run_id: item.run_id, status: 'rejected', ...rejection }
          // The same send key reported again updates the first report.
          const key = `${String(item.run_id).toLowerCase()}|${String(item.provider_send_id ?? item.recipient ?? item.recipient_key_hash)}`
          const again = reports.has(key)
          reports.set(key, Date.now())
          return { index, run_id: item.run_id, status: 'accepted', result: again ? 'updated' : 'created' }
        })
        const rejected = items.filter((i) => i.status === 'rejected').length
        return json(res, 200, { data: { success: true, accepted: items.length - rejected, rejected, items } })
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
  function batchSummary(id: string, items: unknown[], done: boolean, running?: { eta: number }) {
    const failed = done ? (options.batchFailures?.length ?? 0) : 0
    return {
      batch_id: id,
      status: done ? 'completed' : running ? 'running' : 'queued',
      created_at: '2026-11-12T00:00:00Z',
      completed_at: done ? '2026-11-12T00:05:00Z' : null,
      counts: {
        total: items.length,
        queued: done ? 0 : running ? items.length - 1 : items.length,
        running: running ? 1 : 0,
        done: done ? items.length - failed : 0,
        failed,
      },
      queue_position: done || running ? 0 : 3,
      eta: done ? null : { seconds: running?.eta ?? 300, estimate: true, items_ahead: running ? 0 : 3, median_run_seconds: 30, slots: 2 },
    }
  }

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
