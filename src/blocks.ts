// src/blocks.ts
//
// A research answer's `content_blocks`, as plain text for a terminal, in the
// order the job presented them (the answer's own order). A table is a plain
// ASCII table that fits 80 columns: a long cell wraps, a cell that would
// still run past four lines is cut with `...`, and a table with too many
// columns for 80 prints each row as `label: value` lines instead. No column
// is ever dropped without a mark. Text, callout, citation, metric and
// cluster_finding blocks print as plain text. A chart, and any block type
// this version does not know, prints one line that names it and points to
// `--json`, where the whole block is.

import { COLUMNS, count, field, paragraphs, plainMarkdown, record, records, wrap } from './text'

/** The block the server writes from the answer's own prose: printing it would say the answer twice. */
const SYNTHESIZED_ID = 'answer-text'

/** Most rows of a table printed; the rest are counted. */
export const MAX_TABLE_ROWS = 25
/** Most lines one cell takes before it is cut with `...`. */
const MAX_CELL_LINES = 4
/** Narrowest a column may be squeezed to before the table prints row by row. */
const MIN_COLUMN = 6

/** One table cell as a single line of text. */
function cell(value: unknown): string {
  if (typeof value === 'number') return String(value)
  return typeof value === 'string' ? field(value).replace(/\s+/g, ' ') : ''
}

/**
 * `text` as lines no wider than `width`. A word wider than `width` is split,
 * each piece but the last ending in `-`. Past `maxLines`, the last line ends
 * in `...`. Never empty: an empty cell is one empty line.
 */
export function wrapCell(text: string, width: number, maxLines = MAX_CELL_LINES): string[] {
  const lines: string[] = []
  let current = ''
  const push = () => {
    lines.push(current)
    current = ''
  }
  for (const word of text.split(' ').filter(Boolean)) {
    let rest = [...word]
    while (rest.length > width) {
      if (current) push()
      lines.push(`${rest.slice(0, width - 1).join('')}-`)
      rest = rest.slice(width - 1)
    }
    const piece = rest.join('')
    if (current && [...`${current} ${piece}`].length > width) push()
    current = current ? `${current} ${piece}` : piece
  }
  if (current || lines.length === 0) push()
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  // The last line keeps what fits beside the mark, so a cut is visible and the line still fits.
  kept[maxLines - 1] = `${[...(kept[maxLines - 1] ?? '')].slice(0, Math.max(width - 3, 0)).join('').trimEnd()}...`
  return kept
}

const pad = (s: string, width: number) => s + ' '.repeat(Math.max(0, width - [...s].length))

/**
 * A table as lines no wider than `width`: `| a | b |` rows under a header
 * rule. `rows` are already strings, one per column. A row is cut at
 * {@link MAX_TABLE_ROWS}, said in a last line. When the columns cannot each
 * keep {@link MIN_COLUMN} characters, every row prints as `label: value` lines.
 */
export function asciiTable(labels: string[], rows: string[][], width = COLUMNS): string[] {
  const shown = rows.slice(0, MAX_TABLE_ROWS)
  const more = rows.length - shown.length
  const tail = more > 0 ? [`... and ${count(more, 'more row')} (all of them: add --json).`] : []
  const n = labels.length
  const room = width - 1 - 3 * n
  const widths = labels.map((label, i) => Math.max([...label].length, ...shown.map((r) => [...(r[i] ?? '')].length), 1))
  // Narrow the widest column first. First down to its longest word, so a prose column wraps
  // and an id or a timestamp stays whole; only then, if 80 columns still do not hold it, down
  // to MIN_COLUMN, which splits a long word with a `-`.
  const longestWord = labels.map((label, i) =>
    Math.min(widths[i] ?? 1, Math.max(MIN_COLUMN, ...[label, ...shown.map((r) => r[i] ?? '')].flatMap((t) => t.split(' ')).map((w) => [...w].length)))
  )
  for (const floors of [longestWord, labels.map(() => MIN_COLUMN)]) {
    while (widths.reduce((a, b) => a + b, 0) > room) {
      const open = widths.map((w, i) => (w > (floors[i] ?? MIN_COLUMN) ? w : 0))
      const widest = open.indexOf(Math.max(...open))
      if ((open[widest] ?? 0) === 0) break
      widths[widest] = (widths[widest] ?? 0) - 1
    }
  }
  if (widths.reduce((a, b) => a + b, 0) > room) return [...rowByRow(labels, shown, width), ...tail]
  const line = (cells: string[]) => {
    const wrapped = cells.map((c, i) => wrapCell(c, widths[i] ?? 1))
    const height = Math.max(...wrapped.map((w) => w.length))
    return Array.from({ length: height }, (_, row) => `| ${wrapped.map((w, i) => pad(w[row] ?? '', widths[i] ?? 1)).join(' | ')} |`)
  }
  const rule = (fill: string) => `|${widths.map((w) => fill.repeat(w + 2)).join('|')}|`
  const body = shown.map((r) => line(labels.map((_, i) => r[i] ?? '')))
  // A row that wraps is set off from the next, so its lines read as one row.
  const spaced = body.some((b) => b.length > 1)
  const out = [...line(labels), rule('-')]
  body.forEach((b, i) => {
    out.push(...b)
    if (spaced && i < body.length - 1) out.push(rule('-'))
  })
  return [...out, ...tail]
}

/** Each row as a `Row n` heading and one `label: value` line per column, for a table too wide to draw. */
function rowByRow(labels: string[], rows: string[][], width: number): string[] {
  const out: string[] = []
  rows.forEach((row, i) => {
    if (i > 0) out.push('')
    out.push(`Row ${i + 1}:`)
    labels.forEach((label, j) => out.push(...wrap(`${label}: ${row[j] ?? ''}`, width, '  ')))
  })
  return out
}

/** A table block's or a cluster's own `columns` and `data`, as a table; [] when it has none. */
function dataTable(block: Record<string, unknown>): string[] {
  const columns = records(block.columns).filter((c) => field(c.key))
  const data = records(block.data)
  if (columns.length === 0 || data.length === 0) return []
  const labels = columns.map((c) => cell(c.label) || cell(c.key))
  return asciiTable(labels, data.map((row) => columns.map((c) => cell(row[field(c.key)]))))
}

/** Markdown from a block as plain prose: links to their words, and an `<unverified>` figure marked as one. */
function prose(markdown: unknown): string {
  return plainMarkdown(paragraphs(markdown).replace(/<\s*unverified\s*>([^<]*)<\s*\/\s*unverified\s*>/gi, '$1 (unverified)'))
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/** One block as lines; [] when there is nothing to say. `answer` is the answer's own text. */
function renderBlock(block: Record<string, unknown>, answer: string): string[] {
  const type = field(block.type)
  switch (type) {
    case 'text':
    case 'callout': {
      const text = prose(block.markdown)
      // The answer may be these very blocks, rendered: do not say it twice.
      if (!text || squash(answer).includes(squash(text))) return []
      return wrap(type === 'callout' && block.tone === 'warn' ? `Warning: ${text}` : text)
    }
    case 'table': {
      const title = field(block.title)
      const table = dataTable(block)
      return table.length === 0 ? [] : [...(title ? wrap(`${title}:`) : []), ...table]
    }
    case 'metric': {
      const data = record(block.data)
      const value = data?.value ?? block.value
      const delta = field(data?.delta ?? block.delta)
      const shown = value === undefined ? '' : cell(value)
      return wrap(`${field(block.label)}: ${shown}${delta ? ` (${delta})` : ''}`)
    }
    case 'citation': {
      const label = field(block.label) || (block.kind === 'url' ? field(block.ref) : 'Source')
      const snippet = field(block.snippet)
      return [...wrap(`- ${label}`), ...(snippet ? wrap(`"${snippet}"`, COLUMNS, '  ') : [])]
    }
    case 'cluster_finding': {
      const conversations = typeof block.conversations === 'number' ? count(block.conversations, 'conversation') : ''
      const where = field(block.period_label) ? ` in ${field(block.period_label)}` : ''
      const facts = [conversations ? `${conversations}${where}` : '', field(block.status)].filter(Boolean).join(', ')
      const insight = field(block.insight)
      return [...wrap(`${field(block.label)}${facts ? ` (${facts})` : ''}${insight ? `: ${insight}` : ''}`), ...dataTable(block)]
    }
    case 'chart_spec': {
      const rows = records(block.data).length
      const title = field(block.title)
      return wrap(`${title ? `"${title}", a` : 'A'} ${field(block.chart_type)} chart of ${count(rows, 'row')}, is not drawn here. Add --json for its data.`)
    }
    default:
      return wrap(`A "${type || 'unnamed'}" block is not shown here. Add --json to see it.`)
  }
}

/**
 * A research answer's `content_blocks` as lines, in the order the job
 * presented them, one blank line between blocks. Empty when there is nothing
 * to print. `answer` is the answer's own text, so a text block that is
 * already in it is not printed again.
 */
export function blockLines(blocks: unknown, answer: string): string[] {
  const parts = records(blocks)
    .filter((b) => field(b.id) !== SYNTHESIZED_ID)
    .map((b) => renderBlock(b, answer))
    .filter((lines) => lines.length > 0)
  return parts.flatMap((lines, i) => (i > 0 ? ['', ...lines] : lines))
}
