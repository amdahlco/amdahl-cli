// src/commands/sequence-leads-run.ts
//
// The run of `amdahl sequence --leads`: email k goes to Amdahl as batches
// (POST /api/platform/v1/messages/optimize/batch) for every person whose
// emails 1 to k-1 came back, each item carrying THAT person's own earlier
// emails as `prior_touches`. A step is split into several batches when one
// request would pass the server's 1 MB body limit (see splitItems). Every
// batch of a step is read, with `only_finished`, `finished_since` and
// `wait_ms`, until it completes, and only then does the next step start. A
// person whose email fails stops there, and the later steps skip them. An item
// the batch never reported counts as failed. A refused batch (quota, scope) or
// a lost read stops the whole run and keeps what finished. A batch that was
// refused as rate limited is sent again once after the wait, and one that
// failed with no answer at all is sent again once with the SAME idempotency
// key, so the server answers with the first batch instead of billing twice.
// `onStep` runs after every step, so the caller can save the results file.
// Copied from amdahl-frontend, apps/universal-ui/hooks/useSequencePeople.ts and
// lib/optimizer/batch.ts at commit d9a53a2b9 (#2286). Nothing here writes the
// text of an email anywhere.

import { randomUUID } from 'node:crypto'
import { AmdahlApiError } from '../api'
import { apiClient, call, errorDetails, toCliError, type Credential, type Ctx } from '../context'
import { CliError } from '../errors'
import { rowOfItem, type Lead, type LeadTable } from '../lead-people'
import type { FinalEmail } from '../sequence-parse'
import { personFinal, personItem, splitItems, stepCount, type PeopleSource } from '../sequence-leads'
import { count, field, record, records } from '../text'
import { BATCH_WAIT_MS, leftText } from './batch'

const PLATFORM = '/api/platform/v1'
const PAGE = 100
const MAX_RETRY_SECONDS = 60
const DEFAULT_RETRY_SECONDS = 10
const PRINT_EVERY_MS = 60_000

/** One person in a run: the emails written so far (null for one not written), and where they stopped. */
export interface PersonState {
  lead: Lead
  finals: Array<FinalEmail | null>
  /** The email (from 0) that failed for this person, and why in words. */
  failed: { at: number; reason: string } | null
}

/** A refused batch or a lost read: the run stopped here, for everyone. */
export interface Halt {
  /** The email (from 0) whose batch it was. */
  at: number
  reason: string
  hint?: string
  exit: number
  /** The error's code, such as `quota_exceeded`. */
  code: string
  /** Runs left in the month, when the server said (`details.remaining`). */
  remaining?: number
  /** The batches were sent but their reads were lost, so Amdahl may still be writing them. */
  lost?: boolean
}

const FAILURES: Record<string, string> = {
  optimizer_timeout: 'took too long',
  optimizer_error: 'the optimizer hit an error',
  optimizer_unconfigured: 'not set up for this workspace',
  no_message: 'every version failed a check',
  quota_exceeded: 'monthly limit reached',
  not_available: 'no longer available',
  invalid_input: 'could not read this row',
  needs_input: 'Amdahl asked questions instead of writing it',
  too_large: 'its row and earlier emails are too large to send',
}

/** A failure's reason as a few plain words. */
export const failureWords = (reason: string) => FAILURES[reason] ?? 'could not write this one'

/** Where a step stands, for its progress line. */
interface Track {
  k: number
  n: number
  done: number
  total: number
  shownAt: number
}

/** The progress line of one email step: counts, then the queue and the estimate the server sent for the batch just read. */
export function progressText(t: Pick<Track, 'k' | 'n' | 'done' | 'total'>, page?: Record<string, unknown>): string {
  const ahead = page && t.done === 0 && typeof page.queue_position === 'number' && page.queue_position > 0 ? `, queued behind ${count(page.queue_position, 'item')}` : ''
  const left = page && t.done < t.total ? leftText(page) : ''
  return `Email ${t.k + 1} of ${t.n}: ${t.done} of ${t.total} ${t.total === 1 ? 'person' : 'people'} done${ahead}${left}.`
}

/** At a terminal the line is rewritten in place; elsewhere one prints when a step ends, and about once a minute before that. */
function show(ctx: Ctx, t: Track, line: string, last: boolean): void {
  if (ctx.out.json) return
  if (ctx.io.stderrIsTTY) {
    ctx.io.stderr(`\r\u001b[2K${line}${last ? '\n' : ''}`)
    return
  }
  const now = ctx.io.now()
  if (!last && now - t.shownAt < PRINT_EVERY_MS) return
  t.shownAt = now
  ctx.out.info(line)
}

/** Seconds to wait before a refused batch is sent again, or null when it is not sent again. */
function resendAfter(e: CliError): number | null {
  if (e.code === 'rate_limited') return Math.min(MAX_RETRY_SECONDS, Math.ceil(e.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS))
  return e.code === 'network_error' ? 0 : null
}

/**
 * Send one batch and return its id, or the halt. One resend is allowed, with
 * the same key: after a rate limit (once the wait is over) and after an error
 * with no answer (the server may have queued the first, and replays it).
 */
async function submitBatch(ctx: Ctx, client: ReturnType<typeof apiClient>, items: Record<string, unknown>[], k: number): Promise<string | Halt> {
  const key = randomUUID()
  let resent = false
  for (;;) {
    try {
      const sent = await client.request<Record<string, unknown>>(`${PLATFORM}/messages/optimize/batch`, { method: 'POST', body: { items, idempotency_key: key } })
      const id = field(sent.batch_id)
      if (!id) throw new CliError('no_batch_id', 'Amdahl accepted the emails but sent no batch id.', 1)
      return id
    } catch (err) {
      const e = toCliError(err)
      const seconds = resent ? null : resendAfter(e)
      if (seconds !== null) {
        resent = true
        if (seconds > 0 && !ctx.out.json && ctx.io.stderrIsTTY) ctx.out.info(`Amdahl is busy. Trying email ${k + 1} again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`)
        if (seconds > 0) await ctx.io.sleep(seconds * 1000)
        continue
      }
      const remaining = err instanceof AmdahlApiError ? errorDetails(err.responseBody).remaining : undefined
      return { at: k, reason: e.message, ...(e.hint ? { hint: e.hint } : {}), exit: e.exit, code: e.code, ...(typeof remaining === 'number' ? { remaining } : {}) }
    }
  }
}

/**
 * Write every email for `people`, in order. Each step is sent as one batch, or
 * several when one would be too big, and every batch of it is read before the
 * next step. Returns the halt when a batch was refused or a read was lost,
 * else null. A person's own failures are in their state, not thrown.
 */
export async function runPeople(ctx: Ctx, credential: Credential, src: PeopleSource, table: LeadTable, people: PersonState[], onStep: () => void): Promise<Halt | null> {
  const client = apiClient(ctx, credential)
  const n = stepCount(src)
  for (let k = 0; k < n; k++) {
    const due = people.filter((p) => !p.failed && p.finals.slice(0, k).every(Boolean) && !p.finals[k])
    const byRow = new Map<number, PersonState>()
    const items: Record<string, unknown>[] = []
    for (const p of due) {
      try {
        items.push(personItem(src, k, p.lead, table, p.finals.slice(0, k) as FinalEmail[]))
        byRow.set(p.lead.row, p)
      } catch (err) {
        p.failed = { at: k, reason: err instanceof Error ? err.message : 'this email does not fit' }
      }
    }
    if (items.length === 0) continue
    const { parts, tooBig } = splitItems(items)
    for (const item of tooBig) {
      const p = byRow.get(rowOfItem(item.item_id, 0))
      if (p) p.failed = { at: k, reason: failureWords('too_large') }
    }
    const halt = await runStep(ctx, credential, client, src, k, n, parts, byRow, onStep)
    onStep()
    if (halt) return halt
  }
  return null
}

/**
 * Send the batches of one step, read them all, and settle each person. A part
 * whose reads are lost does not stop the others: they are queued and billed, so
 * each is still read. Only the lost part's people stay unwritten. `onPart` runs
 * after each part, so the results file keeps what came back. Returns the halt,
 * if any.
 */
async function runStep(ctx: Ctx, credential: Credential, client: ReturnType<typeof apiClient>, src: PeopleSource, k: number, n: number, parts: Record<string, unknown>[][], byRow: Map<number, PersonState>, onPart: () => void): Promise<Halt | null> {
  const sent: { id: string; people: Map<number, PersonState> }[] = []
  let halt: Halt | null = null
  for (const part of parts) {
    const id = await submitBatch(ctx, client, part, k)
    if (typeof id !== 'string') {
      halt = id
      break
    }
    const people = new Map<number, PersonState>()
    for (const item of part) {
      const p = byRow.get(rowOfItem(item.item_id, 0))
      if (p) people.set(p.lead.row, p)
    }
    sent.push({ id, people })
  }
  const track: Track = { k, n, done: 0, total: sent.reduce((sum, b) => sum + b.people.size, 0), shownAt: ctx.io.now() }
  let lost: Halt | null = null
  let unread = 0
  for (const [i, batch] of sent.entries()) {
    const gone = await readBatch(ctx, credential, client, batch.id, track, batch.people, src, i === sent.length - 1)
    if (gone) {
      lost = gone
      unread += 1
    } else for (const p of batch.people.values()) if (!p.failed && !p.finals[k]) p.failed = { at: k, reason: failureWords('') }
    onPart()
  }
  if (!lost) return halt
  const them = unread === 1 ? 'it' : 'them'
  return { ...lost, reason: `${unread} ${unread === 1 ? 'batch' : 'batches'} for email ${k + 1} could not be read: ${lost.reason} Amdahl may still be writing ${them}: run again with --resume later.`, lost: true }
}

/** Read one batch until it completes, settling each person as their email comes back. Returns the halt when the reads are lost. */
async function readBatch(ctx: Ctx, credential: Credential, client: ReturnType<typeof apiClient>, id: string, track: Track, byRow: Map<number, PersonState>, src: PeopleSource, lastBatch: boolean): Promise<Halt | null> {
  const seen = new Set<number>()
  let since = ''
  let misses = 0
  const { k } = track
  if (track.done === 0) show(ctx, track, progressText(track), false)
  for (;;) {
    let page: Record<string, unknown>
    try {
      const query = `only_finished=true&limit=${PAGE}&wait_ms=${BATCH_WAIT_MS}${since ? `&finished_since=${encodeURIComponent(since)}` : ''}`
      page = await call(() => client.request<Record<string, unknown>>(`${PLATFORM}/messages/optimize/batches/${encodeURIComponent(id)}?${query}`))
    } catch (err) {
      misses += 1
      if (misses >= 3) {
        const e = toCliError(err)
        show(ctx, track, progressText(track), true)
        return { at: k, reason: e.message, ...(e.hint ? { hint: e.hint } : {}), exit: e.exit, code: e.code }
      }
      await ctx.io.sleep(2000 * misses)
      continue
    }
    misses = 0
    since = field(page.finished_cursor) || since
    const items = records(page.items)
    for (const it of items) if (settle(it, k, byRow, seen, src)) track.done += 1
    const complete = page.status === 'completed' && Number(page.finished_remaining ?? 0) === 0
    show(ctx, track, progressText(track, page), complete && lastBatch)
    if (complete) return null
    if (items.length === 0) await ctx.io.sleep(2000)
  }
}

/** Put one finished item into its person's state. Returns true when the item was a new one for the batch. */
function settle(it: Record<string, unknown>, k: number, byRow: Map<number, PersonState>, seen: Set<number>, src: PeopleSource): boolean {
  const p = byRow.get(rowOfItem(it.item_id, Number(it.index)))
  if (!p || seen.has(p.lead.row)) return false
  const result = record(it.result)
  if (it.status !== 'done' && it.status !== 'failed') return false
  seen.add(p.lead.row)
  if (it.status === 'failed' || !result || result.ok === false) {
    p.failed = { at: k, reason: failureWords(field(result?.reason)) }
    return true
  }
  if (result.outcome !== 'needs_input' && typeof result.message !== 'string') {
    p.failed = { at: k, reason: failureWords('no_message') }
    return true
  }
  const final = personFinal(src, k, p.lead, result)
  if (final) p.finals[k] = final
  else p.failed = { at: k, reason: failureWords('needs_input') }
  return true
}
