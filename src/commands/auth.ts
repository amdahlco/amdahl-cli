// src/commands/auth.ts
//
// login, logout, whoami and `auth token`.
//
// Login is the OAuth authorization-code flow with PKCE over a loopback
// redirect: discover the endpoints, listen on 127.0.0.1, open the browser on
// the authorize URL, exchange the code, then ask /me/context who the token is
// and save that as a profile named after the workspace slug. The full link
// is printed at once only with --no-browser or when the browser could not be
// opened. Otherwise a person at a terminal gets one short line: a clickable
// link where the terminal supports one, and Enter prints the full link.
// A new user may create their workspace on the way
// (the server's self-serve page, which returns to the same authorize request),
// so the wait is long. A user the server gives no workspace comes back as
// `error=no_business` and exits 5 with the one next step: the CLI never
// creates or joins a workspace and never touches the waitlist.

import type { MeContext } from '../api'
import { amdahlCommand } from '../command-name'
import type { StoredWorkspace } from '../config'
import { apiClient, call, requireOAuthCredential, resolveCredential, str, type Ctx } from '../context'
import { CliError, EXIT, usageError } from '../errors'
import { PromptCancelled } from '../io'
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
import { hyperlink, printable, supportsHyperlinks } from '../output'
import { keychainAccount } from '../secrets'
import { eraseUp, screenLines } from '../select'

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
 * Sign in through the browser and save the profile. Says "Opening your
 * browser…" and, at a terminal, how to get the link; the caller reports the
 * result. Ctrl+C while it waits rejects with PromptCancelled.
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
  let stopKeys = () => {}
  let linkShown = false
  const loopback = await startLoopback(io, {
    port,
    state: pkce.state,
    consoleUrl,
    timeoutMs: io.loginTimeoutMs,
    // The page carries the way on; the authorize link would only sign in as the same address again.
    onSignInAgain: (reason, retry) => {
      linkShown = true
      out.info(signInAgainLine(reason, retry))
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
    let cancelled: Promise<never> | undefined
    // The "Browser didn't open?" line, while it is the last thing on screen: a finished sign-in erases it.
    let fallbackLine: string | null = null
    if (flags['no-browser']) {
      showLink('Open this URL in a browser to sign in:')
    } else {
      out.info('Opening your browser…')
      if (!ctx.nonInteractive && io.stderrIsTTY) {
        const fallback = supportsHyperlinks(io.env, out.color) ? hyperlink('Open the sign-in page', url) : 'Press Enter for the link.'
        fallbackLine = `Browser didn't open? ${fallback}`
        out.info(fallbackLine)
        cancelled = new Promise<never>((_, reject) => {
          stopKeys = io.listenForEnter(
            () => showLink('Open this link to sign in:'),
            () => reject(new PromptCancelled())
          )
        })
      }
      void io.openUrl(url).then((opened) => {
        if (!opened) showLink('Your browser did not open. Open this link to sign in:')
      })
    }

    const callback = await (cancelled ? Promise.race([loopback.result, cancelled]) : loopback.result)
    stopKeys()
    // Nothing printed under it (no link, no "sign in again"): the line is the last on screen, and done with.
    if (fallbackLine && !linkShown && callback.kind === 'code') io.stderr(eraseUp(screenLines(fallbackLine, io.columns())))
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
    // The rest of this run (the setup's try-out, `optimize`) uses the new sign-in.
    ctx.profileName = name
    ctx.profile = ctx.config.profiles[name] ?? null
    return { profile: name, me, workspace: ws }
  } finally {
    stopKeys()
    loopback.close()
  }
}

/** The sentence `amdahl login` ends with (and `amdahl --verbose` shows). */
export function signedInLine(ctx: Ctx, { profile, me, workspace }: SignedIn): string {
  return `Signed in as ${printable(me.email ?? me.user_id)} to ${ctx.out.bold(printable(workspace.name))} (${printable(workspace.slug)}). Profile: ${profile}.`
}

/** What `amdahl login` suggests next: try Amdahl on a pasted message, or set up an AI tool. */
export function loginNextLine(): string {
  // Two lines, so it fits 80 columns.
  return `Next: run \`${amdahlCommand('optimize')}\` and paste an email,\nor \`${amdahlCommand()}\` to add Amdahl to Claude Code, Cursor or Codex.`
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
    `${signedInLine(ctx, signedIn)}\n${loginNextLine()}`
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
