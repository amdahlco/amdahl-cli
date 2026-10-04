// src/keygen.ts
//
// Local key generation for `amdahl keys create`. The secret is made HERE and
// never sent: the server receives only its sha256 hash and display prefix, and
// mints the key from those once a console session approves the request.

import { createHash, randomBytes } from 'node:crypto'

/** A freshly generated key and what the server may see of it. */
export interface GeneratedKey {
  /** `amdhl_` + 48 hex characters. Shown once, never stored. */
  secret: string
  /** sha256 hex of the full secret. */
  hash: string
  /** The first 14 characters: `amdhl_` + 8 hex. */
  prefix: string
}

/** Generate a key from 24 random bytes. */
export function generateKey(): GeneratedKey {
  const secret = `amdhl_${randomBytes(24).toString('hex')}`
  return {
    secret,
    hash: createHash('sha256').update(secret).digest('hex'),
    prefix: secret.slice(0, 14),
  }
}

/** The key bundles behind each `--preset`. */
export const PRESET_BUNDLES = {
  'read-only': 'mcp_read_only',
  agent: 'mcp_customer_agent',
  internal: 'mcp_internal_agent',
  admin: 'mcp_full_admin',
} as const

/** The `--expires` values and their day counts. There is no "never". */
export const EXPIRES_DAYS = { '30d': 30, '90d': 90, '365d': 365 } as const

