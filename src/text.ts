// src/text.ts
//
// Text for a person's terminal: server strings made safe to print, prose
// wrapped to 80 columns, markdown links said plainly, and dates as days.
// Every helper is pure, so the commands that print server answers (search,
// connections, the batch summary) render the same way.

import { printable } from './output'

/** The width human output is laid out for. */
export const COLUMNS = 80

/** A string field from the network, printable and trimmed; '' for anything else. */
export function field(value: unknown): string {
  return typeof value === 'string' ? printable(value).trim() : ''
}

/**
 * A string field from the network that is prose: its line breaks stay (a
 * research answer has paragraphs and lists), every other control character
 * goes, and a run of blank lines becomes one.
 */
export function paragraphs(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => printable(line).trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A plain object, or null. */
export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** The objects in an array, or [] for anything else. */
export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!record(v)) : []
}

/**
 * Markdown links in plain words: an `amdahl:` citation link keeps only its
 * words (a bare footnote number, `[1]`, goes), any other link becomes
 * `words (url)`. Bold and italic markers go.
 */
export function plainMarkdown(text: string): string {
  return text
    .replace(/\s*\[\d+\]\(amdahl:[^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\(amdahl:[^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_, words: string, url: string) => (words === url ? url : `${words} (${url})`))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, '$1$2')
}

/**
 * `text` broken at spaces so no line is longer than `width`. Line breaks in
 * the text are kept; each line after a break starts with `indent`, as does
 * every wrapped line. A word longer than the width stays whole.
 */
export function wrap(text: string, width = COLUMNS, indent = ''): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    // Keep a list item's marker in front, and its wrapped lines under its text.
    const lead = /^\s*(?:[-*]|\d+\.)\s+/.exec(paragraph)?.[0] ?? ''
    const hang = indent + ' '.repeat(lead.length)
    let current = indent + lead
    let words = 0
    for (const word of paragraph.slice(lead.length).split(' ').filter(Boolean)) {
      if (words > 0 && [...`${current} ${word}`].length > width) {
        lines.push(current)
        current = hang + word
      } else current = words > 0 ? `${current} ${word}` : current + word
      words++
    }
    lines.push(words > 0 || lead ? current : '')
  }
  return lines
}

/** `text` cut to `max` characters, with an ellipsis when cut. */
export function clip(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()]
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 3).join('')}...`
}

/**
 * The first sentence of `text`, whole words only: up to the first `. `, `? ` or
 * `! ` (or the end), and when that is longer than `max`, cut at a word with an
 * ellipsis, never in the middle of one.
 */
export function firstSentence(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  for (const m of flat.matchAll(/[.!?](?=\s|$)/g)) {
    const head = flat.slice(0, m.index + 1)
    // A full stop after e.g. / i.e. / vs. / etc. does not end a sentence, nor does one inside an open bracket.
    if (ABBREVIATION.test(head) || openBrackets(head) > 0) continue
    return fit(head, max)
  }
  return fit(flat, max)
}

/** `sentence` within `max`: whole when it fits, else cut at its last `;` or ` - ` clause past halfway, else at a word. */
function fit(sentence: string, max: number): string {
  if ([...sentence].length <= max) return sentence
  const room = sentence.slice(0, max - 3)
  const clause = Math.max(room.lastIndexOf('; '), room.lastIndexOf(' - '))
  if (clause > max / 2 && openBrackets(room.slice(0, clause)) === 0) return `${room.slice(0, clause)}...`
  return cutAtWord(sentence, max)
}

/** A word that ends in a full stop without ending a sentence. */
const ABBREVIATION = /(?:^|[\s(\[])(?:e\.g|i\.e|vs|etc|approx|incl|inc|ltd|co|corp|cf|esp|ca|no|nos|fig|st|mr|mrs|ms|dr)\.$/i

/** Where the first bracket `text` opens and does not close is, or -1: `(a (b) c` is open at 0, though `(b)` closed. */
function firstOpenBracket(text: string): number {
  const open: number[] = []
  let i = 0
  for (const ch of text) {
    if (ch === '(' || ch === '[') open.push(i)
    else if ((ch === ')' || ch === ']') && open.length > 0) open.pop()
    i += ch.length
  }
  return open.length > 0 ? open[0]! : -1
}

/** How many brackets `text` opens and does not close. */
function openBrackets(text: string): number {
  return firstOpenBracket(text) === -1 ? 0 : 1
}

/** `text` on one line, cut to `max` characters at a word (never inside one), with an ellipsis when cut. */
export function cutAtWord(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if ([...flat].length <= max) return flat
  let cut = [...flat].slice(0, max - 3).join('')
  const space = cut.lastIndexOf(' ')
  cut = space > 0 ? cut.slice(0, space) : cut
  // Not inside an open bracket: cut back to before the first one still open (a closed `(Signed)` inside it does not count).
  const open = firstOpenBracket(cut)
  if (open > 0) cut = cut.slice(0, open)
  return `${cut.replace(/[\s,;:]+$/, '')}...`
}

/** An ISO timestamp as its day (`2026-11-12`), or '' when it does not parse. */
export function day(iso: unknown): string {
  if (typeof iso !== 'string') return ''
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : ''
}

/** True when a context (as sent) holds at least one fact or rule. */
export function hasFactsOrRules(context: unknown): boolean {
  const c = record(context)
  const some = (list: unknown) => Array.isArray(list) && list.some((entry) => (typeof entry === 'string' ? entry.trim() !== '' : !!record(entry)))
  return !!c && (some(c.facts) || some(c.rules))
}

/**
 * The run's one-line summary, when it is true of this run. The summary says the
 * message was checked "against your facts and rules": a run that was sent
 * neither has nothing of the sender's to have been checked against, so that
 * line is dropped (an empty string) rather than printed.
 */
export function truthfulSummary(summary: string, context: unknown): string {
  return /facts and rules/i.test(summary) && !hasFactsOrRules(context) ? '' : summary
}

/** `1 row`, `2 rows`. */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}
