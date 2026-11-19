// src/sequence-leads.ts
//
// `amdahl sequence --leads`: one sequence for each person in a lead list. What
// is sent for each person's email k, what comes back, and the results CSV with
// the columns for every email. Copied BY HAND from amdahl-frontend,
// apps/universal-ui/lib/optimizer/sequence-people.ts at commit d9a53a2b9
// (#2286, #2287, #2288), and its `Write the rest again` (the resume below).
// A change in the console is not caught here: make it in both places.
//
// A person's email k is sent with THAT person's own emails before it as
// `context.prior_touches`, never another person's. An improved email has the
// person's fields filled in first (see sequence-fields.ts). A written email has
// no message: the plan's rules, and the person's row as facts, are the input.
// The text of an email is never stored: the results file is the export.

import { usageError } from './errors'
import { MAX_LEADS, leadItem, leadLabel, type Lead, type LeadTable } from './lead-people'
import { cell, finalEmail, sentMessage, showsSubject, touchOf, type FinalEmail, type SeqEmail } from './sequence-parse'
import { fillFor, type FieldMatch } from './sequence-fields'
import { planRules, type PlanStep } from './sequence-plan'
import { messageColumn, stripUnverifiedMarkers, subjectColumn } from './send-to'
import { csvDelimiter, parseCsv } from './commands/batch'

export type PeopleSource = { kind: 'improve'; emails: SeqEmail[]; matches: FieldMatch[] } | { kind: 'write'; goal: string; steps: PlanStep[] }

export const stepCount = (src: PeopleSource) => (src.kind === 'improve' ? src.emails.length : src.steps.length)

/** Email k for one person: as typed with their fields filled in, or a blank one to write. */
export function stepEmail(src: PeopleSource, k: number, lead: Lead): SeqEmail {
  if (src.kind === 'write') return { subject: '', body: '', sameThread: k > 0 }
  const e = src.emails[k] as SeqEmail
  return { ...e, subject: fillFor(e.subject, lead, src.matches), body: fillFor(e.body, lead, src.matches) }
}

/** Whether email k has a subject: a written one only for email 1 (the rest reply in its thread), an improved one when it starts a thread. */
export const hasSubject = (src: PeopleSource, k: number) => (src.kind === 'write' ? k === 0 : showsSubject(src.emails[k] as SeqEmail, k))

/** One person's batch item for email k: their row, and their OWN earlier emails as prior touches. Throws a sentence when the email does not fit. */
export function personItem(src: PeopleSource, k: number, lead: Lead, table: LeadTable, earlier: readonly FinalEmail[]): Record<string, unknown> {
  const draft = src.kind === 'improve' ? sentMessage(stepEmail(src, k, lead), k) : ''
  const rules = src.kind === 'write' ? planRules(src.goal, src.steps, k, false) : []
  const item = leadItem({ ...lead, draft }, table, rules)
  const touches = earlier.map((f) => touchOf(f)).filter((t) => t.summary)
  if (touches.length === 0) return item
  return { ...item, context: { ...(item.context as Record<string, unknown> | undefined), prior_touches: touches } }
}

/** The most JSON bytes one batch request carries. The server refuses a body over 1 MB, so this keeps a margin. */
export const BODY_LIMIT = 900_000

const FRAME_BYTES = Buffer.byteLength(JSON.stringify({ items: [], idempotency_key: '0'.repeat(36) }))

/**
 * Split a step's items into requests, in order: each under {@link BODY_LIMIT}
 * bytes of JSON (measured as sent) and at most 500 items. An item that passes
 * the limit alone cannot be sent: it comes back in `tooBig`, not in a part.
 */
export function splitItems(items: Record<string, unknown>[]): { parts: Record<string, unknown>[][]; tooBig: Record<string, unknown>[] } {
  const parts: Record<string, unknown>[][] = []
  const tooBig: Record<string, unknown>[] = []
  let part: Record<string, unknown>[] = []
  let size = FRAME_BYTES
  for (const item of items) {
    const bytes = Buffer.byteLength(JSON.stringify(item))
    if (FRAME_BYTES + bytes > BODY_LIMIT) {
      tooBig.push(item)
      continue
    }
    if (part.length > 0 && (part.length >= MAX_LEADS || size + 1 + bytes > BODY_LIMIT)) {
      parts.push(part)
      part = []
      size = FRAME_BYTES
    }
    size += bytes + (part.length > 0 ? 1 : 0)
    part.push(item)
  }
  if (part.length > 0) parts.push(part)
  return { parts, tooBig }
}

/** The email a person gets back, or null when the writer asked questions instead of writing one (an improved email keeps what was typed). */
export function personFinal(src: PeopleSource, k: number, lead: Lead, result: Record<string, unknown>): FinalEmail | null {
  const email = stepEmail(src, k, lead)
  if (result.outcome === 'needs_input') return src.kind === 'improve' ? finalEmail(email, k, null) : null
  return finalEmail(email, k, String(result.message))
}

// The names the sequencers' import steps read: email 1 has no number, so a one-email list keeps its columns.
export const stepSubject = (k: number) => (k === 0 ? subjectColumn : `${subjectColumn}_${k + 1}`)
export const stepMessage = (k: number) => (k === 0 ? messageColumn : `${messageColumn}_${k + 1}`)
export const STATUS_COLUMN = 'amdahl_status'

export interface PersonRow {
  lead: Lead
  finals: ReadonlyArray<FinalEmail | null>
  status: string
}

/** `written`, `email 2 failed` or `not written yet`. */
export function personStatus(finals: ReadonlyArray<FinalEmail | null>, failedAt: number | null): string {
  if (failedAt !== null) return `email ${failedAt + 1} failed`
  return finals.every(Boolean) ? 'written' : 'not written yet'
}

/** The columns the results CSV adds after the list's own, in order. */
function ownColumns(subjects: readonly boolean[]): string[] {
  return subjects.flatMap((s, k) => [...(s ? [stepSubject(k)] : []), stepMessage(k)])
}

/** The results CSV: every original column, then each email's columns, then `amdahl_status`. CRLF, formula-guarded, no `<unverified>` marker. */
export function peopleCsv(table: LeadTable, rows: readonly PersonRow[], subjects: readonly boolean[]): string {
  const width = table.headers.length
  const head = [...table.headers, ...ownColumns(subjects), STATUS_COLUMN]
  const lines = rows.map((r) => {
    const cells = Array.from({ length: width }, (_, i) => r.lead.cells[i] ?? '')
    const emails = subjects.flatMap((s, k) => {
      const f = r.finals[k]
      const body = stripUnverifiedMarkers(f?.body ?? '')
      return s ? [stripUnverifiedMarkers(f?.subject ?? ''), body] : [body]
    })
    return [...cells, ...emails, r.status]
  })
  return [head, ...lines].map((line) => line.map(cell).join(',')).join('\r\n')
}

/** `<list>-amdahl-sequence.csv`: `q4 leads.csv` gives `q4 leads-amdahl-sequence.csv`. */
export function peopleFileName(listFile: string): string {
  return `${listFile.replace(/\.(csv|tsv|txt)$/i, '')}-amdahl-sequence.csv`
}

const FORMULA = /^[=+\-@\t\r]/
const guarded = (value: string) => (FORMULA.test(value) ? `'${value}` : value)
const plain = (value: string) => (value.startsWith("'") && FORMULA.test(value.slice(1)) ? value.slice(1) : value)

/**
 * Read a results file back, for `--resume`: each person's written emails, in
 * the order of `leads`. The file must be the one this list and these emails
 * make: the same columns, and the same people in the same order. Throws a
 * usage error that says what differs, before anything is sent.
 */
export function readResults(text: string, path: string, listPath: string, table: LeadTable, leads: readonly Lead[], subjects: readonly boolean[]): FinalEmail[][] {
  const rows = parseCsv(text, csvDelimiter(text)).rows
  const header = (rows[0] ?? []).map((h) => h.replace(/^\uFEFF/, ''))
  const expected = [...table.headers, ...ownColumns(subjects), STATUS_COLUMN]
  const same = header.length === expected.length && header.every((h, i) => h === expected[i])
  const hint = 'Run it without --resume to write every email again; add --force to replace the file.'
  if (!same) {
    const emails = subjects.length
    throw usageError(`${path} does not fit this run: its columns are not ${listPath}'s columns followed by ${emails === 1 ? '1 email' : `${emails} emails`}.`, hint)
  }
  const data = rows.slice(1)
  if (data.length !== leads.length) throw usageError(`${path} has ${data.length} people, and ${listPath} has ${leads.length}.`, hint)
  const width = table.headers.length
  return data.map((row, j) => {
    const lead = leads[j] as Lead
    for (let i = 0; i < width; i++) {
      if ((row[i] ?? '') !== guarded(lead.cells[i] ?? '')) throw usageError(`Row ${j + 2} of ${path} is not row ${lead.row} of ${listPath} (${leadLabel(lead)}).`, hint)
    }
    const finals: FinalEmail[] = []
    let at = width
    for (let k = 0; k < subjects.length; k++) {
      const subject = subjects[k] ? plain(row[at++] ?? '').trim() : ''
      const body = plain(row[at++] ?? '').trim()
      if (!body || finals.length < k) continue
      finals.push({ subject: subject || null, body })
    }
    return finals
  })
}
