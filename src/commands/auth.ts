// src/commands/auth.ts
//
// login, logout, whoami and `auth token`.
//
// Login is the OAuth authorization-code flow with PKCE over a loopback
// redirect: discover the endpoints, listen on 127.0.0.1, open the browser on
// the authorize URL, exchange the code, then ask /me/context who the token is
// and save that as a profile named after the workspace slug. The link is
// printed only when the browser could not be opened, or nothing came back
// within a few seconds. A new user may create their workspace on the way
// (the server's self-serve page, which returns to the same authorize request),
// so the wait is long. A user the server gives no workspace comes back as
// `error=no_business` and exits 5 with the one next step: the CLI never
// creates or joins a workspace and never touches the waitlist.

import type { MeContext } from '../api'
import type { StoredWorkspace } from '../config'
import { apiClient, call, requireOAuthCredential, resolveCredential, str, type Ctx } from '../context'
import { CliError, EXIT, usageError } from '../errors'
import {
  authorizeUrl,
  consoleUrlFor,
  createPkce,
  discover,
  exchangeCode,
  noBusinessMessage,
  revokeToken,
  signInAgainLine,
  startLoopback,
} from '../oauth'
import { printable } from '../output'
import { keychainAccount } from '../secrets'

export { noBusinessMessage }

/** Profile names become keychain account names, so keep them plain. */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** A token shortened for display: the first 10 characters and an ellipsis. */
export function tokenPreview(token: string): string {
  return `${token.slice(0, 10)}...`
}

/** A finished browser sign-in, saved as the default profile. */
export interface SignedIn {
  profile: string
  me: MeContext
  workspace: StoredWorkspace
}

/**
 * Sign in through the browser and save the profile. Says only "Opening your
 * browser…", plus the link when it is needed; the caller reports the result.
 */
export async function browserSignIn(ctx: Ctx): Promise<SignedIn> {
  const { io, out, flags } = ctx
  const workspace = str(flags.workspace)
  const rawPort = str(flags.port)
  const port = rawPort === undefined ? 0 : Number(rawPort)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw usageError('--port must be a number from 0 to 65535.')
  }
  const explicitProfile = str(flags.profile)
  if (explicitProfile && !PROFILE_NAME.test(explicitProfile)) {
    throw usageError('A profile name may use letters, digits, dot, dash and underscore.')
  }

  const endpoints = await discover(ctx.apiUrl)
  const pkce = createPkce()
  const consoleUrl = consoleUrlFor(io, ctx.apiUrl)
  let timer: ReturnType<typeof setTimeout> | undefined
  let linkShown = false
  const loopback = await startLoopback(io, {
    port,
    state: pkce.state,
    consoleUrl,
    timeoutMs: io.loginTimeoutMs,
    // The page carries the way on; the authorize link would only sign in as the same address again.
    onSignInAgain: (reason) => {
      clearTimeout(timer)
      linkShown = true
      out.info(signInAgainLine(reason))
    },
  })
  try {
    const url = authorizeUrl(endpoints, { redirectUri: loopback.redirectUri, pkce, workspace })
    loopback.setAuthorizeUrl(url)
    out.event({ event: 'open_url', url })
    const showLink = (lead: string) => {
      if (linkShown) return
      linkShown = true
      out.info(`${lead}\n\n  ${url}\n`)
    }
    if (flags['no-browser']) {
      showLink('Open this URL in a browser to sign in:')
    } else {
      out.info('Opening your browser…')
      void io.openUrl(url).then((opened) => {
        if (!opened) showLink('Your browser did not open. Open this link to sign in:')
      })
      timer = setTimeout(() => showLink('Finish in your browser, or open this link:'), io.browserGraceMs)
      timer.unref?.()
    }

    const callback = await loopback.result
    clearTimeout(timer)
    linkShown = true
    if (callback.kind === 'no_business') {
      throw new CliError('no_business', noBusinessMessage(consoleUrl, callback.mayCreate, callback.reason), EXIT.noWorkspace)
    }
    if (callback.kind === 'error') {
      throw new CliError(
        callback.error,
        `Sign-in failed: ${printable(callback.description ?? callback.error)}`,
        callback.error === 'access_denied' ? EXIT.forbidden : EXIT.general
      )
    }

    const secrets = await exchangeCode(io, endpoints, {
      code: callback.code,
      redirectUri: loopback.redirectUri,
      verifier: pkce.verifier,
    })
    const client = apiClient(ctx, { source: 'profile', token: secrets.access_token })
    const me = await call(() => client.cli.whoami())
    const ws = me.workspace ?? { id: me.business_id, name: me.business_id, slug: me.business_id }
    const name = explicitProfile ?? (PROFILE_NAME.test(ws.slug) ? ws.slug : 'default')

    await ctx.secrets().set(keychainAccount(ctx.apiUrl, name), secrets)
    ctx.config.profiles[name] = {
      api_url: ctx.apiUrl,
      user_id: me.user_id,
      email: me.email ?? null,
      workspace: ws,
      scopes: me.scopes,
      created_at: new Date(io.now()).toISOString(),
    }
    ctx.config.default_profile = name
    ctx.saveConfig()
    return { profile: name, me, workspace: ws }
  } finally {
    clearTimeout(timer)
    loopback.close()
  }
}

/** The sentence `amdahl login` ends with (and `amdahl --verbose` shows). */
export function signedInLine(ctx: Ctx, { profile, me, workspace }: SignedIn): string {
  return `Signed in as ${printable(me.email ?? me.user_id)} to ${ctx.out.bold(printable(workspace.name))} (${printable(workspace.slug)}). Profile: ${profile}.`
}

/** `amdahl login`. */
export async function login(ctx: Ctx): Promise<number> {
  const signedIn = await browserSignIn(ctx)
  const { profile, me, workspace } = signedIn
  ctx.out.result(
    {
      ok: true,
      profile,
      user: { id: me.user_id, email: me.email ?? null },
      workspace,
      scopes: me.scopes,
      api_url: ctx.apiUrl,
    },
    signedInLine(ctx, signedIn)
  )
  return EXIT.ok
}

/**
 * `amdahl logout [--all]`: revoke both tokens, then forget the profile.
 *
 * The local secrets are deleted even when the server cannot revoke a token.
 * `revoked` is true only when every profile's tokens were revoked, and
 * `not_revoked` names each profile whose revoke failed, so `--all` says which
 * sign-ins may stay valid until their tokens expire.
 */
export async function logout(ctx: Ctx): Promise<number> {
  const { config, out } = ctx
  const names = ctx.flags.all
    ? Object.keys(config.profiles)
    : ctx.profileName && config.profiles[ctx.profileName]
      ? [ctx.profileName]
      : []
  if (names.length === 0) {
    out.result({ ok: true, profiles: [], revoked: false, not_revoked: [] }, 'Not signed in.')
    return EXIT.ok
  }

  const notRevoked: string[] = []
  const store = ctx.secrets()
  for (const name of names) {
    const profile = config.profiles[name]
    if (!profile) continue
    const account = keychainAccount(profile.api_url, name)
    const secrets = await store.get(account)
    if (secrets) {
      let ok = false
      try {
        const endpoints = await discover(profile.api_url)
        const a = await revokeToken(endpoints, secrets.access_token)
        const r = await revokeToken(endpoints, secrets.refresh_token)
        ok = a && r
      } catch {
        ok = false
      }
      if (!ok) notRevoked.push(name)
    }
    await store.delete(account)
    delete config.profiles[name]
  }
  if (config.default_profile && !config.profiles[config.default_profile]) {
    config.default_profile = Object.keys(config.profiles)[0] ?? null
  }
  ctx.saveConfig()
  const failed =
    notRevoked.length === 0
      ? ''
      : ` The server could not revoke the tokens for ${notRevoked.join(', ')}; they stay valid until they expire.`
  out.result(
    { ok: true, profiles: names, revoked: notRevoked.length === 0, not_revoked: notRevoked },
    `Signed out of ${names.join(', ')}.${failed}`
  )
  return EXIT.ok
}

/** `amdahl whoami [--show-token]`. */
export async function whoami(ctx: Ctx): Promise<number> {
  const credential = await resolveCredential(ctx)
  const me = await call(() => apiClient(ctx, credential).cli.whoami())
  const showToken = ctx.flags['show-token'] === true
  const data: Record<string, unknown> = {
    ok: true,
    source: credential.source,
    profile: credential.profile ?? null,
    user: { id: me.user_id, email: me.email ?? null },
    workspace: me.workspace ?? { id: me.business_id },
    role: me.role ?? null,
    auth_method: me.auth_method,
    client_id: me.client_id ?? null,
    scopes: me.scopes,
    token_preview: tokenPreview(credential.token),
  }
  if (showToken) data.token = credential.token
  const ws = me.workspace
  const lines = [
    `User:       ${me.email ?? me.user_id}`,
    `Workspace:  ${ws ? `${ws.name} (${ws.slug})` : me.business_id}`,
    `Role:       ${me.role ?? 'unknown'}`,
    `Signed in:  ${me.auth_method}${me.client_id ? ` (${me.client_id})` : ''} via ${credential.source}${credential.profile ? ` [${credential.profile}]` : ''}`,
    `Scopes:     ${me.scopes.join(' ') || 'none'}`,
    `Token:      ${showToken ? credential.token : tokenPreview(credential.token)}`,
  ]
  ctx.out.result(data, lines.join('\n'))
  return EXIT.ok
}

/** `amdahl auth token`: print a fresh access token from the stored sign-in. */
export async function authToken(ctx: Ctx): Promise<number> {
  const credential = await requireOAuthCredential(ctx)
  const profile = ctx.profile
  const secrets = profile && credential.profile
    ? await ctx.secrets().get(keychainAccount(profile.api_url, credential.profile))
    : null
  if (ctx.out.json) {
    ctx.out.result({ ok: true, access_token: credential.token, expires_at: secrets?.access_expires_at ?? null })
  } else {
    ctx.io.stdout(`${credential.token}\n`)
  }
  return EXIT.ok
}
