// src/context.ts
//
// Per-invocation state: the API base, the selected profile, the credential
// that wins the precedence order, and an API client bound to it. Also the one
// place server and transport failures become CliErrors with exit codes.

import { AmdahlApiError, createAmdahlClient, type AmdahlClient } from './api'
import { loadConfig, saveConfig, selectedProfileName, type Config, type Profile } from './config'
import { CliError, EXIT, NOT_SIGNED_IN, exitForHttp, usageError } from './errors'
import type { Io } from './io'
import { refreshTokens } from './oauth'
import type { Output } from './output'
import { createSecretStore, keychainAccount, type SecretStore } from './secrets'

/** The production API host. */
export const DEFAULT_API_URL = 'https://app.amdahl.ai'

/** Where the winning credential came from (reported by `whoami`). */
export type CredentialSource =
  | 'flag'
  | 'env:AMDAHL_KEY'
  | 'env:AMDAHL_API_KEY'
  | 'env:AMDAHL_ACCESS_TOKEN'
  | 'profile'

/** A credential ready to send. */
export interface Credential {
  source: CredentialSource
  token: string
  /** The profile name, only for `profile`. */
  profile?: string
}

/** Everything a command needs. */
export interface Ctx {
  io: Io
  out: Output
  flags: Record<string, string | boolean | undefined>
  config: Config
  /** The selected profile's name, whether or not it exists. */
  profileName: string | null
  /** The selected profile, when it exists. */
  profile: Profile | null
  apiUrl: string
  /** True when prompts are not allowed. */
  nonInteractive: boolean
  secrets: () => SecretStore
  saveConfig: () => void
}

/** Validate and normalise an API base URL (no trailing slash). */
export function normaliseApiUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw usageError(`Not a valid API URL: ${raw}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw usageError(`The API URL must be http or https: ${raw}`)
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/** Build the context from parsed flags. */
export function createCtx(io: Io, out: Output, flags: Ctx['flags']): Ctx {
  const config = loadConfig(io)
  const profileName = selectedProfileName(io, config, str(flags.profile))
  const profile = profileName ? (config.profiles[profileName] ?? null) : null
  const rawApi = str(flags['api-url']) || io.env.AMDAHL_API_URL || profile?.api_url || DEFAULT_API_URL
  let store: SecretStore | null = null
  return {
    io,
    out,
    flags,
    config,
    profileName,
    profile,
    apiUrl: normaliseApiUrl(rawApi),
    nonInteractive: !io.stdinIsTTY || io.env.AMDAHL_NO_PROMPT === '1',
    secrets: () => (store ??= createSecretStore(io)),
    saveConfig: () => saveConfig(io, config),
  }
}

/** A string flag value, or undefined. */
export function str(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The credential that wins: `--api-key`, AMDAHL_KEY, AMDAHL_API_KEY,
 * AMDAHL_ACCESS_TOKEN, then the stored OAuth profile (refreshed when it has
 * under 60 s left).
 *
 * @throws exit 3 with the not-signed-in message when there is none.
 */
export async function resolveCredential(ctx: Ctx): Promise<Credential> {
  const flag = str(ctx.flags['api-key'])
  if (flag) return { source: 'flag', token: flag }
  const env = ctx.io.env
  if (env.AMDAHL_KEY) return { source: 'env:AMDAHL_KEY', token: env.AMDAHL_KEY }
  if (env.AMDAHL_API_KEY) return { source: 'env:AMDAHL_API_KEY', token: env.AMDAHL_API_KEY }
  if (env.AMDAHL_ACCESS_TOKEN) {
    return { source: 'env:AMDAHL_ACCESS_TOKEN', token: env.AMDAHL_ACCESS_TOKEN }
  }
  return profileCredential(ctx)
}

/**
 * The stored OAuth credential, required. For commands that need a console
 * user behind them (`keys create|revoke`, `auth token`): any higher-precedence
 * source exits 4 `oauth_required`.
 */
export async function requireOAuthCredential(ctx: Ctx): Promise<Credential> {
  const winner = str(ctx.flags['api-key'])
    ? 'flag'
    : ['AMDAHL_KEY', 'AMDAHL_API_KEY', 'AMDAHL_ACCESS_TOKEN'].find((k) => ctx.io.env[k])
  if (winner) {
    throw new CliError(
      'oauth_required',
      `This command needs your own sign-in, but a credential from ${winner === 'flag' ? '--api-key' : winner} takes precedence.`,
      EXIT.forbidden,
      'Unset it and run `amdahl login`.'
    )
  }
  return profileCredential(ctx)
}

async function profileCredential(ctx: Ctx): Promise<Credential> {
  const { profile, profileName } = ctx
  if (!profile || !profileName) {
    throw new CliError('not_signed_in', NOT_SIGNED_IN, EXIT.unauthenticated)
  }
  // A profile's token only ever goes to the host that issued it, so an
  // --api-url / AMDAHL_API_URL pointing elsewhere cannot leak it.
  if (normaliseApiUrl(profile.api_url) !== ctx.apiUrl) {
    throw new CliError(
      'profile_host_mismatch',
      `Profile "${profileName}" is signed in to ${profile.api_url}, not ${ctx.apiUrl}.`,
      EXIT.usage,
      'Drop --api-url / AMDAHL_API_URL, or run `amdahl login` against that host.'
    )
  }
  const account = keychainAccount(profile.api_url, profileName)
  const store = ctx.secrets()
  const secrets = await store.get(account)
  if (!secrets) throw new CliError('not_signed_in', NOT_SIGNED_IN, EXIT.unauthenticated)

  const left = Date.parse(secrets.access_expires_at) - ctx.io.now()
  if (Number.isFinite(left) && left >= 60_000) {
    return { source: 'profile', token: secrets.access_token, profile: profileName }
  }
  const refreshed = await refreshTokens(ctx.io, profile.api_url, secrets.refresh_token)
  if (refreshed === 'invalid_grant') {
    await store.delete(account)
    throw new CliError(
      'invalid_grant',
      'Your sign-in has expired.',
      EXIT.unauthenticated,
      'Run `amdahl login` again.'
    )
  }
  await store.set(account, refreshed)
  return { source: 'profile', token: refreshed.access_token, profile: profileName }
}

/** An API client that sends the credential as `Authorization: Bearer`. */
export function apiClient(ctx: Ctx, credential: Credential): AmdahlClient {
  return createAmdahlClient({ baseUrl: ctx.apiUrl, token: credential.token })
}

/** Pull `details` from a server error body, when it sent any. */
function errorDetails(body: string | undefined): Record<string, unknown> {
  if (!body) return {}
  try {
    const parsed = JSON.parse(body) as { error?: { details?: unknown }; details?: unknown }
    const details = (typeof parsed.error === 'object' && parsed.error?.details) || parsed.details
    return details && typeof details === 'object' ? (details as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Turn anything a request threw into a CliError. AmdahlApiError carries the
 * HTTP status and the server's code; anything else is a transport failure.
 */
export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err
  if (err instanceof AmdahlApiError) {
    const exit = exitForHttp(err.statusCode, err.errorCode)
    const details = errorDetails(err.responseBody)
    const retry = details.retry_after_seconds
    const hint =
      exit === EXIT.unauthenticated
        ? 'Run `amdahl login`, or check AMDAHL_KEY.'
        : typeof retry === 'number'
          ? `Try again in ${retry} seconds.`
          : undefined
    return new CliError(err.errorCode ?? `http_${err.statusCode}`, err.message, exit, hint)
  }
  const message = err instanceof Error ? err.message : String(err)
  return new CliError('network_error', `Could not reach the Amdahl API: ${message}`, EXIT.network)
}

/** Run a request and rethrow any failure as a CliError. */
export async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toCliError(err)
  }
}
