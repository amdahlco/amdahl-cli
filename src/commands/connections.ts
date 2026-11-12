// src/commands/connections.ts
//
// `amdahl connections`, `amdahl connect [<connector>]` and `amdahl open`.
//
// `connections` lists what the workspace has connected (GET /connections),
// with each one's health and last sync. `connect` checks the connector
// against the catalog (GET /connections/catalog), then opens the console's
// add page for it: `<console>/<slug>/settings/connections?add=1&connector=<type>`.
// The CLI never creates a connection itself: a sign-in has no
// `connections:write`, and a CRM's own sign-in happens in the browser
// anyway. `open` opens the workspace in the console. With `--no-browser`,
// or when the browser does not open, both print the link instead.

import { amdahlCommand } from '../command-name'
import { apiClient, call, resolveCredential, type Credential, type Ctx } from '../context'
import { CliError, EXIT, usageError } from '../errors'
import { consoleUrlFor } from '../oauth'
import { clip, day, field, record, records, wrap } from '../text'

const PLATFORM = '/api/platform/v1'

/** The line that teaches connecting data, wherever a workspace has none. */
export function connectLine(): string {
  return `Connect your CRM or call recorder: ${amdahlCommand('connect')}`
}

/** Each health word, said plainly. An unknown word prints as the server sent it. */
const HEALTH: Record<string, string> = {
  healthy: 'healthy',
  syncing: 'syncing now',
  stale: 'not synced lately',
  degraded: 'partly failing',
  needs_reauth: 'needs sign-in',
  rate_limited: 'rate limited',
  error: 'failing',
  paused: 'paused',
  disconnected: 'disconnected',
}

/** Health words (or, from an older server, status words) that need nothing from the person. */
const FINE = new Set(['healthy', 'syncing', 'connected', 'pending'])

/** A connection's health word, or its status from a server that sends no health. */
function healthOf(c: Record<string, unknown>): string {
  return field(c.health) || field(c.status)
}

/** The console page of one connection. */
export function connectionUrl(consoleUrl: string, slug: string, id: string): string {
  return `${consoleUrl}/${encodeURIComponent(slug)}/connections/${encodeURIComponent(id)}`
}

/** The console's Connections list. */
export function connectionsUrl(consoleUrl: string, slug: string): string {
  return `${consoleUrl}/${encodeURIComponent(slug)}/settings/connections`
}

/** The console's add page, opened on one connector when given. */
export function connectUrl(consoleUrl: string, slug: string, connector?: string): string {
  const query = new URLSearchParams({ add: '1' })
  if (connector) query.set('connector', connector)
  return `${connectionsUrl(consoleUrl, slug)}?${query}`
}

/**
 * The workspace slug for this credential: the stored sign-in knows it with no
 * request; a key asks who it is.
 */
export async function workspaceSlug(ctx: Ctx, credential: Credential): Promise<string> {
  if (credential.source === 'profile' && ctx.profile?.workspace.slug) return ctx.profile.workspace.slug
  const me = await call(() => apiClient(ctx, credential).cli.whoami())
  const slug = me.workspace?.slug
  if (!slug) throw new CliError('no_workspace_slug', 'Amdahl could not say which workspace this credential belongs to.', EXIT.general)
  return slug
}

/**
 * Open `url` in the browser, unless `--no-browser`. Returns whether it opened;
 * the caller prints the link when it did not.
 */
async function openOrPrint(ctx: Ctx, url: string): Promise<boolean> {
  if (ctx.flags['no-browser'] === true) return false
  ctx.out.event({ event: 'open_url', url })
  return ctx.io.openUrl(url)
}

/** `amdahl open`: this workspace in the console (the console home when not signed in). */
export async function open(ctx: Ctx): Promise<number> {
  const consoleUrl = consoleUrlFor(ctx.io, ctx.apiUrl)
  let credential: Credential | null = null
  try {
    credential = await resolveCredential(ctx)
  } catch (err) {
    if (!(err instanceof CliError && err.exit === EXIT.unauthenticated)) throw err
  }
  const slug = credential ? await workspaceSlug(ctx, credential) : null
  const url = slug ? `${consoleUrl}/${encodeURIComponent(slug)}` : consoleUrl
  const opened = await openOrPrint(ctx, url)
  const what = slug ? 'your workspace' : 'the console (sign in there)'
  if (ctx.out.json) {
    ctx.out.result({ ok: true, url, opened, workspace: slug })
    return EXIT.ok
  }
  if (opened) ctx.out.info(`Opened ${what} in your browser.`)
  else ctx.out.result({}, url)
  return EXIT.ok
}

/** One catalog entry, as far as `connect` reads it. */
interface CatalogEntry {
  type: string
  name: string
  category: string
  connectable: boolean
  reason: string
}

function catalogEntries(body: unknown): CatalogEntry[] {
  const rows = Array.isArray(body) ? body : records(record(body)?.connectors ?? record(body)?.items)
  return records(rows).map((c) => ({
    type: field(c.type),
    name: field(c.name) || field(c.type),
    category: field(c.category),
    // An older catalog has no flag: everything it lists is connectable.
    connectable: c.connectable !== false,
    reason: field(c.unavailable_reason ?? c.reason),
  }))
}

/** The connector a person named: its type or its name, in any case. */
function findConnector(entries: CatalogEntry[], wanted: string): CatalogEntry | undefined {
  const key = wanted.toLowerCase().replace(/[\s-]+/g, '_')
  return entries.find((e) => e.type.toLowerCase() === key || e.name.toLowerCase().replace(/[\s-]+/g, '_') === key)
}

/** `amdahl connect [<connector>]`. */
export async function connect(ctx: Ctx, args: string[]): Promise<number> {
  if (args.length > 1) throw usageError('Name one connector at a time.', `Usage: ${amdahlCommand('connect [<connector>] [--no-browser]')}`)
  const wanted = args[0]
  const credential = await resolveCredential(ctx)
  const client = apiClient(ctx, credential)
  let entry: CatalogEntry | undefined
  if (wanted) {
    const entries = catalogEntries(await call(() => client.request<unknown>(`${PLATFORM}/connections/catalog`)))
    entry = findConnector(entries, wanted)
    if (!entry) {
      const names = entries.filter((e) => e.connectable).map((e) => e.type)
      throw usageError(`Amdahl has no connector called "${clip(wanted, 40)}".`, names.length ? wrap(`Connectors: ${names.join(', ')}`).join('\n') : undefined)
    }
    if (!entry.connectable) {
      throw new CliError('connector_unavailable', `${entry.name} can't be connected yet${entry.reason === 'planned' ? ': it is coming soon' : ''}.`, EXIT.general, `To see what you can connect: ${amdahlCommand('connect')}`)
    }
  }
  const slug = await workspaceSlug(ctx, credential)
  const url = connectUrl(consoleUrlFor(ctx.io, ctx.apiUrl), slug, entry?.type)
  const opened = await openOrPrint(ctx, url)
  if (ctx.out.json) {
    ctx.out.result({ ok: true, url, opened, connector: entry?.type ?? null })
    return EXIT.ok
  }
  const what = entry ? entry.name : 'a source'
  if (opened) {
    ctx.out.info(`Opened the console to connect ${what}. Finish there; then check it with \`${amdahlCommand('connections')}\`.`)
    return EXIT.ok
  }
  ctx.out.info(`Open this link to connect ${what}:`)
  ctx.out.result({}, url)
  return EXIT.ok
}

/** One connection's row in the human list. */
function connectionRow(c: Record<string, unknown>): { name: string; kind: string; health: string; synced: string } {
  const connector = record(c.connector)
  const type = field(connector?.name) || field(c.connector_type)
  const label = field(c.name)
  const name = label && label !== type ? `${type} (${label})` : type || label
  const health = healthOf(c)
  const synced = day(c.last_synced_at)
  return {
    name: clip(name, 32),
    kind: field(connector?.category),
    health: HEALTH[health] ?? health,
    synced: synced ? `synced ${synced}` : 'never synced',
  }
}

/** `amdahl connections [--all]`. */
export async function connections(ctx: Ctx): Promise<number> {
  const credential = await resolveCredential(ctx)
  const client = apiClient(ctx, credential)
  const query = ctx.flags.all === true ? '?include_inactive=true' : ''
  const body = await call(() => client.request<unknown>(`${PLATFORM}/connections${query}`))
  const list = records(Array.isArray(body) ? body : record(body)?.connections)
  if (ctx.out.json) {
    ctx.out.result({ ok: true, connections: list })
    return EXIT.ok
  }
  if (list.length === 0) {
    ctx.out.result({}, `No data connected yet.\n${connectLine()}`)
    return EXIT.ok
  }
  const rows = list.map(connectionRow)
  const width = (key: 'name' | 'kind' | 'health') => Math.max(...rows.map((r) => [...r[key]].length))
  const [w1, w2, w3] = [width('name'), width('kind'), width('health')]
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - [...s].length))
  const lines = rows.map((r) => `${pad(r.name, w1)}  ${pad(r.kind, w2)}  ${pad(r.health, w3)}  ${r.synced}`.trimEnd())
  const attention = list.filter((c) => !FINE.has(healthOf(c)))
  const fix = await fixLine(ctx, credential, attention)
  ctx.out.result({}, [...lines, ...(fix ? [fix] : [])].join('\n'))
  return EXIT.ok
}

/**
 * One line that says where to fix the connections that need attention: the
 * one connection's console page, or the Connections list for several. Empty
 * when none does.
 */
export async function fixLine(ctx: Ctx, credential: Credential, attention: Record<string, unknown>[], slug?: string): Promise<string> {
  if (attention.length === 0) return ''
  const consoleUrl = consoleUrlFor(ctx.io, ctx.apiUrl)
  const ws = slug ?? (await workspaceSlug(ctx, credential).catch(() => ''))
  if (!ws) return ''
  const [only] = attention
  if (attention.length === 1 && only && field(only.id)) {
    const verb = healthOf(only) === 'needs_reauth' ? 'Sign in to it again' : 'Fix it'
    return `${verb}: ${connectionUrl(consoleUrl, ws, field(only.id))}`
  }
  return `Fix them: ${connectionsUrl(consoleUrl, ws)}`
}
