// A local stand-in for the Amdahl server: the OAuth server (discovery, authorize,
// token, revoke) and the API routes the CLI calls, with the contract's shapes.
// It enforces what the real server enforces where a CLI bug would hide:
// PKCE S256 is verified, the token endpoint takes only form bodies, and the
// key-request routes take only an `amdahl-cli` OAuth token.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { batchProblems, feedbackProblem, optimizeProblems, promptProblems, reportSendProblem, ratingProblem, reportSendRejection, searchProblem } from './strict'

/** The recipe library `GET /search/suggestions` answers with (2026-11-13): 14 recipes, each with its search question and fill-ins. */
export const SUGGESTED_LIBRARY: Record<string, unknown>[] = JSON.parse(readFileSync(new URL('../fixtures/suggestions-library.json', import.meta.url), 'utf8'))
export const BIZ = '11111111-1111-4111-8111-111111111111'
export const USER = '22222222-2222-4222-8222-222222222222'
export const API_KEY = `amdhl_${'a'.repeat(48)}`
/** A read-only key: it reads and searches, and the server refuses it messages:execute (optimize, feedback, sent). */
export const READONLY_KEY = `amdhl_${'b'.repeat(48)}`
/** An optimize run this workspace has (made an hour ago): `feedback` and `sent` find it. */
export const KNOWN_RUN = '88888888-8888-4888-8888-888888888888'
/** The `query_id` the mock gives a plain search answer. */
export const SEARCH_QUERY = '33333333-3333-4333-8333-333333333333'
/** A well-formed run id this workspace does not have. */
export const UNKNOWN_RUN = '00000000-0000-4000-8000-000000000000'
/** The run id the mock gives a grade. */
export const GRADE_RUN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
/** The id the mock gives the prompt run it starts. */
// A prompt run's id is `opt_` and 32 hex characters (2026-11-13), not a UUID.
export const PROMPT_RUN = 'opt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
/** What `GET /messages/optimize/runs/:id` returns for KNOWN_RUN. */
export const KNOWN_RUN_BODY = {
  run_id: KNOWN_RUN,
  draft: 'Hi Dana, quick note about pricing.',
  context: { facts: ['Helix cut provisioning tickets by 70%.'], rules: ['Ask for 15 minutes.'] },
  message: 'Hi Dana, Helix cut provisioning tickets by 70%. Worth 15 minutes?',
  created_at: '2026-11-12T08:00:00Z',
  omitted: [{ what: 'a second proof point', why: 'The context held one.' }],
}
/** The `changes` and `added_claims` a server that computes them answers with (MockOptions.whatChanged). */
export const WHAT_CHANGED = {
  changes: [
    { before: 'We are the leading onboarding platform.', after: null, why: 'Nothing backs it.', why_cut: 'nothing in your calls backs it' },
    { before: null, after: 'Helix cut provisioning tickets by 70% in one quarter.', why: 'Proof.', why_added: 'it gives proof from a team like theirs' },
    { before: 'Quick note about pricing.', after: 'Quick note on pricing for Helix.', why: 'Names the company.' },
    { before: 'Can we talk?', after: 'Worth 15 minutes?', why: 'Asks for a time.', why_cut: 'it did not say how long', why_added: 'it asks for 15 minutes' },
  ],
  added_claims: [
    {
      sentence: 'Helix cut provisioning tickets by 70% in one quarter.',
      sources: [
        { id: 's1', tag: 'call', text: 'We cut provisioning tickets by 70% after we moved onto the new platform and trained every support lead on it in the first quarter' },
        { id: 's2', tag: null, text: 'Second source.' },
      ],
    },
  ],
}
/** The `changes` of an improved prompt run (MockOptions.whatChanged). */
export const PROMPT_CHANGES = [
  { before: 'Write an email.', after: 'Write a first-touch email to a Head of Platform.', why_cut: 'it named no reader', why_added: 'it says who reads it' },
  { before: null, after: 'Then ask for 15 minutes.', why_added: 'it ends on one ask' },
]
/** The run id of item `index` of any batch the mock ran. */
export const batchRun = (index: number) => `99999999-9999-4999-8999-${String(index).padStart(12, '0')}`

export interface LoggedRequest {
  method: string
  path: string
  /** The query string, with its `?`, or ''. */
  query: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** The most bytes of JSON the server's parser takes. */
export const BODY_LIMIT = 1024 * 1024

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
   * returns to the same authorize request (as the server does).
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
  /** A refusal for an optimize request, by its call number from 0: the status, the error body and any headers. */
  optimizeRefusal?: (index: number) => { status: number; body: unknown; headers?: Record<string, string> } | undefined
  /** The optimize result body for each request, from the request's own body and its place (from 0): a message made from what was sent. Wins over `optimizeResult`. */
  optimizeAnswer?: (body: Record<string, unknown>, index: number) => Record<string, unknown>
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
  /** The scopes /me/context answers and a research request needs `conversations:write` from (default: the usual set, and an API key can research). */
  scopes?: string[]
  /** Answer /me/context with a 500. */
  failMeContext?: boolean
  /** Refuse every research request with the server's "ran search instead" note, though /me/context lists `conversations:write`. */
  researchRefused?: boolean
  /** The search/query result body (inside `data`); the default is two rows and a cited answer. */
  searchResult?: Record<string, unknown>
  /** Research reads that answer `running` before the job completes. */
  researchPolls?: number
  /** Each research read takes this long to answer (a long-poll that holds). */
  researchDelayMs?: number
  /** The optimize request is never answered; `onClose` runs when the client drops it. */
  optimizeHang?: { onClose: () => void }
  /** The research answer's text (default: one sentence). */
  researchText?: string
  /** The research read is refused for want of `conversations:read`, though the key could start the job. */
  researchReadRefused?: boolean
  /** The research id is no job of this workspace: the server's own not-found, naming a `research://` address. */
  researchUnknown?: boolean
  /** The research answer's `content_blocks` (default: none). */
  researchBlocks?: Record<string, unknown>[]
  /** The grade a `mode: "grade"` optimize returns (inside `data`); the default is the docs' example, with the evidence lines abstaining unless evidence was asked for. */
  gradeResult?: Record<string, unknown>
  /** Prompt run reads that answer `running` before the run completes (default 1). */
  promptPolls?: number
  /** What a finished prompt run reads as (inside `data`), by the mode it ran in; the default is the docs' examples. */
  promptResult?: (mode: string) => Record<string, unknown>
  /**
   * What `GET /search/suggestions` answers (inside `data`). Unset: the route is not on this server (a 404), and
   * `search.query` takes no `recipe_id`. Set: the route answers, and `recipe_id` must be a library id.
   */
  /** `GET /search/suggestions` never answers (a hanging server). */
  suggestionsHang?: boolean
  suggestions?: { for_you?: Record<string, unknown>[]; library?: Record<string, unknown>[]; generated_at?: string; setup_needed?: Record<string, unknown>; hidden_recipe_ids?: string[] }
  /** The first n suggestions reads answer `pending: true` with an empty For you (the server still working it out). */
  suggestionsPendingReads?: number
  /** A key's search without `route: "research"` is handed to research by the server: this is its `routing`, and the answer carries a `query_id`. */
  routedResearch?: Record<string, unknown>
  /** setup/status's `free_usage` (a self-serve workspace on its free credit). */
  freeUsage?: Record<string, unknown>
  /** optimize_prompt refuses with this message (a 422), as the server does with no recipients on an empty workspace. */
  promptRefusal?: string
  /** What `GET /search/overview` answers (inside `data`). */
  overview?: Record<string, unknown>
  /** What `GET /search/fields` answers (inside `data`), before the surface filter. */
  fields?: Record<string, unknown>
  /** The connections list (inside `data`). */
  connections?: Record<string, unknown>[]
  /** The connections list answers a 500. */
  connectionsError?: boolean
  /** The error code the server sends with a 401 (default `Unauthorized`, the server's own) and with a missing scope (default `forbidden`). */
  unauthenticatedCode?: string
  forbiddenCode?: string
  /** Scopes the 403 lists in `error.details.missing_scopes`, as servers since QA 2026-11-17 C4 do. Unset: the message only. */
  missingScopesDetail?: string[]
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
  /** The server computes `changes` and `added_claims`: optimize, batch items, the known run and an improved prompt run answer with {@link WHAT_CHANGED} and {@link PROMPT_CHANGES}. Unset: they are absent, as on an older server. */
  whatChanged?: boolean
  /** A whole item's status and result by its index, when the default message does not do. */
  batchResults?: (item: Record<string, unknown>, index: number) => { status: string; result: Record<string, unknown> | null } | undefined
  /** Items an `only_finished` read adds each time (the rest are still running). Unset: all finish together, after `batchPolls` reads. */
  batchFinishPerRead?: number
  /** The nth batch submitted (from 1) is refused, as the server refuses one over quota or scope. */
  batchRefuse?: Record<number, { status: number; code: string; message: string; details?: Record<string, unknown>; retryAfter?: number }>
  /** The nth batch submitted (from 1) is queued, and then the connection is cut with no answer, as a dropped network does. A resend with the same `idempotency_key` gets the first batch back, `replayed: true`. */
  batchDrop?: number[]
  /** Called as the nth batch is submitted (from 1), before the answer, with the request's JSON body. */
  onBatch?: (position: number, body: string) => void
  /** Every read of a batch is answered with this error. */
  batchReadRefuse?: { status: number; code: string; message: string }
  /** With `batchReadRefuse`: refuse the reads of only these batches, by the order they were sent from 1. */
  batchReadRefuseOnly?: number[]
  /** Connected sequencers, listed after the connections; their campaigns are SEQUENCER_CAMPAIGNS. */
  sequencers?: { id: string; type: string; name: string }[]
  /** After this many pushes, a push answers 409 campaign_active, as when someone starts the campaign mid-command. */
  pushesBeforeLive?: number
  /** The sequencer routes answer as the server's `pushCallerOf` does for a key whose grant does not name sequencers:push: 403 `scope_not_granted`, `details.required_scope`. */
  scopeNotGranted?: boolean
}

/** Every sequencer's campaigns in the mock, as `GET /connections/:id/campaigns` returns them. */
export const SEQUENCER_CAMPAIGNS = [
  { id: 'camp-paused', name: 'Q4 founders', status: 'paused', url: null },
  { id: 'camp-draft', name: 'Draft run', status: 'draft', url: null },
  { id: 'camp-live', name: 'Live run', status: 'active', url: null },
]

/** One push the mock took: the request body and the push id it answered. */
export interface MockPush {
  connection: string
  campaign: string
  body: { leads: Record<string, unknown>[]; idempotency_key: string }
  push_id: string
}

export interface MockServer {
  url: string
  log: LoggedRequest[]
  options: MockOptions
  /** Every token the server has issued. */
  issued: { access: string[]; refresh: string[] }
  revoked: string[]
  keyRequests: Map<string, Record<string, unknown>>
  /** Every sequencer push the server took. */
  pushes: MockPush[]
  close: () => Promise<void>
}

const b64url = (buf: Buffer) => buf.toString('base64url')

export async function startMockServer(options: MockOptions = {}): Promise<MockServer> {
  const log: LoggedRequest[] = []
  let optimizeCalls = 0
  const issued = { access: [] as string[], refresh: [] as string[] }
  const revoked: string[] = []
  const keyRequests = new Map<string, Record<string, unknown>>()
  const batches = new Map<string, { items: Record<string, unknown>[]; polls: number; finished: number }>()
  let batchPosts = 0
  const byKey = new Map<string, string>()
  // Run ids this workspace has, and when each was made.
  const runs = new Map<string, number>([[KNOWN_RUN, Date.now() - 3_600_000]])
  // What a run was sent and what came back, for the runs the mock made.
  const runBodies = new Map<string, Record<string, unknown>>([[KNOWN_RUN, KNOWN_RUN_BODY]])
  const promptRuns = new Map<string, { mode: string; polls: number }>()
  // Sends already reported, by run and send key.
  const reports = new Map<string, number>()
  let researchReads = 0
  let suggestionReads = 0
  let workspaceCreated = false
  let refusals = 0
  const codes = new Map<string, { challenge: string; redirectUri: string }>()
  const pushes: MockPush[] = []
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
      log.push({ method: req.method ?? 'GET', path, query: url.search, headers: req.headers, body })
      // The server's JSON parser takes 1 MB at most, and answers an over-size body with this 413.
      if (Buffer.byteLength(body) > BODY_LIMIT) return json(res, 413, { error: 'payload_too_large', message: 'Request body too large. The maximum upload size is 1MB.', limit_bytes: BODY_LIMIT })
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
          q.get('scope') !== 'data:read connections:read messages:execute sequencers:push' ||
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
      if (needsMessages && kind === 'readonly') {
        const message = 'Missing required scope(s): messages:execute'
        const code = options.forbiddenCode ?? 'forbidden'
        if (!options.missingScopesDetail) return err(res, 403, code, message)
        return json(res, 403, { error: { code, message, details: { missing_scopes: options.missingScopesDetail } } })
      }

      if (path === '/api/platform/v1/me/context') {
        if (options.failMeContext) return err(res, 500, 'internal_error')
        return json(res, 200, {
          user_id: USER,
          business_id: BIZ,
          scopes: options.scopes ?? ['data:read', 'connections:read', 'messages:execute', 'sequencers:push'],
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
            ...(options.freeUsage ? { free_usage: options.freeUsage } : {}),
            connections: options.degradedStatus
              ? { omitted: 'unavailable' }
              : options.noConnections
                ? { total: 0, healthy: 0, needs_attention: [] }
                : { total: 3, healthy: 2, needs_attention: [{ id: 'c1', connector_type: 'gong', name: 'Gong', status: 'error' }] },
          },
        })
      }

      // search.query: a CLI OAuth token has no conversations:write, so a research handoff
      // falls back to the search with the server's note, as the server does.
      if (path === '/api/platform/v1/search/query' && req.method === 'POST') {
        const input = JSON.parse(body) as { query?: string; route?: string }
        const problem = searchProblem(input, options.suggestions ? (options.suggestions.library ?? SUGGESTED_LIBRARY).map((r) => String(r.id)) : null)
        if (problem) return json(res, 400, { data: { success: false, error: { code: 'invalid_argument', message: problem } } })
        const canResearch = kind === 'api_key' && !options.researchRefused && (options.scopes ? options.scopes.includes('conversations:write') : true)
        if (options.routedResearch && input.route !== 'research' && canResearch) {
          return json(res, 200, {
            data: {
              success: true,
              mode_ran: 'research',
              results: [],
              timing: { total_ms: 5 },
              query_id: '77777777-7777-4777-8777-777777777777',
              routing: options.routedResearch,
              research: { research_id: '66666666-6666-4666-8666-666666666666', chat_id: 'chat1', status: 'running', poll: 'Poll GET /research/:id' },
            },
          })
        }
        if (input.route === 'research') {
          if (canResearch) {
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
            data: (options.researchRefused && options.searchResult ? { ...options.searchResult, notes: ['Starting a research job for this ask needs a credential that can start one (conversations:write); ran search instead.'] } : null) ?? options.searchResult ?? {
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
            query_id: SEARCH_QUERY,
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
        if (options.researchUnknown) return err(res, 404, 'not_found', `research://${research[1]} not found`)
        researchReads++
        const done = researchReads > (options.researchPolls ?? 1)
        const reply = () => json(res, 200, {
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
        if (options.researchDelayMs) return void setTimeout(reply, options.researchDelayMs)
        return reply()
      }

      if (path === '/api/platform/v1/connections' && req.method === 'GET') {
        if (options.connectionsError) return err(res, 500, 'internal_error', 'Could not read the connections.')
        const seq = (options.sequencers ?? []).map((c) => ({ id: c.id, connector_type: c.type, connector: { type: c.type, name: c.name, category: 'sequencer' }, name: c.name, status: 'connected', health: 'healthy', last_synced_at: null }))
        if (seq.length) return json(res, 200, { data: [...(options.connections ?? []), ...seq] })
        return json(res, 200, {
          data: options.connections ?? [
            { id: 'c0', connector_type: 'hubspot', connector: { type: 'hubspot', name: 'HubSpot', category: 'crm' }, name: 'HubSpot', status: 'connected', health: 'healthy', last_synced_at: '2026-11-11T08:00:00Z' },
            { id: 'c1', connector_type: 'gong', connector: { type: 'gong', name: 'Gong', category: 'calls' }, name: 'Sales calls', status: 'error', health: 'needs_reauth', last_synced_at: null },
          ],
        })
      }

      // The sequencer push routes, with the rules the server holds for a key or a sign-in.
      const seqPath = path.match(/^\/api\/platform\/v1\/connections\/([^/]+)\/(campaigns|pushes)(?:\/([^/]+))?(\/leads)?$/)
      if (seqPath) {
        if (kind === 'readonly') return err(res, 403, options.forbiddenCode ?? 'forbidden', 'Missing required scope(s): sequencers:push')
        if (options.scopeNotGranted) {
          return json(res, 403, {
            error: {
              code: 'scope_not_granted',
              message: 'This key does not name sequencers:push. A Full admin or older key does not carry it. Create a key with Sequencers: push added.',
              details: { required_scope: 'sequencers:push' },
            },
          })
        }
        const [, connId, what, sub, leadsPart] = seqPath
        if (!(options.sequencers ?? []).some((c) => c.id === connId)) return err(res, 404, 'not_found', 'Connection not found.')
        if (what === 'campaigns' && !sub && req.method === 'GET') return json(res, 200, { data: { campaigns: SEQUENCER_CAMPAIGNS } })
        if (what === 'campaigns' && sub && leadsPart && req.method === 'POST') {
          const input = JSON.parse(body) as MockPush['body']
          const campaign = SEQUENCER_CAMPAIGNS.find((c) => c.id === sub)
          if (!campaign) return err(res, 404, 'not_found', 'Campaign not found.')
          if (!Array.isArray(input.leads) || input.leads.length === 0 || input.leads.length > 100) return err(res, 400, 'too_many_leads', 'An API key or an agent can add up to 100 leads in one call.')
          if (campaign.status === 'active' || (options.pushesBeforeLive !== undefined && pushes.length >= options.pushesBeforeLive)) return err(res, 409, 'campaign_active', 'This campaign is live.')
          const known = pushes.find((p) => p.connection === connId && p.body.idempotency_key === input.idempotency_key)
          if (known) return json(res, 202, { data: { push_id: known.push_id } })
          const push_id = `66666666-6666-4666-8666-${String(pushes.length + 1).padStart(12, '0')}`
          pushes.push({ connection: connId ?? '', campaign: sub, body: input, push_id })
          return json(res, 202, { data: { push_id } })
        }
        if (what === 'pushes' && sub && req.method === 'GET') {
          const push = pushes.find((p) => p.push_id === sub)
          if (!push) return err(res, 404, 'not_found', 'Push not found.')
          const n = push.body.leads.length
          return json(res, 200, { data: { status: 'done', counts: { added: n, skipped: 0, failed: 0 }, items: push.body.leads.map((_, index) => ({ index, status: 'added', reason: null })) } })
        }
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
        const input = JSON.parse(body) as { items?: Record<string, unknown>[]; idempotency_key?: string }
        const position = ++batchPosts
        options.onBatch?.(position, body)
        const refuse = options.batchRefuse?.[position]
        if (refuse) {
          const headers: Record<string, string | number> = { 'Content-Type': 'application/json', ...(refuse.retryAfter === undefined ? {} : { 'Retry-After': refuse.retryAfter }) }
          return void res.writeHead(refuse.status, headers).end(JSON.stringify({ error: { code: refuse.code, message: refuse.message, ...(refuse.details ? { details: refuse.details } : {}) } }))
        }
        const first = input.idempotency_key ? byKey.get(input.idempotency_key) : undefined
        if (first) return json(res, 202, { data: { ok: true, replayed: true, ...batchSummary(first, batches.get(first)?.items ?? [], false) } })
        const problems = batchProblems(input)
        if (problems.length) return json(res, 400, { error: { code: 'invalid_input', message: `Input failed schema validation: ${problems[0]}`, details: { errors: problems } } })
        const items = input.items ?? []
        const id = `77777777-7777-4777-8777-${String(++n).padStart(12, '0')}`
        batches.set(id, { items, polls: 0, finished: 0 })
        if (input.idempotency_key) byKey.set(input.idempotency_key, id)
        items.forEach((_, index) => runs.set(batchRun(index), Date.now()))
        if (options.batchDrop?.includes(position)) return void req.socket.destroy()
        return json(res, 202, { data: { ok: true, replayed: false, ...batchSummary(id, items, false) } })
      }

      const batch = path.match(/^\/api\/platform\/v1\/messages\/optimize\/batches\/([^/]+)$/)
      if (batch && req.method === 'GET') {
        // A malformed id and an unknown id are one not-found, as on the real route.
        const entry = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(batch[1] ?? '') ? batches.get(batch[1] ?? '') : undefined
        if (!entry) return err(res, 404, 'not_found')
        if (options.batchReadRefuse && (!options.batchReadRefuseOnly || options.batchReadRefuseOnly.includes(Number((batch[1] ?? '').slice(-12))))) return err(res, options.batchReadRefuse.status, options.batchReadRefuse.code, options.batchReadRefuse.message)
        entry.polls++
        const reads = options.batchPolls ?? 1
        const finishedMode = ['true', '1'].includes(url.searchParams.get('only_finished') ?? '') || url.searchParams.has('finished_since')
        const stagger = options.batchFinishPerRead
        if (finishedMode && stagger) entry.finished = Math.min(entry.items.length, entry.finished + stagger)
        else if (entry.polls > reads) entry.finished = entry.items.length
        const done = entry.finished === entry.items.length && entry.polls > reads - (stagger ? reads : 0)
        const resultOf = (item: Record<string, unknown>, index: number) =>
          options.batchResults?.(item, index)
            ? options.batchResults(item, index)?.result
            : options.batchFailures?.includes(index)
              ? { ok: false, reason: 'optimizer_error', detail: 'It failed.' }
              : { ok: true, message: options.batchMessage ?? `better: ${String(item.message)}`, summary: options.batchSummary ?? 'Tighter opener.', what_changed: 'Wrote this message from the context you sent.', run_id: batchRun(index), unchanged: false, ...(options.whatChanged ? WHAT_CHANGED : {}) }
        const statusOf = (index: number, item: Record<string, unknown>) => options.batchResults?.(item, index)?.status ?? (options.batchFailures?.includes(index) ? 'failed' : 'done')
        // The last few reads before it completes see one item running and none done, the estimate falling.
        const running = !done && entry.polls > reads - (options.batchRunningPolls ?? 0) ? { eta: Math.max(60, 300 - entry.polls * 60) } : undefined
        const limit = Number(url.searchParams.get('limit') ?? 50)
        if (finishedMode) {
          const since = Number(/^f\.(\d+)$/.exec(url.searchParams.get('finished_since') ?? '')?.[1] ?? 0)
          const fresh = entry.items.map((item, index) => ({ item, index })).filter((x) => x.index >= since && x.index < entry.finished)
          const page = fresh.slice(0, limit)
          const seen = page.length ? (page[page.length - 1]?.index ?? 0) + 1 : since
          const failedNow = entry.items.filter((item, index) => index < entry.finished && statusOf(index, item) === 'failed').length
          return json(res, 200, {
            data: {
              ...batchSummary(batch[1] ?? '', entry.items, done, running),
              counts: { total: entry.items.length, queued: entry.items.length - entry.finished, running: 0, done: entry.finished - failedNow, failed: failedNow },
              items: page.map(({ item, index }) => ({ index, item_id: (item.item_id as string | undefined) ?? null, status: statusOf(index, item), result: resultOf(item, index) })),
              next_cursor: null,
              finished_cursor: `f.${seen}`,
              finished_remaining: fresh.length - page.length,
            },
          })
        }
        const after = Number(url.searchParams.get('cursor') ?? -1)
        const page = entry.items.map((item, index) => ({ item, index })).filter((x) => x.index > after).slice(0, limit)
        const last = page[page.length - 1]
        return json(res, 200, {
          data: {
            ...batchSummary(batch[1] ?? '', entry.items, done, running),
            items: page.map(({ item, index }) => ({
              index,
              item_id: (item.item_id as string | undefined) ?? null,
              status: done ? statusOf(index, item) : 'queued',
              result: !done ? null : resultOf(item, index),
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

      if (path === '/api/platform/v1/feedback' && req.method === 'POST') {
        if (kind !== 'api_key') return json(res, 403, { error: 'Feedback is sent from the console or with an API key.', code: 'credential_not_allowed' })
        const input = JSON.parse(body) as Record<string, unknown>
        const problem = ratingProblem(input)
        if (problem) return json(res, 400, { error: problem, code: 'invalid_argument' })
        return json(res, 200, { data: { answer_id: input.answer_id, surface: input.surface, rating: input.rating, email_ok: input.email_ok === true, has_comment: typeof input.comment === 'string' && input.comment.trim() !== '' } })
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
          out.key = { id: '55555555-5555-4555-8555-555555555555', key_prefix: entry.key_prefix, name: entry.name, bundle_name: entry.bundle_name ?? 'mcp_optimize', expires_at: '2027-01-01T00:00:00Z' }
        }
        if (entry.action === 'revoke') out.key_id = entry.key_id
        return json(res, 200, out)
      }

      if (path === `/api/team/${BIZ}/mcp-keys` && req.method === 'GET') {
        return json(res, 200, { keys })
      }

      if (path === '/api/platform/v1/messages/optimize' && req.method === 'POST') {
        const input = JSON.parse(body) as { message?: string; mode?: string; evidence?: string; context?: unknown }
        const answered = optimizeCalls++
        if (options.optimizeHang) {
          res.on('close', options.optimizeHang.onClose)
          return
        }
        const refusal = options.optimizeRefusal?.(answered)
        if (refusal) return res.writeHead(refusal.status, { 'Content-Type': 'application/json', ...refusal.headers }).end(JSON.stringify(refusal.body))
        const problems = optimizeProblems(input)
        if (problems.length) return json(res, 400, { error: { code: 'invalid_input', message: `Input failed schema validation: ${problems[0]}`, details: { errors: problems } } })
        if (input.mode === 'grade') {
          runs.set(GRADE_RUN, Date.now())
          runBodies.set(GRADE_RUN, { run_id: GRADE_RUN, draft: input.message ?? null, context: input.context ?? null, message: input.message ?? null, // the server stores a grade's draft back as its message (2026-11-13)
             created_at: new Date().toISOString(), omitted: [] })
          return json(res, 200, { data: options.gradeResult ?? gradeBody(input.evidence === 'workspace') })
        }
        return json(res, 200, {
          data: options.optimizeAnswer?.(input as Record<string, unknown>, answered) ?? options.optimizeResult ?? { ok: true, message: `better: ${input.message}`, summary: 'Tighter opener.', unchanged: false, run_id: 'r1', ...(options.whatChanged ? WHAT_CHANGED : {}) },
        })
      }

      // messages.optimize_prompt: starts a run at once (202) and is read with `get_prompt_run`.
      if (path === '/api/platform/v1/messages/optimize_prompt' && req.method === 'POST') {
        const input = JSON.parse(body) as { mode?: string; recipients?: { recipient: Record<string, unknown>; label?: string }[] }
        const problems = promptProblems(input)
        if (problems.length) return json(res, 400, { error: { code: 'invalid_input', message: `Input failed schema validation: ${problems[0]}`, details: { errors: problems } } })
        if (options.promptRefusal && !input.recipients) return json(res, 422, { error: { code: 'invalid_input', message: options.promptRefusal } })
        const mode = input.mode ?? 'improve'
        promptRuns.set(PROMPT_RUN, { mode, polls: 0 })
        const labels = input.recipients?.map((r) => r.label ?? String(r.recipient.company ?? r.recipient.name)) ?? ['Corvid Health', 'Brightpath', 'Helix', 'Northwind']
        return json(res, 202, {
          data: { success: true, run_id: PROMPT_RUN, status: 'pending', mode, recipients: { labels, sampled: !input.recipients }, replayed: false, poll: { uri: `optimize_prompt_run://${PROMPT_RUN}`, wait_ms_max: 30000 } },
        })
      }

      const promptRead = path.match(/^\/api\/platform\/v1\/messages\/optimize_prompt\/([^/]+)$/)
      if (promptRead && req.method === 'GET') {
        const entry = promptRuns.get(promptRead[1] ?? '')
        if (!entry) return err(res, 404, 'not_found', 'No prompt run with this id from you in this workspace.')
        entry.polls++
        if (entry.polls <= (options.promptPolls ?? 1)) return json(res, 200, { data: { run_id: promptRead[1], status: 'running', phase: entry.polls === 1 ? 'writing_emails' : 'grading' } })
        const body = options.promptResult ? options.promptResult(entry.mode) : promptBody(entry.mode)
        return json(res, 200, { data: { run_id: promptRead[1], status: 'complete', ...body, ...(options.whatChanged && body.outcome === 'improved' ? { changes: PROMPT_CHANGES } : {}) } })
      }

      // messages.get_run: one past run, read by its id by the person who made it.
      const runRead = path.match(/^\/api\/platform\/v1\/messages\/optimize\/runs\/([^/]+)$/)
      if (runRead && req.method === 'GET') {
        const found = runBodies.get((runRead[1] ?? '').toLowerCase())
        if (!found) return err(res, 404, 'not_found', 'No optimize run with this id from you in this workspace.')
        return json(res, 200, { data: found })
      }

      // search.overview and search.fields (data:read).
      if (path === '/api/platform/v1/search/suggestions' && req.method === 'GET') {
        if (options.suggestionsHang) return
        if (!options.suggestions) return err(res, 404, 'not_found', 'No such route.')
        suggestionReads++
        if (suggestionReads <= (options.suggestionsPendingReads ?? 0)) return json(res, 200, { data: { for_you: [], library: SUGGESTED_LIBRARY, generated_at: '2026-11-13T22:40:02.728Z', pending: true } })
        return json(res, 200, { data: { for_you: [], library: SUGGESTED_LIBRARY, generated_at: '2026-11-13T22:40:02.728Z', ...options.suggestions } })
      }
      if (path === '/api/platform/v1/search/overview' && req.method === 'GET') {
        return json(res, 200, { data: options.overview ?? overviewBody() })
      }
      if (path === '/api/platform/v1/search/fields' && req.method === 'GET') {
        const surface = url.searchParams.get('surface')
        const all = (options.fields ?? fieldsBody()) as { surfaces: { surface: string }[] }
        if (surface !== null && !all.surfaces.some((x) => x.surface === surface)) return err(res, 400, 'invalid_input', `surface: must be one of ${all.surfaces.map((x) => x.surface).join(', ')}`)
        return json(res, 200, { data: { surfaces: all.surfaces.filter((x) => surface === null || x.surface === surface) } })
      }

      return err(res, 404, 'not_found')
    })
  })
  // The docs' example grade (message-optimizer/grade-a-message). With evidence off, the four lines that read calls abstain.
  function gradeBody(evidence: boolean): Record<string, unknown> {
    const line = (id: string, pass: boolean, reason: string) => ({ id, pass, applicable: true, reason })
    const abstain = (id: string) => ({ id, pass: null, applicable: false, reason: 'No evidence was asked for.', not_applicable_reason: 'not_requested' })
    return {
      ok: true,
      outcome: 'graded',
      rewrite: null,
      optimize_id: 'opt_7f3c2a',
      run_id: GRADE_RUN,
      summary: 'Graded.',
      lift: null,
      evidence: evidence ? { requested: 'workspace', used: true } : { requested: 'off', used: false, reason: 'not_requested' },
      unsupported_claims: [],
      grade: evidence
        ? {
            score: 4.2,
            passed: 4,
            total: 5,
            bar: 4.2,
            passes_bar: true,
            judge: { model: 'claude-sonnet-5-5', judge_version: 'v7', role: 'final' },
            lines: [
              line('relevant_positioning', true, 'It names what Corvid shipped.'),
              line('grounding', true, 'Helix is in a call.'),
              line('verified_specifics', true, 'The 70% is in a call.'),
              line('differentiation', false, 'It reads like boilerplate.'),
              line('cta_clarity', true, 'One clear ask.'),
            ],
            not_applicable_reason: null,
          }
        : {
            score: 5,
            passed: 1,
            total: 1,
            bar: 4.2,
            passes_bar: true,
            judge: { model: 'claude-sonnet-5-5', judge_version: 'v7', role: 'final' },
            lines: [abstain('relevant_positioning'), abstain('grounding'), abstain('verified_specifics'), abstain('differentiation'), line('cta_clarity', true, 'One clear ask.')],
            not_applicable_reason: null,
          },
      disclosures: { single_run: true, not_reply_prediction: true, repeat_spread: { model: 'claude-sonnet-5-5', moved_past: 0.2, share: 0.15, measured: 'a test' } },
    }
  }

  // The docs' finished prompt runs (message-optimizer/improve-a-prompt).
  function promptBody(mode: string): Record<string, unknown> {
    const rates = { cta_clarity: { passed: 2, total: 2, rate: 1 }, grounding: { passed: 0, total: 0, rate: null } }
    const email = (label: string, variant: string, split: string, score: number, text: string) => ({
      recipient: 0,
      label,
      variant,
      split,
      email: text,
      grade: { score, passed: 2, total: 5 },
      placeholders: [],
      unsupported_claims: [],
    })
    const judges = { final: { model: 'claude-sonnet-5-5', judge_version: 'v7', role: 'final' } }
    const disclosures = { single_run: true, not_reply_prediction: true, repeat_spread: null }
    if (mode === 'grade') {
      return {
        prompt_mode: 'grade',
        outcome: 'graded',
        grade: { original: { mean: 3.4, n: 4, emails_passing_bar: 1, bar: 4.2, lines: rates }, revised: null },
        lift: null,
        lift_reportable: false,
        emails: [email('Helix', 'original', 'graded', 3.4, 'Hi Jordan, Helix cut tickets by 70%. Worth 15 minutes?')],
        judges,
        disclosures,
      }
    }
    return {
      prompt_mode: 'improve',
      outcome: 'improved',
      prompt: 'Write a first-touch email to a Head of Platform. Name what they shipped, then ask for 15 minutes.',
      grade: {
        original: { mean: 2.6, n: 2, emails_passing_bar: 0, bar: 4.2, lines: rates },
        revised: { mean: 3.4, n: 2, emails_passing_bar: 1, bar: 4.2, lines: rates },
      },
      lift: null,
      lift_reportable: false,
      lift_not_reportable_reason: 'held_out_under_3',
      emails: [
        email('Helix', 'original', 'held_out', 2.6, 'Hi there, we help with provisioning.'),
        email('Helix', 'revised', 'held_out', 3.4, 'Hi Jordan, you shipped SSO. Worth 15 minutes?'),
        email('Brightpath', 'original', 'train', 2.2, 'Hello.'),
      ],
      train: { recipients: [0, 1], kept: 'revision_1' },
      judges,
      disclosures: { ...disclosures, train_scores_are_not_lift: true },
    }
  }

  function overviewBody(): Record<string, unknown> {
    return {
      surfaces: [
        { surface: 'interactions', row_count: 12431, earliest_at: '2025-01-03T10:00:00Z', latest_at: '2026-11-10T16:20:00Z', time_field: 'timestamp' },
        { surface: 'deals', row_count: 214, earliest_at: '2025-02-01T00:00:00Z', latest_at: '2026-10-30T00:00:00Z', time_field: 'close_date' },
        { surface: 'deal_qualification', row_count: null, earliest_at: null, latest_at: null, time_field: 'computed_at' },
      ],
    }
  }

  function fieldsBody(): Record<string, unknown> {
    const f = (name: string, type: string, description: string, extra: Record<string, unknown> = {}) => ({ name, type, description, operators: ['eq', 'in'], ...extra })
    return {
      surfaces: [
        {
          surface: 'interactions',
          fields: [
            f('company_name', 'STRING', 'The account the conversation was with.'),
            f('interaction_type', 'STRING', 'What kind of conversation it was.', { sample_values: ['CALL', 'EMAIL', 'MEETING'] }),
            f('timestamp', 'TIMESTAMP', 'When it happened.'),
          ],
        },
        { surface: 'deals', fields: [f('deal_name', 'STRING', 'The deal.'), f('deal_amount', 'NUMERIC', 'Its amount.'), f('close_date', 'DATE', 'When it closed.')] },
        { surface: 'deal_qualification', fields: [f('company_id', 'STRING', 'The company.'), f('computed_at', 'TIMESTAMP', 'When it was last scored.')] },
      ],
    }
  }

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
    pushes,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}
