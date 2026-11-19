// src/commands/sequence-leads-match.ts
//
// `amdahl sequence <emails> --leads <list.csv>`: "Match your fields". Each
// fill-in field of the emails ({{first_name}}) is filled from a column of the
// list, with text for the people whose cell is empty; or has the same text for
// everyone; or is left out. The flags --match, --fallback, --same and --drop
// say it; at a terminal, a field with a real problem is asked about; anywhere
// else a field with no column and no flag is refused before anything is sent.
// The console's "Match your fields" does the same (see sequence-fields.ts).

import { basename } from 'node:path'
import { usageError } from '../errors'
import type { Lead } from '../lead-people'
import { columnFor, emptyFor, fieldOf, needsLook, startText, unmatched, type FieldMatch } from '../sequence-fields'
import { norm } from '../send-to'
import { shellWord } from './batch'
import type { Ctx } from '../context'

/** A repeatable flag's values, in order. */
export function listFlag(ctx: Ctx, name: string): string[] {
  const value = ctx.flags[name] as unknown
  if (value === undefined || value === true || value === false) return []
  return (Array.isArray(value) ? value : [value]).map(String)
}

/** `{{first_name}}` for a field named as it was typed. */
const tokenOf = (name: string) => (/^[{[%]/.test(name) ? name : `{{${name}}}`)

/** A field's name as the emails write it, without the braces: `first_name`. */
const nameOf = (m: FieldMatch) => m.token.replace(/^\{\{|\}\}$|^[{[%]|[}\]%]$/g, '')

/** `name=value` split at the first `=`, or a usage error that shows the shape. */
function pair(flag: string, raw: string, shape: string): [string, string] {
  const at = raw.indexOf('=')
  if (at < 1) throw usageError(`--${flag} takes ${shape}, like --${flag} ${shape.replace('<field>', 'first_name').replace('<column>', '"First Name"').replace('<text>', 'there')}.`)
  return [raw.slice(0, at).trim(), raw.slice(at + 1)]
}

/** The field a flag names, or a usage error that lists the fields the emails have. */
function fieldFor(matches: FieldMatch[], flag: string, name: string): FieldMatch {
  const key = fieldOf(name).key
  const found = matches.find((m) => m.key === key)
  if (found) return found
  const have = matches.map((m) => m.token)
  throw usageError(`--${flag} ${name}: ${tokenOf(name)} is not in your emails.`, have.length ? `The fields in your emails: ${have.join(', ')}.` : 'Your emails have no fill-in fields, so there is nothing to match.')
}

/** The list column a flag names: its header as written, or in any case and spelling. */
function columnNamed(flag: string, field: string, name: string, headers: string[], listFile: string): number {
  const typed = name.trim()
  const at = headers.findIndex((h) => h.trim() === typed)
  const loose = at >= 0 ? at : headers.findIndex((h) => norm(h) === norm(typed) && norm(typed) !== '')
  if (loose >= 0) return loose
  throw usageError(`--${flag} ${field}: ${listFile} has no column "${typed}".`, `The columns: ${headers.filter(Boolean).join(', ')}.`)
}

/**
 * Apply the flags to the matches. Returns the fields they settled, so the
 * terminal does not ask about them again. A flag that names a field that is
 * not in the emails, or a column that is not in the list, is refused.
 */
export function applyMatchFlags(ctx: Ctx, matches: FieldMatch[], headers: string[], listFile: string): Set<string> {
  const settled = new Set<string>()
  const used = new Map<string, Set<string>>()
  const claim = (m: FieldMatch, flag: string) => {
    const had = used.get(m.key) ?? new Set<string>()
    const clash = [...had].find((f) => f !== flag && (flag === 'same' || flag === 'drop' || f === 'same' || f === 'drop'))
    if (clash) throw usageError(`${m.token} has --${clash} and --${flag}. Pick one.`)
    used.set(m.key, had.add(flag))
    settled.add(m.key)
  }
  for (const raw of listFlag(ctx, 'match')) {
    const [name, column] = pair('match', raw, '<field>=<column>')
    const m = fieldFor(matches, 'match', name)
    claim(m, 'match')
    m.use = 'column'
    m.column = columnNamed('match', name, column, headers, listFile)
  }
  for (const raw of listFlag(ctx, 'fallback')) {
    const [name, text] = pair('fallback', raw, '<field>=<text>')
    const m = fieldFor(matches, 'fallback', name)
    if (!text.trim()) throw usageError(`--fallback ${name}: give the text for the people whose cell is empty.`)
    claim(m, 'fallback')
    m.text = text.trim()
  }
  for (const raw of listFlag(ctx, 'same')) {
    const [name, text] = pair('same', raw, '<field>=<text>')
    const m = fieldFor(matches, 'same', name)
    if (!text.trim()) throw usageError(`--same ${name}: give the text that goes in for everyone.`)
    claim(m, 'same')
    m.use = 'same'
    m.text = text.trim()
  }
  for (const name of listFlag(ctx, 'drop')) {
    const m = fieldFor(matches, 'drop', name)
    claim(m, 'drop')
    m.use = 'left'
  }
  return settled
}

/** One line for each field with no column and no flag, each with the flags that fix it. For a refusal; empty when every field is matched. */
export function unmatchedLines(matches: FieldMatch[], listFile: string): string[] {
  return matches.filter(unmatched).map((m) => {
    const name = nameOf(m)
    return `${m.token} has no column in ${listFile}. Add --match ${name}=<column>, --same ${name}="<text>" or --drop ${name}.`
  })
}

/** How a field is filled, as one line. */
export function howLine(m: FieldMatch, headers: string[]): string {
  if (m.use === 'left') return `${m.token}: left out.`
  if (m.use === 'same') return `${m.token}: "${m.text}" for everyone.`
  const from = `from column "${(headers[m.column] ?? '').trim()}"`
  return m.text ? `${m.token}: ${from}, "${m.text}" where it is empty.` : `${m.token}: ${from}.`
}

/** The line for a field whose empty cells have no text to fill them: how many people have it empty. Null when none does or there is text. */
export function emptyLine(m: FieldMatch, leads: readonly Lead[]): string | null {
  const n = emptyFor(m, leads)
  if (n === 0 || m.text) return null
  return `${m.token} is empty for ${n} of ${leads.length} people, so it is left out for them.`
}

const SAME = 'Same text for everyone'
const LEAVE = 'Leave it out'

/** Ask what fills one field. */
async function askField(ctx: Ctx, m: FieldMatch, headers: string[], leads: readonly Lead[], listFile: string): Promise<void> {
  const { io, out } = ctx
  const empty = emptyFor(m, leads)
  const write = `Write instead: ${m.text || 'you type it'}`
  const columns = headers.map((h, i) => ({ h: h.trim(), i })).filter((c) => c.h && !(empty > 0 && c.i === m.column))
  const choices = [...(empty > 0 ? [write] : []), ...columns.map((c) => `Column: ${c.h}`), SAME, LEAVE]
  out.info(empty > 0 ? `${m.token}: empty for ${empty} of ${leads.length} people` : `${m.token}: no column in ${listFile}`)
  const initial = empty > 0 ? 0 : columns.length
  const pick = await io.select(`What fills ${m.token}?`, choices, { initial })
  const label = choices[pick] ?? ''
  if (label === write) {
    if (!m.text) m.text = (await io.prompt(`Text for the people with no ${m.token}:`)).trim()
  } else if (label === SAME) {
    const text = (await io.prompt(`Text that goes in ${m.token} for everyone:`)).trim()
    m.use = text ? 'same' : 'left'
    m.text = text
  } else if (label === LEAVE) {
    m.use = 'left'
  } else {
    const column = columns[pick - (empty > 0 ? 1 : 0)]
    if (column) {
      m.use = 'column'
      m.column = column.i
    }
  }
}

/**
 * Settle every field: the flags first, then, at a terminal, the questions for
 * a real problem (a field with no column, or a column empty for some people)
 * the flags did not settle. Anywhere else, a field with no column and no flag
 * is refused (exit 2), all of them in one message. Returns the lines to show.
 */
export async function settleFields(ctx: Ctx, matches: FieldMatch[], headers: string[], leads: readonly Lead[], listPath: string, ask: boolean): Promise<string[]> {
  const listFile = basename(listPath)
  const settled = applyMatchFlags(ctx, matches, headers, listFile)
  const lines: string[] = []
  const open = matches.filter((m) => !settled.has(m.key))
  if (ask && needsLook(open, leads)) {
    for (const m of open) if (unmatched(m) || emptyFor(m, leads) > 0) await askField(ctx, m, headers, leads, listFile)
    lines.push(...matches.map((m) => howLine(m, headers)))
  }
  const missing = unmatchedLines(matches, listFile)
  if (missing.length) throw usageError(missing.join('\n'))
  for (const m of matches) {
    const line = emptyLine(m, leads)
    if (line) lines.push(line)
  }
  return lines
}

/** The flags that say how the fields are filled, for a command that picks up the run: only what differs from the start. */
export function matchFlagWords(matches: readonly FieldMatch[], headers: string[]): string[] {
  const out: string[] = []
  for (const m of matches) {
    const name = nameOf(m)
    if (m.use === 'left') out.push('--drop', shellWord(name))
    else if (m.use === 'same') out.push('--same', shellWord(`${name}=${m.text}`))
    else {
      if (m.column >= 0 && m.column !== columnFor(m.key, headers)) out.push('--match', shellWord(`${name}=${(headers[m.column] ?? '').trim()}`))
      if (m.text && m.text !== startText(m.key)) out.push('--fallback', shellWord(`${name}=${m.text}`))
    }
  }
  return out
}
