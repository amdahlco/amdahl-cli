// src/api.ts
//
// The slice of the Amdahl API the CLI calls, as a small typed fetch client.
// Every request sends the credential (an OAuth access token or an `amdhl_`
// key) as `Authorization: Bearer`. The routes:
//
//   GET  /api/platform/v1/me/context                     whoami
//   GET  /api/platform/v1/setup/status                   setupStatus
//   POST /api/platform/v1/cli/key-requests               createKeyRequest
//   GET  /api/platform/v1/cli/key-requests/:requestId    getKeyRequestStatus
//   GET  /api/team/:businessId/mcp-keys                  mcpKeys.list
//   POST /api/platform/v1/messages/optimize              via request()
//
// The server owns this contract. `__tests__/helpers/mock-server.ts` mirrors
// it, so a change to a route or a response shape belongs in both places.
//
// A CLI OAuth token can only OPEN a key request. Approving it, which mints or
// revokes the key, happens in the console. The secret never reaches the
// server: the CLI sends only its sha256 hash and display prefix.

// ── Types ───────────────────────────────────────────────────────────────────

/** A workspace as the CLI endpoints name it. */
export interface CliWorkspace {
  id: string
  name: string
  slug: string
}

/** Role vocabulary the server reports for the caller. */
export type CliRole = 'owner' | 'admin' | 'editor' | 'viewer'

/**
 * `GET /api/platform/v1/me/context`: who this credential is. The fields after
 * `auth_method` are optional so an older server still parses.
 */
export interface MeContext {
  user_id: string
  business_id: string
  scopes: string[]
  auth_method: 'oauth' | 'api_key'
  email?: string | null
  /** Null only when the server could not read the workspace record. */
  workspace?: CliWorkspace | null
  role?: CliRole
  /** The OAuth client id, or null for an API key. */
  client_id?: string | null
}

/** Why the caller cannot optimize right now, or null when it can. */
export type OptimizeBlocker = 'missing_scope' | 'role_too_low' | 'quota_exhausted' | null

/** One connection that needs attention in {@link CliSetupStatus}. */
export interface CliSetupStatusConnection {
  id: string
  connector_type: string
  name: string
  /** The connection health word: `needs_reauth`, `error`, `stale` and so on. */
  status: string
}

/** `GET /api/platform/v1/setup/status`: data only, no prose. */
export interface CliSetupStatus {
  /** Null only when the server could not read the workspace record. */
  workspace: CliWorkspace | null
  caller: {
    user_id: string
    email: string | null
    role: CliRole | null
    auth_method: 'oauth' | 'api_key' | 'session'
    client_id: string | null
    scopes: string[]
  }
  optimize: {
    allowed: boolean
    blocker: OptimizeBlocker
    /** Null for unmetered callers and when no monthly cap is set. */
    quota: { limit: number; used: number; remaining: number; resets_at: string } | null
  }
  /**
   * Omitted as a section when the credential lacks `connections:read`
   * (`missing_scope`) or the connections could not be read (`unavailable`).
   */
  connections:
    | { total: number; healthy: number; needs_attention: CliSetupStatusConnection[] }
    | { omitted: 'missing_scope' | 'unavailable' }
}

/** The scope bundles a key can be minted from (see `--preset`). */
export type McpKeyBundleName =
  | 'mcp_read_only'
  | 'mcp_customer_agent'
  | 'mcp_internal_agent'
  | 'mcp_full_admin'

/** Key lifetimes a CLI request may ask for. There is no "never". */
export type CliKeyExpiresInDays = 30 | 90 | 365

/** Body of `POST /api/platform/v1/cli/key-requests`. */
export type CreateCliKeyRequestInput =
  | {
      action: 'create'
      name: string
      bundle_name: McpKeyBundleName
      expires_in_days: CliKeyExpiresInDays
      /** sha256 hex of the full key. The key itself never leaves the device. */
      key_hash: string
      /** First 14 characters of the key (`amdhl_` + 8 hex). */
      key_prefix: string
      device_name?: string
    }
  | { action: 'revoke'; key_id: string; device_name?: string }

/** 201 response of `POST /api/platform/v1/cli/key-requests`. */
export interface CliKeyRequestCreated {
  request_id: string
  /** The pairing code, `XXXX-XXXX`. Typed into the console, never in a URL. */
  user_code: string
  approve_url: string
  expires_at: string
  /** Seconds between status polls. */
  interval: number
}

/** The key a request created, as the CLI may see it (no secret). */
export interface CliKeySummary {
  id: string
  key_prefix: string
  name: string
  bundle_name: string | null
  expires_at: string | null
}

/** `GET /api/platform/v1/cli/key-requests/:requestId`. */
export interface CliKeyRequestStatus {
  request_id: string
  action: 'create' | 'revoke'
  status: 'pending' | 'approved' | 'denied' | 'expired'
  expires_at: string
  /** Only on an approved create. */
  key?: CliKeySummary
  /** Only on a revoke. */
  key_id?: string
}

/** One key row from `GET /api/team/:businessId/mcp-keys` (never the secret). */
export interface McpKeyRecord {
  id: string
  /** The user who minted the key. */
  user_id: string | null
  name: string
  /** The display prefix of the key (`amdhl_xxxxxxxx`). */
  key_prefix: string
  scopes: string[]
  last_used_at: string | null
  created_at: string
  revoked: boolean
  bundle_name: string | null
  creator_email: string | null
  creator_display_name: string | null
  /** True when the caller minted this key. */
  is_mine: boolean
  /** Null when the key never expires. */
  expires_at: string | null
  request_count: number
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** A non-2xx response, or a 2xx tool-failure envelope. */
export class AmdahlApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly path: string,
    public readonly responseBody?: string,
    /** Machine-readable code from the response body, when it sent one. */
    public readonly errorCode?: string
  ) {
    super(message)
    this.name = 'AmdahlApiError'
  }
}

/**
 * Detect a tool failure inside an HTTP-2xx response:
 * `{data: {success: false, error: {code, message}}}`. Requires BOTH
 * `success === false` and an `error` object, so a successful payload that
 * happens to carry a `success` key is left alone.
 */
function extractToolFailure(json: unknown): { message: string; code?: string } | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const data = (json as { data?: unknown }).data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  if ((data as { success?: unknown }).success !== false) return null
  const err = (data as { error?: unknown }).error
  if (!err || typeof err !== 'object') return null
  const message = (err as { message?: unknown }).message
  const code = (err as { code?: unknown }).code
  return {
    message: typeof message === 'string' ? message : 'Tool returned failure',
    code: typeof code === 'string' ? code : undefined,
  }
}

/**
 * Pull a message and an optional code out of an error body. The server sends
 * four shapes, bare or inside one `{data: ...}` envelope:
 *
 *   {error: {code, message}}
 *   {error: '<code>', message: '...'}
 *   {error: '<sentence>', code: '<code>'}
 *   {code: '<code>', message: '...'}
 *
 * A top-level string `code` is always the code. Anything unrecognized falls
 * back to "Request failed: <status>".
 */
function parseErrorBody(errorBody: string, statusCode: number): { message: string; code?: string } {
  const fallback = `Request failed: ${statusCode}`
  if (!errorBody) return { message: fallback }
  let parsed: unknown
  try {
    parsed = JSON.parse(errorBody)
  } catch {
    // Not JSON: surface a short raw body, otherwise the status line.
    const trimmed = errorBody.trim()
    if (trimmed && trimmed.length <= 200) return { message: trimmed }
    return { message: fallback }
  }
  if (!parsed || typeof parsed !== 'object') return { message: fallback }
  // Unwrap one `{data: ...}` envelope. Only a lone `data` key is an envelope;
  // a `data` beside other keys is a payload riding with the error.
  const inner = (parsed as { data?: unknown }).data
  if (inner && typeof inner === 'object' && !Array.isArray(inner) && Object.keys(parsed).length === 1) {
    parsed = inner
  }
  const err = (parsed as { error?: unknown }).error
  const siblingMsg = (parsed as { message?: unknown }).message
  const topCode = (parsed as { code?: unknown }).code
  const flatCode = typeof topCode === 'string' ? topCode : undefined
  if (typeof err === 'string') {
    // Without a top-level `code`, the string error doubles as the code.
    return {
      message: typeof siblingMsg === 'string' ? siblingMsg : err,
      code: flatCode ?? err,
    }
  }
  if (err && typeof err === 'object') {
    const msg = (err as { message?: unknown }).message
    const code = (err as { code?: unknown }).code
    return {
      message: typeof msg === 'string' ? msg : fallback,
      code: typeof code === 'string' ? code : undefined,
    }
  }
  const msg = siblingMsg ?? (parsed as { detail?: unknown }).detail
  return { message: typeof msg === 'string' ? msg : fallback, code: flatCode }
}

// ── Client ──────────────────────────────────────────────────────────────────

const PLATFORM = '/api/platform/v1'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertUuid(name: string, value: unknown): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `mcpKeys client: ${name} must be a non-empty string (got ${typeof value === 'string' ? 'empty string' : String(value)})`
    )
  }
  const lowered = value.toLowerCase()
  if (lowered === 'undefined' || lowered === 'null') {
    throw new Error(
      `mcpKeys client: ${name} is the literal string '${value}'. Fix the caller rather than relaxing this guard.`
    )
  }
  if (!UUID_RE.test(value)) {
    throw new Error(`mcpKeys client: ${name} must be a UUID (got '${value}')`)
  }
}

export interface AmdahlClientConfig {
  /** Base URL of the API, e.g. https://app.amdahl.ai */
  baseUrl: string
  /** An OAuth access token or an `amdhl_` key, sent as a bearer credential. */
  token: string
}

export function createAmdahlClient(config: AmdahlClientConfig) {
  const { baseUrl, token } = config

  async function request<T>(
    path: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<T> {
    const { method = 'GET', body, headers = {} } = options
    const allHeaders: Record<string, string> = { ...headers, Authorization: `Bearer ${token}` }
    if (body && !allHeaders['Content-Type']) allHeaders['Content-Type'] = 'application/json'

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: allHeaders,
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '')
      const { message, code } = parseErrorBody(errorBody, response.status)
      throw new AmdahlApiError(message, response.status, path, errorBody, code)
    }

    const json = (await response.json()) as unknown
    const toolFailure = extractToolFailure(json)
    if (toolFailure) {
      throw new AmdahlApiError(toolFailure.message, response.status, path, JSON.stringify(json), toolFailure.code)
    }
    // Unwrap a lone `{data: ...}` envelope; anything else passes through.
    if (
      json &&
      typeof json === 'object' &&
      !Array.isArray(json) &&
      'data' in json &&
      Object.keys(json as Record<string, unknown>).length === 1
    ) {
      return (json as { data: T }).data
    }
    return json as T
  }

  const cli = {
    /** Open a pending key request. Only an `amdahl-cli` OAuth token may. */
    createKeyRequest: (input: CreateCliKeyRequestInput) =>
      request<CliKeyRequestCreated>(`${PLATFORM}/cli/key-requests`, { method: 'POST', body: input }),

    /** Poll one key request the caller opened. */
    getKeyRequestStatus: (requestId: string) => {
      if (!requestId) throw new Error('cli.getKeyRequestStatus: requestId is required')
      return request<CliKeyRequestStatus>(`${PLATFORM}/cli/key-requests/${encodeURIComponent(requestId)}`)
    },

    /** Introspect the credential this client sends. */
    whoami: () => request<MeContext>(`${PLATFORM}/me/context`),

    /** Read the workspace setup status (optimize blocker, quota, connections). */
    setupStatus: () => request<CliSetupStatus>(`${PLATFORM}/setup/status`),
  }

  const mcpKeys = {
    /** List the workspace's active keys. */
    list: (businessId: string) => {
      assertUuid('businessId', businessId)
      return request<{ keys: McpKeyRecord[] }>(`/api/team/${businessId}/mcp-keys`)
    },
  }

  return { cli, mcpKeys, request }
}

export type AmdahlClient = ReturnType<typeof createAmdahlClient>
