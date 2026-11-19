// src/changes.ts
//
// "What Amdahl changed": the server's own reason for each sentence it cut,
// added or reworded, from the `changes` rows of an optimize result, a stored
// run or an improved prompt run, said in plain words. Nothing here is made up:
// every line is a row the API returned, or a source quote from `added_claims`.
// A result with no `changes` (an older server, a grade) has no lines and no
// cell, so the surfaces that print them print what they printed before. The
// text of a run is shown to the person who made it and is never stored.

import { COLUMNS, cutAtWord, field, record, records, wrap } from './text'

/** The header over the rows of an optimize result. */
export const CHANGES_HEADER = 'What Amdahl changed:'

/** The header over the rows of an improved prompt run. */
export const PROMPT_CHANGES_HEADER = 'What changed in your prompt:'

/** A source quote is cut to about this many characters. */
const SOURCE_CHARS = 100

/** One usable row: a cut (no `after`), an added sentence (no `before`) or a reworded one. */
interface Change {
  before: string
  after: string
  cut: string
  added: string
  why: string
}

/** A reason as a sentence: as the server sent it, with a full stop when it has no end mark. */
function reason(value: unknown): string {
  const text = field(value)
  return text && !/[.!?]$/.test(text) ? `${text}.` : text
}

/** The rows of `result.changes` worth showing, in the order the server sent them. */
function rows(result: Record<string, unknown>): Change[] {
  return records(result.changes)
    .map((row) => ({
      before: field(row.before),
      after: field(row.after),
      cut: reason(row.why_cut),
      added: reason(row.why_added),
      why: reason(row.why),
    }))
    .filter((row) => (row.before || row.after) && row.before !== row.after)
}

/** Whether `result` carries any row to show. */
export function hasChanges(result: unknown): boolean {
  const r = record(result)
  return r !== null && rows(r).length > 0
}

/** A tag is shown only when it is one short plain word, such as `call`. */
function plainTag(value: unknown): string {
  const tag = field(value)
  return /^[A-Za-z][A-Za-z-]{0,19}$/.test(tag) ? tag : ''
}

/**
 * The line a new sentence rests on: the first `added_claims` entry whose
 * sentence and `after` contain one another, its first source's text cut at a
 * word, then `(+N more)` when it has other sources (`verbose` lists each of
 * them instead). Empty when none matches.
 */
function sourceTexts(result: Record<string, unknown>, after: string, verbose: boolean): string[] {
  const claim = records(result.added_claims).find((c) => {
    const sentence = field(c.sentence)
    return sentence !== '' && (sentence.includes(after) || after.includes(sentence))
  })
  const sources = records(claim?.sources)
  const quote = (source: Record<string, unknown> | undefined) => {
    const text = field(source?.text)
    if (!source || !text) return ''
    const tag = plainTag(source.tag)
    return `"${cutAtWord(text, SOURCE_CHARS)}"${tag ? ` (${tag})` : ''}`
  }
  const first = quote(sources[0])
  if (!first) return []
  if (verbose) return [first, ...sources.slice(1).map(quote).filter(Boolean)]
  return [`${first}${sources.length > 1 ? ` (+${sources.length - 1} more)` : ''}`]
}

/** `text` wrapped under a two-space margin, with `mark` in front of the first line and the rest under the text. */
function marked(mark: string, text: string, width: number): string[] {
  const lines = wrap(text, width, '    ')
  lines[0] = `  ${mark} ${(lines[0] ?? '').slice(4)}`
  return lines
}

/** An indented label and text, wrapped under the marker's text. */
function note(label: string, text: string, width: number): string[] {
  return wrap(`${label}: ${text}`, width, '    ')
}

/** A row's reason lines, as label and text: Cut and New when the server split them, else the one reason. */
function reasons(row: Change): [string, string][] {
  if (row.before && row.after) {
    // A reworded sentence with one reason: the reason is about the old text (Was) or the new (Now), not a cut or an add.
    if (row.cut && row.added) return [['Cut', row.cut], ['New', row.added]]
    if (row.cut) return [['Was', row.cut]]
    if (row.added) return [['Now', row.added]]
    return row.why ? [['Why', row.why]] : []
  }
  if (row.before) return row.cut || row.why ? [['Cut', row.cut || row.why]] : []
  return row.added || row.why ? [['New', row.added || row.why]] : []
}

/**
 * Rows as terminal lines under `header`, wrapped to `width`. Empty when there is nothing to show.
 * When every row gives the same one reason, it is said once after the rows, not under each.
 */
function blockLines(result: Record<string, unknown>, header: string, width: number, verbose = false): string[] {
  const shown = rows(result)
  if (shown.length === 0) return []
  const texts = shown.map((row) => reasons(row).map(([, text]) => text))
  const shared = shown.length > 1 && texts.every((t) => t.length === 1 && t[0] === texts[0]?.[0]) ? (texts[0]?.[0] ?? '') : ''
  const lines = [header]
  for (const row of shown) {
    if (row.before) lines.push(...marked('-', `"${row.before}"`, width))
    if (row.after) lines.push(...marked('+', `"${row.after}"`, width))
    if (!shared) for (const [label, text] of reasons(row)) lines.push(...note(label, text, width))
    for (const source of row.after ? sourceTexts(result, row.after, verbose) : []) lines.push(...note('Source', source, width))
  }
  if (shared) lines.push(...wrap(`Why, for each change: ${shared}`, width, '  '))
  return lines
}

/**
 * The "What Amdahl changed" block for an optimize result, as lines for stderr.
 * Empty when `changes` is absent, empty or has no usable row.
 */
export function changeLines(result: Record<string, unknown>, width = COLUMNS, verbose = false): string[] {
  return blockLines(result, CHANGES_HEADER, width, verbose)
}

/**
 * The "What changed in your prompt" block for an improved prompt run, as
 * lines. Empty when the run has no `changes`.
 */
export function promptChangeLines(run: Record<string, unknown>, width = COLUMNS): string[] {
  return blockLines(run, PROMPT_CHANGES_HEADER, width)
}

/**
 * One results-file cell for a result: a line per change, as `Cut "X": why.`,
 * `Changed "X" to "Y": why.` or `Added "Y": why.`. Empty when there is none.
 * A line is not cut, so the file keeps the whole sentence. The caller guards
 * the cell against a spreadsheet formula.
 */
export function changeCell(result: Record<string, unknown> | null | undefined): string {
  if (!result) return ''
  return rows(result)
    .map((row) => {
      if (!row.after) return `Cut "${row.before}"${row.cut || row.why ? `: ${row.cut || row.why}` : '.'}`
      if (!row.before) return `Added "${row.after}"${row.added || row.why ? `: ${row.added || row.why}` : '.'}`
      const labelled = [...(row.cut ? [`Cut: ${row.cut}`] : []), ...(row.added ? [`New: ${row.added}`] : [])].join(' ')
      if (labelled) return `Changed "${row.before}" to "${row.after}". ${labelled}`
      return `Changed "${row.before}" to "${row.after}"${row.why ? `: ${row.why}` : '.'}`
    })
    .join('\n')
}
