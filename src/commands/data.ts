// src/commands/data.ts
//
// `amdahl data`: what this workspace holds, and what a search can filter on.
// GET /api/platform/v1/search/overview gives each queryable surface's live row
// count and the span of its time field; GET /search/fields gives each
// surface's filterable fields. A count that could not be read is null on the
// wire and "unknown" here, never 0: an outage must not read as an empty
// workspace.
//
// Every line fits 80 columns. The fields are the longest part (the interactions
// surface has dozens), so the plain view lists the names, and `--surface <name>`
// lists one surface's fields with their type, meaning and known values.

import { amdahlCommand } from '../command-name'
import { apiClient, call, resolveCredential, str, type Ctx } from '../context'
import { EXIT, usageError } from '../errors'
import { count, day, field, firstSentence, records, wrap } from '../text'
import { connectLine } from './connections'

const PLATFORM = '/api/platform/v1'

/** The surfaces a search reads, as the server names them, with what each holds. */
const SURFACES: Record<string, string> = {
  interactions: 'Conversations',
  deals: 'CRM deals',
  deal_qualification: 'Deal qualification',
}

/** A number with thousands separators: `12,431`. */
function grouped(n: number): string {
  return n.toLocaleString('en-US')
}

/** One surface's line of the overview. */
function overviewLine(row: Record<string, unknown>, labelWidth: number, columns: number): string[] {
  const surface = field(row.surface)
  const label = (SURFACES[surface] ?? surface).padEnd(labelWidth)
  const rows = typeof row.row_count === 'number' ? row.row_count : null
  const size = rows === null ? 'unknown (could not be read)' : count(rows, 'row').replace(/^\d+/, grouped(rows))
  const from = day(row.earliest_at)
  const to = day(row.latest_at)
  const span = from && to ? `, ${from} to ${to}` : ''
  const by = span && field(row.time_field) ? ` by ${field(row.time_field)}` : ''
  const whole = `  ${label}  ${size}${span}${by}`
  // A narrow terminal: the size on one line, the span under it, rather than a line cut at the edge.
  if ([...whole].length <= columns) return [whole]
  return [`  ${label}  ${size}`, ...wrap(`${span.replace(/^, /, '')}${by}`, columns, '    ').filter(Boolean)]
}

/** The overview as lines: what the workspace holds, one line a surface. */
export function overviewLines(overview: Record<string, unknown>, columns = 80): string[] {
  const rows = records(overview.surfaces)
  const width = Math.max(0, ...rows.map((r) => (SURFACES[field(r.surface)] ?? field(r.surface)).length))
  const lines = ['What this workspace holds:', ...rows.flatMap((r) => overviewLine(r, width, columns))]
  const known = rows.filter((r) => typeof r.row_count === 'number')
  if (known.length > 0 && known.every((r) => r.row_count === 0)) lines.push('', 'Nothing has synced yet.', ...wrap(connectLine(), columns))
  return lines
}

/** The plain view of the fields: each surface's names, wrapped. */
function fieldNames(surfaces: Record<string, unknown>[], width: number): string[] {
  const lines: string[] = []
  for (const surface of surfaces) {
    const name = field(surface.surface)
    const fields = records(surface.fields)
    lines.push('', `${SURFACES[name] ?? name}: ${count(fields.length, 'field')} to filter on (${name})`)
    lines.push(...wrap(fields.map((f) => field(f.name)).filter(Boolean).join(', '), width, '  '))
  }
  lines.push('', ...wrap(`One surface's fields, with type and meaning: ${amdahlCommand('data --surface deals')}`, width))
  return lines
}

/** One surface's fields: name and type, what it means, and its known values. */
function fieldDetails(surfaces: Record<string, unknown>[], width: number): string[] {
  const lines: string[] = []
  for (const surface of surfaces) {
    const name = field(surface.surface)
    const fields = records(surface.fields)
    lines.push('', `${SURFACES[name] ?? name}: ${count(fields.length, 'field')} to filter on (${name})`)
    for (const f of fields) {
      lines.push(`  ${field(f.name)} (${field(f.type)})`)
      const about = field(f.description)
      if (about) lines.push(...wrap(firstSentence(about, 2 * width), width, '      '))
      const values = (Array.isArray(f.sample_values) ? f.sample_values : []).map(field).filter(Boolean)
      if (values.length > 0) lines.push(...wrap(`Values: ${values.join(', ')}`, width, '      '))
    }
  }
  return lines
}

/** `amdahl data [--surface interactions|deals|deal_qualification]`. */
export async function data(ctx: Ctx): Promise<number> {
  const { out } = ctx
  const surface = str(ctx.flags.surface)
  if (surface !== undefined && !(surface in SURFACES)) throw usageError(`--surface must be one of: ${Object.keys(SURFACES).join(', ')}.`)
  const credential = await resolveCredential(ctx)
  const client = apiClient(ctx, credential)
  const [overview, fields] = await call(() =>
    Promise.all([
      client.request<Record<string, unknown>>(`${PLATFORM}/search/overview`),
      client.request<Record<string, unknown>>(`${PLATFORM}/search/fields${surface ? `?surface=${encodeURIComponent(surface)}` : ''}`),
    ])
  )
  if (out.json) {
    out.result({ ok: true, overview, fields })
    return EXIT.ok
  }
  // The terminal's width when it is narrower than 80, never wider; a pipe or an unknown width is 80.
  const width = Math.max(40, Math.min(ctx.io.columns() ?? 80, 80))
  const surfaces = records(fields.surfaces)
  const shownOverview = surface ? { ...overview, surfaces: records(overview.surfaces).filter((r) => field(r.surface) === surface) } : overview
  out.result({}, [...overviewLines(shownOverview, width), ...(surface ? fieldDetails(surfaces, width) : fieldNames(surfaces, width))].join('\n'))
  return EXIT.ok
}
