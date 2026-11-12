// src/commands/search.ts
//
// `amdahl search "<question>"`: one question about the workspace's customers,
// calls and deals, through POST /api/platform/v1/search/query with
// `answer: true`, so a person reads a short cited answer over the rows that
// matched, or the rows themselves. `--json` prints the server's whole answer.
//
// Research is something search starts, never a command of its own. Search
// hands a statistical or long ask to a research job by itself, and
// `--research` asks it to (`route: "research"`). When a job starts, the CLI
// waits on GET /research/:id with `wait_ms` and prints its cited answer. A
// CLI sign-in cannot start one (it has no `conversations:write`), so the
// server runs the search instead and says so; the CLI then adds one line on
// the key that can (`amdahl keys create --preset agent`).
//
// A workspace with nothing connected answers with `setup_needed`: its
// message and link print, then the command that opens the add page.

import { amdahlCommand } from '../command-name'
import { apiClient, call, resolveCredential, str, type Credential, type Ctx } from '../context'
import { CliError, EXIT, usageError } from '../errors'
import { clip, count, day, field, plainMarkdown, record, records, wrap } from '../text'
import { connectLine } from './connections'

const PLATFORM = '/api/platform/v1'

/** How long one research read waits on the server (its cap is 45 s). */
export const RESEARCH_WAIT_MS = 45_000

/** How long `search` waits for a research job in all before it gives the job's id instead. */
export const RESEARCH_TIMEOUT_MS = 15 * 60_000

/** Rows a person sees under an answer, and with no answer. */
const ROWS_UNDER_ANSWER = 5
const ROWS_ALONE = 10

/** The line a sign-in gets when a deeper answer needs a key. */
export function researchKeyLine(): string {
  return `A deeper answer needs a Customer agent key: ${amdahlCommand('keys create --name research --preset agent')}`
}

/** The research states a wait ends on. */
const SETTLED = new Set(['complete', 'failed', 'canceled', 'needs_input'])

// Field names a row's title, date and text are found under, across the search
// lanes (warehouse rows, call matches, deal rows). The first one present wins.
const TITLE_FIELDS = ['title', 'call_title', 'meeting_title', 'subject', 'deal_name', 'account_name', 'company_name', 'name']
const DATE_FIELDS = ['occurred_at', 'started_at', 'date', 'call_date', 'call_timestamp', 'close_date', 'created_at', 'updated_at']
const TEXT_FIELDS = ['text', 'quote', 'snippet', 'excerpt', 'content', 'summary', 'body', 'description']
const WHO_FIELDS = ['speaker', 'speaker_name', 'account_name', 'company_name', 'owner_name', 'deal_stage_label']
// A deal's amount, said after its stage.
const AMOUNT_FIELDS = ['deal_amount', 'amount']

function first(row: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = row[name]
    if (typeof value === 'string' && value.trim()) return field(value)
    if (typeof value === 'number') return String(value)
  }
  return ''
}

/**
 * One row in at most three lines: its title, who and when, then its text cut
 * to fit. A row with none of the known fields prints its first few scalar
 * fields as `key: value`.
 */
export function rowLines(row: Record<string, unknown>, n: number): string[] {
  const title = first(row, TITLE_FIELDS)
  const who = first(row, WHO_FIELDS)
  const when = day(first(row, DATE_FIELDS))
  const body = first(row, TEXT_FIELDS)
  const amount = first(row, AMOUNT_FIELDS)
  const head = [title, who !== title ? who : '', amount, when].filter(Boolean).join(', ')
  if (head || body) {
    const lines = [`${n}. ${clip(head || body, 74)}`]
    if (head && body) lines.push(...wrap(clip(body, 220), 80, '   ').slice(0, 3))
    return lines
  }
  const pairs = Object.entries(row)
    .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? field(v) : String(v)}`)
  return [`${n}. ${clip(pairs.join(', ') || JSON.stringify(row), 74)}`]
}

/** The rows (or similarity matches) the lane returned. */
function rowsOf(result: Record<string, unknown>): Record<string, unknown>[] {
  return records(result.results)
}

/** The search answer for a person: the cited answer or the rows, and what the server noted. */
export function searchLines(result: Record<string, unknown>): string[] {
  const lines: string[] = []
  const rows = rowsOf(result)
  const answer = record(result.answer)
  const answered = answer?.status === 'answered' && field(answer.text)
  if (answered) lines.push(...wrap(plainMarkdown(field(answer.text))), '')
  const shown = rows.slice(0, answered ? ROWS_UNDER_ANSWER : ROWS_ALONE)
  if (shown.length > 0) {
    if (answered) lines.push('From:')
    shown.forEach((row, i) => lines.push(...rowLines(row, i + 1)))
    if (rows.length > shown.length) lines.push(`And ${count(rows.length - shown.length, 'more row')} (all of them: add --json).`)
  } else if (!answered) {
    const freshness = field(record(result.data_freshness)?.message)
    lines.push(freshness || 'Nothing matched.')
  }
  const gap = field(record(result.statistical_gap)?.message)
  if (gap) lines.push(...wrap(gap))
  return lines
}

/** Whether a note says the research handoff was refused for want of a credential that can start one. */
function refusedForScope(notes: string[]): boolean {
  return notes.some((n) => /ran search instead/i.test(n) && /conversations:write|credential/i.test(n))
}

/** The research answer for a person: its cited text, then up to three questions to ask next. */
export function researchLines(job: Record<string, unknown>): string[] {
  const answer = record(job.answer)
  const lines = wrap(plainMarkdown(field(answer?.text)) || 'The research finished with no answer.')
  if (answer?.partial === true) lines.push('', 'It stopped at its budget, so this answers from what it had read.')
  const next = (Array.isArray(answer?.follow_ups) ? answer.follow_ups : []).map(field).filter(Boolean).slice(0, 3)
  if (next.length > 0) {
    lines.push('', 'Ask next:')
    for (const q of next) lines.push(...wrap(`- ${q}`))
  }
  return lines
}

/**
 * Wait for a research job to settle: one long-poll read after another, up to
 * {@link RESEARCH_TIMEOUT_MS}. Returns the last read.
 */
async function waitForResearch(ctx: Ctx, credential: Credential, id: string): Promise<Record<string, unknown>> {
  const client = apiClient(ctx, credential)
  const started = ctx.io.now()
  for (;;) {
    const job = await call(() => client.request<Record<string, unknown>>(`${PLATFORM}/research/${encodeURIComponent(id)}?wait_ms=${RESEARCH_WAIT_MS}`))
    if (SETTLED.has(field(job.status)) || ctx.io.now() - started >= RESEARCH_TIMEOUT_MS) return job
    // A server that answers at once (no long-poll) is read again a little later, not in a tight loop.
    await ctx.io.sleep(2000)
  }
}

/** `amdahl search "<question>" [--research] [--limit <n>]`. */
export async function search(ctx: Ctx, args: string[]): Promise<number> {
  const { out } = ctx
  const question = args.join(' ').trim()
  if (!question) throw usageError('Ask a question.', `Usage: ${amdahlCommand('search "<question>" [--research]')}`)
  const body: Record<string, unknown> = { query: question, answer: true }
  if (ctx.flags.research === true) body.route = 'research'
  const limit = str(ctx.flags.limit)
  if (limit !== undefined) {
    const n = Number(limit)
    if (!Number.isInteger(n) || n < 1) throw usageError('--limit must be a whole number above 0.')
    body.limit = n
  }

  const credential = await resolveCredential(ctx)
  const client = apiClient(ctx, credential)
  if (!out.json && ctx.io.stderrIsTTY) out.info('Searching...')
  const result = await call(() => client.request<Record<string, unknown>>(`${PLATFORM}/search/query`, { method: 'POST', body }))
  const notes = (Array.isArray(result.notes) ? result.notes : []).map(field).filter(Boolean)
  const setup = record(result.setup_needed)
  const handoff = record(result.research)

  // A fresh handle carries no answer, even one that says `complete` (a cached job): read the job.
  if (handoff && field(handoff.research_id) && !record(handoff.answer)) {
    if (!out.json && field(handoff.status) !== 'complete') out.info('Amdahl started research on it. This can take a few minutes.')
    let job: Record<string, unknown>
    try {
      job = await waitForResearch(ctx, credential, field(handoff.research_id))
    } catch (err) {
      // The job started but this credential cannot read it back.
      if (err instanceof CliError && err.exit === EXIT.forbidden) {
        if (out.json) out.result({ ...result, ok: true })
        else out.info(`Research ${field(handoff.research_id)} started, but this credential can't read it.\n${researchKeyLine()}`)
        return EXIT.forbidden
      }
      throw err
    }
    return printResearch(ctx, result, job)
  }
  if (handoff && field(handoff.status)) return printResearch(ctx, result, handoff)

  if (out.json) {
    out.result({ ...result, ok: true })
    return EXIT.ok
  }
  if (setup) {
    out.result({}, [...wrap(field(setup.message) || 'This workspace has no data connected yet.'), connectLine()].join('\n'))
    return EXIT.ok
  }
  const lines = searchLines(result)
  out.result({}, lines.join('\n'))
  if (refusedForScope(notes)) out.info(researchKeyLine())
  else {
    const refused = notes.find((n) => /ran search instead/i.test(n))
    if (refused) out.info(wrap(refused).join('\n'))
  }
  return EXIT.ok
}

/** Print a settled (or still running) research job; the exit code says how it ended. */
function printResearch(ctx: Ctx, search: Record<string, unknown>, job: Record<string, unknown>): number {
  const { out } = ctx
  const status = field(job.status)
  const id = field(job.research_id)
  if (out.json) {
    out.result({ ...search, ok: status === 'complete', research: job })
    return status === 'complete' ? EXIT.ok : EXIT.general
  }
  if (status === 'complete') {
    out.result({}, researchLines(job).join('\n'))
    return EXIT.ok
  }
  if (status === 'running') {
    out.info(`The research is still running (id ${id}). Open it in the console: ${amdahlCommand('open')}`)
    return EXIT.general
  }
  if (status === 'needs_input') {
    const q = field(record(job.question_for_you)?.question)
    out.info(`The research stopped on a question it can't ask here${q ? `: ${q}` : '.'} Ask again with more detail.`)
    return EXIT.general
  }
  out.info(`The research ${status === 'canceled' ? 'was canceled' : 'failed'}${field(job.error) ? `: ${field(job.error)}` : '.'}`)
  return EXIT.general
}
