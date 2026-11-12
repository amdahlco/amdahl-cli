// src/commands/batch.ts
//
// `amdahl optimize --list <file>`: rewrite a whole list of messages in one
// batch, through POST /api/platform/v1/messages/optimize/batch, then read it
// back from GET /messages/optimize/batches/:id until it completes.
//
// The list is a CSV file with a header row, or a JSONL file with one batch
// item (a JSON object) per line. A CSV has a `message` column and may have
// `item_id`, `channel`, `evidence`, `on_unsupported`, `facts` and `rules`
// (facts and rules one per line within the cell). Any other column (a CRM
// export has many) is not sent: it is named in one line and copied to the
// results file, in its place. Only a missing `message` column is refused. The
// optimize flags (`--channel`, `--evidence`, `--on-unsupported`, `--tries`,
// `--context`) apply to every item that does not set its own.
//
// The whole file is read and checked before anything is sent. Progress goes
// to stderr. When the batch completes, the results go to a file next to the
// list (`drafts.csv` -> `drafts.optimized.csv`, `x.jsonl` ->
// `x.optimized.jsonl`), or to stdout as one JSON document with `--json`.
// `--no-wait` only queues the batch and prints its id; `--batch <id>` picks
// up a batch queued earlier (with `--list`, its results go next to that list,
// and the list must have as many messages as the batch has items). A results
// file that already exists is not replaced without `--force`. A spreadsheet
// runs a cell that starts with `=`, `+`, `-` or `@` as a formula, so the CSV
// results start such a cell with a quote. Ctrl+C stops the wait, not the batch.

import { existsSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { amdahlCommand } from '../command-name'
import { apiClient, call, resolveCredential, str, type Credential, type Ctx } from '../context'
import { CliError, EXIT, usageError } from '../errors'
import { readTextFile } from '../files'
import { sentLines } from '../next-steps'
import { clip, count, field, record, records, truthfulSummary } from '../text'

const PLATFORM = '/api/platform/v1'

/** How long one status read waits on the server for the batch to complete. */
export const BATCH_WAIT_MS = 15_000

/** Items per status page when the results are read (the server's most). */
const PAGE = 100

/** The most messages one batch takes (the server's default cap). */
export const MAX_BATCH_ITEMS = 500

/** A batch id is a UUID. It goes into a request path and a file name, so nothing else is used. */
const BATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A path as a shell reads it back as one word: as it is when it holds only
 * plain characters, else in quotes (single on macOS and Linux, double on Windows).
 */
export function shellWord(path: string, platform: NodeJS.Platform = process.platform): string {
  if (/^[A-Za-z0-9_./:@%+=,~-]+$/.test(path)) return path
  return platform === 'win32' ? `"${path.replace(/"/g, '""')}"` : `'${path.replace(/'/g, `'\\''`)}'`
}

/** The CSV columns Amdahl reads. Any other column is ignored and copied to the results. */
export const CSV_COLUMNS = ['item_id', 'message', 'channel', 'evidence', 'on_unsupported', 'facts', 'rules']

/** A list read from a file: the items to send, and what each came from. */
export interface ListFile {
  path: string
  kind: 'csv' | 'jsonl'
  items: Record<string, unknown>[]
  /** CSV only: the header and each item's row, for the results file. */
  header?: string[]
  rows?: string[][]
  /** CSV only: the columns Amdahl does not read, as the header names them. They are copied to the results. */
  ignored?: string[]
  /** The line each item starts on, for an error that names an item. */
  lines: number[]
}

/**
 * Parse CSV text (RFC 4180: quoted fields may hold commas, line breaks and
 * doubled quotes). Returns the rows and the line each starts on. A blank
 * line is skipped.
 */
export function parseCsv(text: string): { rows: string[][]; lines: number[] } {
  const rows: string[][] = []
  const lines: number[] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let line = 1
  let rowLine = 1
  let touched = false
  const src = text.replace(/^\uFEFF/, '')
  const endRow = () => {
    row.push(cell)
    if (touched || row.length > 1 || cell !== '') {
      rows.push(row)
      lines.push(rowLine)
    }
    row = []
    cell = ''
    touched = false
  }
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else if (c === '\r' && src[i + 1] === '\n') continue
      else {
        if (c === '\n') line++
        cell += c
      }
      continue
    }
    if (c === '"' && cell === '') {
      quoted = true
      touched = true
    } else if (c === ',') {
      row.push(cell)
      cell = ''
      touched = true
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      endRow()
      line++
      rowLine = line
    } else cell += c
  }
  if (quoted) throw usageError(`A quoted CSV field that starts on line ${rowLine} never ends.`)
  if (cell !== '' || row.length > 0 || touched) endRow()
  return { rows, lines }
}

/** One CSV value, quoted when it must be. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** Rows as CSV text. */
export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n'
}

/** A cell that holds one entry per line, as a list; empty lines dropped. */
function perLine(cell: string): string[] {
  return cell
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Read a CSV list into batch items. */
function csvList(path: string, text: string): ListFile {
  const { rows, lines } = parseCsv(text)
  const [header, ...body] = rows
  if (!header) throw usageError(`${path} is empty.`)
  const names = header.map((h) => h.trim().toLowerCase())
  const twice = CSV_COLUMNS.find((c) => names.indexOf(c) !== names.lastIndexOf(c))
  if (twice !== undefined) throw usageError(`${path} has the column "${twice}" twice.`)
  if (!names.includes('message')) {
    throw usageError(
      `${path} needs a "message" column.`,
      `The first row must name the columns. Required: message. Read: ${CSV_COLUMNS.filter((c) => c !== 'message').join(', ')}. Any other column is copied to the results as it is.`
    )
  }
  const ignored = header.map((h, i) => ({ name: h.trim(), known: CSV_COLUMNS.includes(names[i] ?? '') })).filter((c) => !c.known && c.name).map((c) => clip(c.name, 30))
  const items = body.map((row, i) => {
    if (row.length !== names.length) {
      throw usageError(`Line ${lines[i + 1]} of ${path} has ${count(row.length, 'cell')}; the header has ${names.length}.`)
    }
    const item: Record<string, unknown> = {}
    const context: Record<string, string[]> = {}
    names.forEach((name, j) => {
      const value = row[j] ?? ''
      if (!CSV_COLUMNS.includes(name) || !value.trim()) return
      if (name === 'facts' || name === 'rules') context[name] = perLine(value)
      else item[name] = name === 'message' ? value : value.trim()
    })
    if (Object.keys(context).length > 0) item.context = context
    return item
  })
  return { path, kind: 'csv', items, header, rows: body, ignored, lines: lines.slice(1) }
}

/** Read a JSONL list: each non-blank line one JSON object, sent as one batch item. */
function jsonlList(path: string, text: string): ListFile {
  const items: Record<string, unknown>[] = []
  const lines: number[] = []
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw usageError(`Line ${i + 1} of ${path} is not JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
    const item = record(parsed)
    if (!item) throw usageError(`Line ${i + 1} of ${path} is not a JSON object.`)
    items.push(item)
    lines.push(i + 1)
  })
  return { path, kind: 'jsonl', items, lines }
}

/** Read a list file: `.csv`, or `.jsonl`/`.ndjson`, else by its first character. */
export function readList(path: string): ListFile {
  const text = readTextFile(path)
  const ext = extname(path).toLowerCase()
  const jsonl = ext === '.jsonl' || ext === '.ndjson' || (ext !== '.csv' && text.trimStart().startsWith('{'))
  const list = jsonl ? jsonlList(path, text) : csvList(path, text)
  if (list.items.length === 0) throw usageError(`${path} has no messages.`)
  return list
}

/** Where the results of `list` go: beside it, `<name>.optimized.<ext>`. */
export function resultsPath(path: string, kind: 'csv' | 'jsonl'): string {
  const ext = extname(path)
  const stem = basename(path, ext)
  return join(dirname(path), `${stem}.optimized.${kind === 'csv' ? 'csv' : 'jsonl'}`)
}

/**
 * The optimize flags every item gets unless it sets its own. A `--context`
 * file and an item's own context merge, the item's keys winning: a CSV row's
 * facts beside the file's rules and voice examples.
 */
function withDefaults(items: Record<string, unknown>[], defaults: Record<string, unknown>): Record<string, unknown>[] {
  return items.map((item) => {
    const merged: Record<string, unknown> = { ...item }
    for (const [key, value] of Object.entries(defaults)) if (merged[key] === undefined) merged[key] = value
    const shared = record(defaults.context)
    const own = record(item.context)
    if (shared && own) merged.context = { ...shared, ...own }
    return merged
  })
}

/** The part of a progress line that says where the batch stands, without the estimate. */
export function progressKey(batch: Record<string, unknown>): string {
  const c = record(batch.counts) ?? {}
  return ['total', 'queued', 'running', 'done', 'failed'].map((k) => (typeof c[k] === 'number' ? c[k] : 0)).join('/')
}

/** One progress line: counts, and the server's estimate while items are left. */
export function progressLine(batch: Record<string, unknown>): string {
  const c = record(batch.counts) ?? {}
  const n = (k: string) => (typeof c[k] === 'number' ? (c[k] as number) : 0)
  const total = n('total')
  const finished = n('done') + n('failed')
  const failed = n('failed') ? `, ${n('failed')} failed` : ''
  const eta = record(batch.eta)
  const seconds = typeof eta?.seconds === 'number' ? eta.seconds : null
  const left = seconds === null || finished === total ? '' : seconds < 90 ? ', about a minute left' : `, about ${Math.round(seconds / 60)} min left`
  if (finished === 0 && n('running') === 0) {
    const ahead = typeof batch.queue_position === 'number' && batch.queue_position > 0 ? ` behind ${count(batch.queue_position, 'item')}` : ''
    // Nothing has started, so it says only that: "0 of N done" is the next line's to say.
    return `Queued${ahead}${left}`
  }
  return `${n('done')} of ${total} done${failed}${left}`
}

/** Read the batch until it completes, printing progress on stderr when it changes. */
async function waitForBatch(ctx: Ctx, credential: Credential, id: string, first: Record<string, unknown> | null): Promise<void> {
  const client = apiClient(ctx, credential)
  const tty = ctx.io.stderrIsTTY && !ctx.out.json
  let last = ''
  let lastKey = ''
  const show = (batch: Record<string, unknown>) => {
    const line = progressLine(batch)
    if (line === last) return
    last = line
    // At a terminal, the line is rewritten in place. Elsewhere a line prints when the batch
    // moves, not when only its estimate does, so no "N of M done" appears twice.
    if (tty) ctx.io.stderr(`\r\u001b[2K${line}`)
    else if (progressKey(batch) !== lastKey) ctx.out.info(line)
    lastKey = progressKey(batch)
  }
  let batch = first
  for (;;) {
    if (batch) {
      show(batch)
      if (batch.status === 'completed') break
    }
    const read: Record<string, unknown> = await call(() =>
      client.request<Record<string, unknown>>(`${PLATFORM}/messages/optimize/batches/${encodeURIComponent(id)}?wait_ms=${BATCH_WAIT_MS}&limit=1`)
    )
    // A server that does not hold the read is read again a little later, not in a tight loop.
    if (batch && read.status !== 'completed' && progressLine(read) === last) await ctx.io.sleep(2000)
    batch = read
  }
  if (tty) ctx.io.stderr('\n')
}

/** Every item of a completed batch, page by page. */
async function allItems(ctx: Ctx, credential: Credential, id: string): Promise<{ batch: Record<string, unknown>; items: Record<string, unknown>[] }> {
  const client = apiClient(ctx, credential)
  const items: Record<string, unknown>[] = []
  let cursor: string | null = null
  let batch: Record<string, unknown> = {}
  do {
    const query: string = `limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    batch = await call(() => client.request<Record<string, unknown>>(`${PLATFORM}/messages/optimize/batches/${encodeURIComponent(id)}?${query}`))
    items.push(...records(batch.items))
    cursor = typeof batch.next_cursor === 'string' && batch.next_cursor ? batch.next_cursor : null
  } while (cursor)
  return { batch, items }
}

/**
 * A cell as a spreadsheet will not run it: one that starts with `=`, `+`, `-`,
 * `@`, a tab or a carriage return gets a quote in front. Amdahl's own message
 * can start with `-`, and a list's cells are the sender's: neither is a formula.
 */
export function neutralise(cell: string): string {
  return /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell
}

/** The results columns a CSV list gains. */
export const RESULT_COLUMNS = ['optimized_message', 'status', 'summary', 'run_id', 'error']

/**
 * The names of the results columns for a list with this header. A column the
 * list already has under a name (a CRM export may have `status`) keeps it, and
 * Amdahl's column takes `amdahl_` in front, so nothing is written over.
 */
export function resultColumnNames(header: string[]): string[] {
  const taken = new Set(header.map((h) => h.trim().toLowerCase()))
  return RESULT_COLUMNS.map((name) => {
    let candidate = name
    while (taken.has(candidate)) candidate = `amdahl_${candidate}`
    taken.add(candidate)
    return candidate
  })
}

/** One item's results cells: Amdahl's message, done or failed, its one-line summary, the run id, why it failed. */
function resultCells(item: Record<string, unknown> | undefined, context: unknown): string[] {
  const result = record(item?.result)
  if (!item || !result) return ['', field(item?.status) || 'missing', '', '', '']
  if (result.ok === false) return ['', 'failed', '', field(result.run_id), `${field(result.reason)}: ${field(result.detail)}`.replace(/: $/, '')]
  // The message is the sender's own text: kept as sent, line breaks and all.
  const message = typeof result.message === 'string' ? result.message : ''
  return [message, result.unchanged === true ? 'unchanged' : 'done', truthfulSummary(field(result.summary), context), field(result.run_id), '']
}

/** Where the results of a run go: next to its list, or `<id>.optimized.jsonl` here. */
function resultsFile(list: ListFile | null, id: string, cwd: string): string {
  if (list) return resultsPath(list.path, list.kind)
  return join(cwd, `${id}.optimized.jsonl`)
}

/**
 * Refuse to replace a results file that exists, unless `--force`. Checked
 * before anything is queued or waited for, so nothing is spent on a run whose
 * results have nowhere to go.
 */
function assertFree(path: string, force: boolean): void {
  if (!force && existsSync(path)) throw usageError(`${path} already exists.`, 'Move it, or add --force to replace it.')
}

/** Write the results file for `list`. Returns its path. */
function writeResults(list: ListFile | null, id: string, items: Record<string, unknown>[], cwd: string, force: boolean, contexts: unknown[]): string {
  const byIndex = new Map(items.map((i) => [i.index, i]))
  const path = resultsFile(list, id, cwd)
  // `wx` fails when the file appeared since the check, instead of replacing it.
  const flag = force ? 'w' : 'wx'
  if (list?.kind === 'csv' && list.header && list.rows) {
    const rows = [[...list.header, ...resultColumnNames(list.header)], ...list.rows.map((row, i) => [...row, ...resultCells(byIndex.get(i), contexts[i])])]
    writeFileSync(path, toCsv(rows.map((row) => row.map(neutralise))), { flag })
    return path
  }
  writeFileSync(path, items.map((i) => JSON.stringify(i)).join('\n') + '\n', { flag })
  return path
}

/** The refusal of a body the server could not take, with the list line of the first item it names. */
function withLine(err: unknown, list: ListFile): unknown {
  if (!(err instanceof CliError)) return err
  const index = /\$\.items\[(\d+)\]/.exec(err.message)?.[1]
  const line = index === undefined ? undefined : list.lines[Number(index)]
  if (line === undefined) return err
  return new CliError(err.code, err.message, err.exit, `items[${index}] is line ${line} of ${list.path}.`, err.detail, err.data)
}

/**
 * `amdahl optimize --list <file>` (and `--batch <id>`, `--no-wait`). `defaults`
 * are the optimize flags as request fields.
 */
export async function optimizeList(ctx: Ctx, defaults: Record<string, unknown>): Promise<number> {
  const { out, flags } = ctx
  const listPath = str(flags.list)
  const resume = str(flags.batch)
  if (typeof flags.list === 'string' && !listPath) throw usageError('--list needs a file.')
  if (typeof flags.batch === 'string' && !resume) throw usageError('--batch needs a batch id: a UUID like the one `amdahl optimize --list` printed.')
  if (!listPath && !resume) throw usageError('Give a list with --list <file>, or a batch id with --batch <id>.')
  if (resume && flags['no-wait'] === true) throw usageError('--no-wait does nothing with --batch: it only queues a new list.')
  if (resume && !BATCH_ID.test(resume)) {
    throw usageError('--batch needs a batch id: a UUID like the one `amdahl optimize --list` printed.')
  }
  const list = listPath ? readList(listPath) : null
  if (list?.ignored?.length) {
    const shown = list.ignored.slice(0, 6).join(', ')
    const more = list.ignored.length > 6 ? ` and ${list.ignored.length - 6} more` : ''
    out.info(`Not sent, and copied to the results as they are: ${count(list.ignored.length, 'column')} Amdahl does not read (${shown}${more}).`)
  }
  if (!resume && list && list.items.length > MAX_BATCH_ITEMS) {
    throw usageError(`A batch takes at most ${MAX_BATCH_ITEMS} messages, and ${list.path} has ${list.items.length}.`, 'Split the list into files of 500 or fewer, and run each one.')
  }
  const force = flags.force === true
  // Nothing is queued, read or waited for while the results have nowhere to go.
  if (!out.json && flags['no-wait'] !== true) assertFree(resultsFile(list, resume ?? '', ctx.io.cwd), force)
  const credential = await resolveCredential(ctx)

  let id = resume ?? ''
  let first: Record<string, unknown> | null = null
  if (resume && list) {
    // The rows of the results file are the rows of the list: a different list would be matched to the wrong results.
    first = await call(() =>
      apiClient(ctx, credential).request<Record<string, unknown>>(`${PLATFORM}/messages/optimize/batches/${encodeURIComponent(resume)}?limit=1`)
    )
    const total = record(first.counts)?.total
    if (typeof total === 'number' && total !== list.items.length) {
      throw usageError(`${list.path} has ${count(list.items.length, 'message')}, but batch ${resume} has ${count(total, 'item')}.`, 'Use the same list you queued the batch from.')
    }
  }
  if (!resume && list) {
    const items = withDefaults(list.items, defaults)
    try {
      first = await call(() =>
        apiClient(ctx, credential).request<Record<string, unknown>>(`${PLATFORM}/messages/optimize/batch`, { method: 'POST', body: { items } })
      )
    } catch (err) {
      throw withLine(err, list)
    }
    id = field(first.batch_id)
    if (!id) throw new CliError('no_batch_id', 'Amdahl accepted the list but sent no batch id.', EXIT.general)
    const pickUp = amdahlCommand(`optimize --list ${shellWord(listPath ?? '', ctx.io.platform)} --batch ${id}`)
    if (flags['no-wait'] === true) {
      out.result({ ...first, ok: true }, `Queued ${count(list.items.length, 'message')} as batch ${id}.\nGet the results: ${pickUp}`)
      return EXIT.ok
    }
    out.info(`Queued ${count(list.items.length, 'message')} as batch ${id}.`)
    out.info(`Ctrl+C stops waiting, not the batch. To pick it up later: ${pickUp}`)
    const setup = field(record(first.setup_needed)?.message)
    if (setup) out.info(setup)
  }

  await waitForBatch(ctx, credential, id, first)
  const { batch, items } = await allItems(ctx, credential, id)
  const failed = items.filter((i) => i.status === 'failed' || record(i.result)?.ok === false).length
  if (out.json) {
    out.result({ ...batch, ok: failed === 0, items, next_cursor: null })
    return failed === 0 ? EXIT.ok : EXIT.general
  }
  // What each row was sent with, so a summary that speaks of the sender's facts and rules is kept only when there were some.
  const contexts = list ? withDefaults(list.items, defaults).map((item) => item.context) : []
  const path = writeResults(list, id, items, ctx.io.cwd, force, contexts)
  const done = items.length - failed
  out.info(`${done} of ${count(items.length, 'message')} optimized${failed ? `, ${failed} failed` : ''}.`)
  out.result({}, `Results: ${path}`)
  // What to do once the messages are sent, with a real run id from this batch.
  const runId = items.map((i) => field(record(i.result)?.run_id)).find(Boolean)
  for (const line of sentLines(runId, 'Sent one?')) out.info(line)
  return failed === 0 ? EXIT.ok : EXIT.general
}
