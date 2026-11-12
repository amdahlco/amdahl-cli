// src/commands/batch.ts
//
// `amdahl optimize --list <file>`: rewrite a whole list of messages in one
// batch, through POST /api/platform/v1/messages/optimize/batch, then read it
// back from GET /messages/optimize/batches/:id until it completes.
//
// The list is a CSV file with a header row, or a JSONL file with one batch
// item (a JSON object) per line. A CSV has a `message` column and may have
// `item_id`, `channel`, `evidence`, `on_unsupported`, `facts` and `rules`
// (facts and rules one per line within the cell). Any other column is
// refused by name, so a misspelled one is never dropped without a word. The
// optimize flags (`--channel`, `--evidence`, `--on-unsupported`, `--tries`,
// `--context`) apply to every item that does not set its own.
//
// The whole file is read and checked before anything is sent. Progress goes
// to stderr. When the batch completes, the results go to a file next to the
// list (`drafts.csv` -> `drafts.optimized.csv`, `x.jsonl` ->
// `x.optimized.jsonl`), or to stdout as one JSON document with `--json`.
// `--no-wait` only queues the batch and prints its id; `--batch <id>` picks
// up a batch queued earlier (with `--list`, its results go next to that list).
// Ctrl+C stops the wait, not the batch.

import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { amdahlCommand } from '../command-name'
import { apiClient, call, resolveCredential, str, type Credential, type Ctx } from '../context'
import { CliError, EXIT, usageError } from '../errors'
import { count, field, record, records } from '../text'

const PLATFORM = '/api/platform/v1'

/** How long one status read waits on the server for the batch to complete. */
export const BATCH_WAIT_MS = 15_000

/** Items per status page when the results are read (the server's most). */
const PAGE = 100

/** The CSV columns a list may have. */
export const CSV_COLUMNS = ['item_id', 'message', 'channel', 'evidence', 'on_unsupported', 'facts', 'rules']

/** A list read from a file: the items to send, and what each came from. */
export interface ListFile {
  path: string
  kind: 'csv' | 'jsonl'
  items: Record<string, unknown>[]
  /** CSV only: the header and each item's row, for the results file. */
  header?: string[]
  rows?: string[][]
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
  const unknown = names.find((n) => !CSV_COLUMNS.includes(n))
  if (unknown !== undefined) {
    throw usageError(`${path} has a column Amdahl doesn't read: "${unknown}".`, `Columns: ${CSV_COLUMNS.join(', ')} (message is required). For any other field, use a JSONL file.`)
  }
  if (!names.includes('message')) throw usageError(`${path} needs a "message" column.`, `Columns: ${CSV_COLUMNS.join(', ')}.`)
  const items = body.map((row, i) => {
    if (row.length !== names.length) {
      throw usageError(`Line ${lines[i + 1]} of ${path} has ${count(row.length, 'cell')}; the header has ${names.length}.`)
    }
    const item: Record<string, unknown> = {}
    const context: Record<string, string[]> = {}
    names.forEach((name, j) => {
      const value = row[j] ?? ''
      if (!value.trim()) return
      if (name === 'facts' || name === 'rules') context[name] = perLine(value)
      else item[name] = name === 'message' ? value : value.trim()
    })
    if (Object.keys(context).length > 0) item.context = context
    return item
  })
  return { path, kind: 'csv', items, header, rows: body, lines: lines.slice(1) }
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
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    throw usageError(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
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
    return `Queued${ahead}: 0 of ${total} done${left}`
  }
  return `${n('done')} of ${total} done${failed}${left}`
}

/** Read the batch until it completes, printing progress on stderr when it changes. */
async function waitForBatch(ctx: Ctx, credential: Credential, id: string, first: Record<string, unknown> | null): Promise<void> {
  const client = apiClient(ctx, credential)
  const tty = ctx.io.stderrIsTTY && !ctx.out.json
  let last = ''
  const show = (batch: Record<string, unknown>) => {
    const line = progressLine(batch)
    if (line === last) return
    last = line
    // At a terminal, the line is rewritten in place; elsewhere each change is a line.
    if (tty) ctx.io.stderr(`\r\u001b[2K${line}`)
    else ctx.out.info(line)
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

/** The results columns a CSV list gains. */
export const RESULT_COLUMNS = ['optimized_message', 'status', 'what_changed', 'run_id', 'error']

/** One item's results cells: Amdahl's message, done or failed, what changed, the run id, why it failed. */
function resultCells(item: Record<string, unknown> | undefined): string[] {
  const result = record(item?.result)
  if (!item || !result) return ['', field(item?.status) || 'missing', '', '', '']
  if (result.ok === false) return ['', 'failed', '', field(result.run_id), `${field(result.reason)}: ${field(result.detail)}`.replace(/: $/, '')]
  // The message is the sender's own text: kept as sent, line breaks and all.
  const message = typeof result.message === 'string' ? result.message : ''
  return [message, result.unchanged === true ? 'unchanged' : 'done', field(result.what_changed), field(result.run_id), '']
}

/** Write the results file for `list`. Returns its path. */
function writeResults(list: ListFile | null, id: string, items: Record<string, unknown>[], cwd: string): string {
  const byIndex = new Map(items.map((i) => [i.index, i]))
  if (list?.kind === 'csv' && list.header && list.rows) {
    const path = resultsPath(list.path, 'csv')
    const rows = [[...list.header, ...RESULT_COLUMNS], ...list.rows.map((row, i) => [...row, ...resultCells(byIndex.get(i))])]
    writeFileSync(path, toCsv(rows))
    return path
  }
  const path = list ? resultsPath(list.path, 'jsonl') : join(cwd, `${id}.optimized.jsonl`)
  writeFileSync(path, items.map((i) => JSON.stringify(i)).join('\n') + '\n')
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
  if (!listPath && !resume) throw usageError('Give a list with --list <file>, or a batch id with --batch <id>.')
  const list = listPath ? readList(listPath) : null
  const credential = await resolveCredential(ctx)

  let id = resume ?? ''
  let first: Record<string, unknown> | null = null
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
    const pickUp = amdahlCommand(`optimize --list ${listPath} --batch ${id}`)
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
  const path = writeResults(list, id, items, ctx.io.cwd)
  const done = items.length - failed
  out.info(`${done} of ${count(items.length, 'message')} optimized${failed ? `, ${failed} failed` : ''}.`)
  out.result({}, `Results: ${path}`)
  return failed === 0 ? EXIT.ok : EXIT.general
}
