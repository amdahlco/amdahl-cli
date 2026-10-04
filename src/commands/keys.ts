// src/commands/keys.ts
//
// `keys create | list | revoke`.
//
// Creating or revoking a key changes a workspace credential, so the CLI can
// only OPEN a pending request; a person approves it in the console, signed in,
// by typing the pairing code shown here. For a create the secret is generated
// locally and only its hash and prefix are sent, so the server mints a key it
// never saw. The secret is printed once, on stdout, and stored nowhere.

import type { CliKeyRequestCreated, CliKeyRequestStatus, McpKeyRecord } from '../api'
import {
  apiClient,
  call,
  requireOAuthCredential,
  resolveCredential,
  str,
  toCliError,
  type Ctx,
} from '../context'
import { CliError, EXIT, usageError } from '../errors'
import { EXPIRES_DAYS, PRESET_BUNDLES, generateKey } from '../keygen'
import type { AmdahlClient } from '../api'

/** Wait this long between polls when the server rate-limits them. */
const RATE_LIMIT_BACKOFF_MS = 10_000

/** Show the code and the approve link, and open the browser. */
function announce(ctx: Ctx, req: CliKeyRequestCreated, verb: string): void {
  const { out, io } = ctx
  out.event({ event: 'approve', url: req.approve_url, user_code: req.user_code, expires_at: req.expires_at })
  out.info(
    `To ${verb}, open this page while signed in to the console and enter the code.\n\n` +
      `  Code: ${out.bold(req.user_code)}\n  Page: ${req.approve_url}\n\n` +
      `The request expires at ${req.expires_at}. Waiting for approval...`
  )
  if (!ctx.flags['no-browser']) void io.openUrl(req.approve_url)
}

/**
 * Poll until the request leaves `pending`. A deny or an expiry exits 7.
 *
 * @returns the approved status.
 */
async function waitForDecision(
  ctx: Ctx,
  client: AmdahlClient,
  req: CliKeyRequestCreated
): Promise<CliKeyRequestStatus> {
  const { io } = ctx
  const intervalMs = Math.max(1, req.interval || 3) * 1000
  const deadline = Date.parse(req.expires_at)
  for (;;) {
    await io.sleep(intervalMs)
    let state: CliKeyRequestStatus
    try {
      state = await client.cli.getKeyRequestStatus(req.request_id)
    } catch (err) {
      const cliErr = toCliError(err)
      if (cliErr.exit === EXIT.rateLimited) {
        await io.sleep(RATE_LIMIT_BACKOFF_MS)
        continue
      }
      throw cliErr
    }
    if (state.status === 'approved') return state
    if (state.status === 'denied') {
      throw new CliError('request_denied', 'The request was denied in the console.', EXIT.denied)
    }
    if (state.status === 'expired' || (Number.isFinite(deadline) && io.now() > deadline + 5_000)) {
      throw new CliError(
        'request_expired',
        'The request expired before it was approved.',
        EXIT.denied,
        'Run the command again.'
      )
    }
  }
}

/** `amdahl keys create --name <name> [--preset ...] [--expires ...]`. */
export async function keysCreate(ctx: Ctx): Promise<number> {
  const name = str(ctx.flags.name)?.trim()
  if (!name) throw usageError('--name is required.', 'Example: amdahl keys create --name "CI pipeline"')
  if (name.length > 80) throw usageError('--name must be at most 80 characters.')
  const preset = str(ctx.flags.preset) ?? 'read-only'
  const bundle = PRESET_BUNDLES[preset as keyof typeof PRESET_BUNDLES]
  if (!bundle) throw usageError(`--preset must be one of: ${Object.keys(PRESET_BUNDLES).join(', ')}.`)
  const expires = str(ctx.flags.expires) ?? '90d'
  const days = EXPIRES_DAYS[expires as keyof typeof EXPIRES_DAYS]
  if (!days) throw usageError(`--expires must be one of: ${Object.keys(EXPIRES_DAYS).join(', ')}.`)

  const credential = await requireOAuthCredential(ctx)
  const client = apiClient(ctx, credential)
  const key = generateKey()
  const req = await call(() =>
    client.cli.createKeyRequest({
      action: 'create',
      name,
      bundle_name: bundle,
      expires_in_days: days,
      key_hash: key.hash,
      key_prefix: key.prefix,
      device_name: ctx.io.hostname.slice(0, 120),
    })
  )
  announce(ctx, req, `create the key "${name}"`)
  const state = await waitForDecision(ctx, client, req)
  const minted = state.key
  if (!minted || minted.key_prefix !== key.prefix) {
    throw new CliError(
      'key_mismatch',
      'The approved key does not match the one this terminal generated. Nothing was printed.',
      EXIT.general,
      'Revoke the new key in the console and try again.'
    )
  }
  ctx.out.info(`Key created: ${minted.name} (${minted.key_prefix}...). Copy it now: it is shown once and stored nowhere.`)
  ctx.out.result({ ok: true, secret: key.secret, key: minted }, key.secret)
  return EXIT.ok
}

/** The workspace id behind a credential: the profile's, else /me/context. */
async function workspaceId(ctx: Ctx, client: AmdahlClient, fromProfile: boolean): Promise<string> {
  if (fromProfile && ctx.profile) return ctx.profile.workspace.id
  const me = await call(() => client.cli.whoami())
  return me.business_id
}

/** `amdahl keys list`. */
export async function keysList(ctx: Ctx): Promise<number> {
  const credential = await resolveCredential(ctx)
  const client = apiClient(ctx, credential)
  const businessId = await workspaceId(ctx, client, credential.source === 'profile')
  const { keys } = await call(() => client.mcpKeys.list(businessId))
  const rows = keys.map((k: McpKeyRecord) => ({
    id: k.id,
    key_prefix: k.key_prefix,
    name: k.name,
    bundle_name: k.bundle_name,
    created_at: k.created_at,
    expires_at: k.expires_at ?? null,
    last_used_at: k.last_used_at,
    is_mine: k.is_mine,
    creator_email: k.creator_email,
  }))
  const human =
    rows.length === 0
      ? 'No keys.'
      : rows
          .map(
            (k) =>
              `${k.key_prefix}...  ${k.name}  ${k.bundle_name ?? ''}  expires ${k.expires_at ?? 'never'}  ${k.is_mine ? '(you)' : (k.creator_email ?? '')}  ${k.id}`
          )
          .join('\n')
  ctx.out.result({ ok: true, keys: rows }, human)
  return EXIT.ok
}

/** Find the key a revoke names: an exact id, or a key prefix. */
function findKey(keys: McpKeyRecord[], ref: string): McpKeyRecord {
  const exact = keys.find((k) => k.id === ref || k.key_prefix === ref)
  if (exact) return exact
  const matches = keys.filter((k) => ref.length >= 8 && k.key_prefix.startsWith(ref))
  if (matches.length === 1 && matches[0]) return matches[0]
  if (matches.length > 1) throw usageError(`"${ref}" matches ${matches.length} keys. Use the key id.`)
  throw new CliError('key_not_found', `No active key matches "${ref}".`, EXIT.general, 'Run `amdahl keys list`.')
}

/** `amdahl keys revoke <id|prefix> [--yes]`. */
export async function keysRevoke(ctx: Ctx, args: string[]): Promise<number> {
  const ref = args[0]
  if (!ref || args.length > 1) throw usageError('Usage: amdahl keys revoke <id|prefix> [--yes]')
  const confirmed = ctx.flags.yes === true
  if (!confirmed && ctx.nonInteractive) {
    throw usageError('Refusing to revoke without confirmation.', 'Pass --yes to revoke without a prompt.')
  }

  const credential = await requireOAuthCredential(ctx)
  const client = apiClient(ctx, credential)
  const businessId = await workspaceId(ctx, client, true)
  const { keys } = await call(() => client.mcpKeys.list(businessId))
  const target = findKey(keys, ref)

  if (!confirmed) {
    const answer = await ctx.io.prompt(`Type the key name (${target.name}) to revoke it: `)
    if (answer.trim() !== target.name) {
      throw new CliError('aborted', 'Not revoked: the name did not match.', EXIT.general)
    }
  }

  const req = await call(() =>
    client.cli.createKeyRequest({
      action: 'revoke',
      key_id: target.id,
      device_name: ctx.io.hostname.slice(0, 120),
    })
  )
  announce(ctx, req, `revoke the key "${target.name}"`)
  const state = await waitForDecision(ctx, client, req)
  const revokedId = state.key_id ?? target.id
  ctx.out.result({ ok: true, revoked_key_id: revokedId }, `Key revoked: ${target.name} (${revokedId}).`)
  return EXIT.ok
}
