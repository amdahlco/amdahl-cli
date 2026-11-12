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

/** An ISO timestamp as its day (`2026-11-12`), or '' when it does not parse. */
export function day(iso: unknown): string {
  if (typeof iso !== 'string') return ''
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : ''
}

/** `1 row`, `2 rows`. */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}
