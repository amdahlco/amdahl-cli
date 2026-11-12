// src/commands/workspace-status.ts
//
// `status` (the server's setup.status read) and `workspace list|use` (local
// profiles only). Neither creates, joins or lists server workspaces: the CLI
// never calls the workspace or waitlist endpoints. Without `--json`, each
// blocked item names its fix: the command, the console page, when the quota
// resets, or who to ask.

import type { CliSetupStatus } from '../api'
import { amdahlCommand } from '../command-name'
import { apiClient, call, resolveCredential, type Ctx } from '../context'
import { EXIT, usageError } from '../errors'
import { consoleUrlFor } from '../oauth'
import { day } from '../text'
import { connectLine, connectionUrl, connectionsUrl } from './connections'

/** What to do about each optimize blocker. */
const BLOCKER_FIX: Record<string, (status: CliSetupStatus) => string> = {
  missing_scope: () => `This credential cannot optimize. Use a Customer agent key, or run \`${amdahlCommand('login')}\` again.`,
  role_too_low: () => 'Your role cannot optimize. Ask a workspace admin to raise it.',
  quota_exhausted: (status) => {
    const resets = day(status.optimize.quota?.resets_at)
    return `The monthly optimize quota is used up.${resets ? ` It resets on ${resets}.` : ''}`
  },
}

/**
 * Where to fix the connections that need attention: the one connection's
 * console page, or the Connections list for several. Without the workspace,
 * the command that lists them.
 */
function connectionFix(status: CliSetupStatus, consoleUrl: string): string {
  if (!('needs_attention' in status.connections)) return ''
  const attention = status.connections.needs_attention
  const [only] = attention
  if (!only) return ''
  const slug = status.workspace?.slug
  if (!slug) return `  See them: ${amdahlCommand('connections')}`
  if (attention.length > 1) return `  Fix them: ${connectionsUrl(consoleUrl, slug)}`
  const verb = only.status === 'needs_reauth' ? 'Sign in to it again' : 'Fix it'
  return `  ${verb}: ${connectionUrl(consoleUrl, slug, only.id)}`
}

/** Human summary of a setup status. */
function describe(status: CliSetupStatus, consoleUrl: string): string {
  const lines = [
    `Workspace:  ${status.workspace ? `${status.workspace.name} (${status.workspace.slug})` : 'unknown'}`,
    `You:        ${status.caller.email ?? status.caller.user_id} (${status.caller.role ?? 'unknown role'}, ${status.caller.auth_method})`,
  ]
  const opt = status.optimize
  lines.push(`Optimize:   ${opt.allowed ? 'ready' : `blocked (${opt.blocker})`}`)
  if (opt.quota) {
    lines.push(`Quota:      ${opt.quota.used} of ${opt.quota.limit} used, resets ${opt.quota.resets_at}`)
  }
  const fix = opt.blocker ? BLOCKER_FIX[opt.blocker] : undefined
  if (!opt.allowed && fix) {
    lines.push(`            ${fix(status)}`)
  }
  const conns = status.connections
  if ('omitted' in conns) {
    lines.push(
      conns.omitted === 'missing_scope'
        ? 'Connections: not visible to this credential'
        : 'Connections: could not be read right now'
    )
  } else {
    lines.push(`Connections: ${conns.healthy} of ${conns.total} healthy`)
    if (conns.total === 0) lines.push(`  No data connected yet. ${connectLine()}`)
    for (const c of conns.needs_attention) {
      lines.push(`  needs attention: ${c.name} (${c.connector_type}): ${c.status}`)
    }
    const fixLine = connectionFix(status, consoleUrl)
    if (fixLine) lines.push(fixLine)
  }
  return lines.join('\n')
}

/** `amdahl status`. */
export async function status(ctx: Ctx): Promise<number> {
  const credential = await resolveCredential(ctx)
  const body = await call(() => apiClient(ctx, credential).cli.setupStatus())
  ctx.out.result({ ok: true, source: credential.source, ...body }, describe(body, consoleUrlFor(ctx.io, ctx.apiUrl)))
  return EXIT.ok
}

/** `amdahl workspace list`: the saved profiles. */
export async function workspaceList(ctx: Ctx): Promise<number> {
  const { config } = ctx
  const profiles = Object.entries(config.profiles).map(([name, p]) => ({
    name,
    workspace: p.workspace,
    email: p.email,
    api_url: p.api_url,
  }))
  const human =
    profiles.length === 0
      ? `No profiles. Run \`${amdahlCommand('login')}\`.`
      : profiles
          .map(
            (p) =>
              `${p.name === config.default_profile ? '*' : ' '} ${p.name}  ${p.workspace.name}  ${p.email ?? ''}  ${p.api_url}`
          )
          .join('\n')
  ctx.out.result({ ok: true, default: config.default_profile, profiles }, human)
  return EXIT.ok
}

/** `amdahl workspace use <profile>`: make a saved profile the default. */
export async function workspaceUse(ctx: Ctx, args: string[]): Promise<number> {
  const name = args[0]
  if (!name || args.length > 1) throw usageError('Usage: amdahl workspace use <profile>')
  if (!ctx.config.profiles[name]) {
    throw usageError(`No profile named "${name}".`, `Run \`${amdahlCommand('workspace list')}\` to see your profiles.`)
  }
  ctx.config.default_profile = name
  ctx.saveConfig()
  ctx.out.result({ ok: true, default: name }, `Default profile: ${name}`)
  return EXIT.ok
}
