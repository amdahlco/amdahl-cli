// src/sequence-parse.ts
//
// `amdahl sequence`: reading the emails of a sequence, and building what is
// sent for each. The console's Sequence tab does the same for the same input,
// so the splitting rules, the column names, the thread rule and the touches
// are copied BY HAND from amdahl-frontend (apps/universal-ui/lib/optimizer/
// sequence.ts, sequence-fields.ts, sequence-export.ts and parse-drafts.ts) at
// commit 9d1d55216 (#2277). Nothing here runs the console's code, and a change
// in the console is not caught here: make it in both places.
//
// An email is `{ subject, body, sameThread }`. Email 1 always keeps its
// subject. A later email WITH a subject starts a new thread and keeps it; one
// without is a reply in the same thread and is sent with no subject. A
// difference from the console: a step column whose body is empty, with a later
// step that has one, is kept as an empty email, so it is refused by name
// ("Email 2 is empty.") instead of the later emails shifting up. Not copied:
// HTML bodies read as text, and a filled-in export (an Apollo row with "Hi
// Sam") put back into merge fields. The text of an email is never stored here.

import { parseCsv, csvDelimiter } from './commands/batch'
import { splitSubject, stripUnverifiedMarkers } from './send-to'

/** The most emails one run improves. */
export const MAX_EMAILS = 10

/** The server's longest message. */
export const MAX_MESSAGE_CHARS = 10_000

/** A touch's summary is cut to this many characters. */
export const TOUCH_SUMMARY_CHARS = 500

/** One email of a sequence. */
export interface SeqEmail {
  subject: string
  body: string
  sameThread: boolean
}

/** What the server is told about an earlier email of the sequence. */
export interface PriorTouch {
  on: string
  channel: 'email'
  summary: string
}

/** An email after a run: its subject (null for a reply) and its body. */
export interface FinalEmail {
  subject: string | null
  body: string
}

/** What a CSV with no step column is told. */
export const NO_STEPS = 'No email columns in this file. Name one column for each email, like step_1_body and step_2_body.'

const newEmail = (index: number, over: Partial<SeqEmail> = {}): SeqEmail => ({ subject: '', body: '', sameThread: index > 0, ...over })

const HEAD = /^\s*(?:#+\s*)?\**\s*(?:(?:email|step|touch|message|day|follow[ -]?up)\s*#?\s*\d+|follow[ -]?up)(?!\w)\s*(?:\([^)]*\))?\s*(?:[:.\-\u2013\u2014]\s*(.*?))?\s*\**\s*:?\s*$/i
const RULE = /^\s*-{3,}\s*$/
const TITLE_WORDS = 5

/**
 * A label line is a break only with no title or a short title (at most 5 words,
 * not ending in `.`, `?` or `!`), under 60 characters, so "Step 1: connect your
 * TMS." stays in its email. The console applies the same rule (isHead).
 */
function isLabel(line: string): boolean {
  if (line.trim().length >= 60) return false
  const m = HEAD.exec(line)
  if (!m) return false
  const title = (m[1] ?? '').trim()
  return !title || (title.split(/\s+/).length <= TITLE_WORDS && !/[.?!]$/.test(title))
}

const isHead = (line: string) => RULE.test(line) || isLabel(line)

/**
 * Split text into emails: a line of `---`, or a label line such as `Email 2`,
 * `Day 3` or `Step 2: Break-up email` (see isLabel), starts the next one. A leading `Subject:` line is
 * that email's subject. A part with no body is dropped.
 */
export function splitSequence(text: string): SeqEmail[] {
  const chunks: string[][] = []
  let cur: string[] | null = null
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (isHead(line)) {
      cur = []
      chunks.push(cur)
      continue
    }
    if (!cur) {
      cur = []
      chunks.push(cur)
    }
    cur.push(line)
  }
  return chunks
    .map((lines) => splitSubject(lines.join('\n').trim()))
    .filter((c) => c.body)
    .map((c, i) => newEmail(i, { subject: c.subject ?? '', body: c.body, sameThread: i > 0 && !c.subject }))
}

// Headers are compared after normHeader: lower case, punctuation and spaces as `_`.
const SUBJECT_HEADERS = ['subject', 'subject_line', 'email_subject', 'subjectline', 'betreff', 'objet', 'sujet', 'asunto', 'oggetto', 'onderwerp']
const BODY_HEADERS = [
  'body', 'message', 'email_body', 'content', 'text', 'copy', 'draft', 'note',
  'body_html', 'html_body', 'email_body_html', 'message_body', 'email_copy', 'body_text',
  'nachricht', 'inhalt', 'corps', 'mensaje', 'cuerpo', 'messaggio', 'testo', 'bericht',
]
const LINE_HEADERS = ['personalized_line', 'personalised_line', 'personalization', 'personalisation', 'personalized_opener', 'first_line', 'opener', 'icebreaker', 'ice_breaker', 'custom_line']
const CHANNEL_HEADERS = ['channel', 'type', 'medium']
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const STEP_HEADER = /^\uFEFF?\s*"?\s*(?:step|email|touch)[\s_-]*\d+/i

const normHeader = (h: string) =>
  h
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')

function stepOf(header: string): number | null {
  const m = header.match(/^(?:step|email|touch)_?(\d+)/)
  return m ? Number(m[1]) : null
}

const isBodyHeader = (h: string) =>
  BODY_HEADERS.includes(h) || /^(step|email|touch)_?\d+_?(body|message|copy|email)?(_html)?$/.test(h) || /(^|_)(body|message)(_html|_text)?$/.test(h)

function isAddressColumn(rows: string[][], c: number): boolean {
  const cells = rows.map((r) => (r[c] ?? '').trim()).filter(Boolean)
  return cells.length > 0 && cells.every((v) => ADDRESS.test(v))
}

/** The draft columns of a table: never the subject, the channel or an address column. */
function bodyColumns(header: string[], data: string[][]): number[] {
  const subjectCol = header.findIndex((h) => SUBJECT_HEADERS.includes(h))
  const channelCol = header.findIndex((h) => CHANNEL_HEADERS.includes(h))
  const where = (match: (h: string) => boolean) => header.flatMap((h, i) => (match(h) && i !== subjectCol && i !== channelCol && !isAddressColumn(data, i) ? [i] : []))
  const body = where(isBodyHeader)
  return body.length > 0 ? body : where((h) => LINE_HEADERS.includes(h)).slice(0, 1)
}

/**
 * The emails of this CLI's own `--csv` file (`Email,Subject,Message`, one email
 * for each row, numbered from 1), or null when the table is not that file.
 */
export function ownCsvEmails(rows: string[][]): FinalEmail[] | null {
  const header = (rows[0] ?? []).map(normHeader)
  if (header.length !== 3 || header[0] !== 'email' || header[1] !== 'subject' || header[2] !== 'message') return null
  const data = rows.slice(1).filter((r) => r.some((c) => c.trim()))
  if (data.length === 0 || !data.every((r, i) => (r[0] ?? '').trim() === String(i + 1))) return null
  const plain = (v: string) => v.trim().replace(/^'(?=[=+\-@\t\r])/, '')
  return data.map((r) => ({ subject: plain(r[1] ?? '') || null, body: plain(r[2] ?? '') }))
}

/** What a CSV read as: the emails, or the sentence that says why not. */
export type UploadRead = { ok: true; emails: SeqEmail[]; rows: number } | { ok: false; error: string }

/**
 * Read a CSV or TSV with one body column for each email (`step_1_body`,
 * `step_2_body`; also `email_2`, `touch_3`) and an optional subject column for
 * each (`step_1_subject`). The first row with any text is the sequence. A
 * header with one step column reads as a one-email sequence.
 */
export function emailsFromCsv(text: string): UploadRead {
  const { rows } = parseCsv(text, csvDelimiter(text))
  const own = ownCsvEmails(rows)
  if (own) return { ok: true, emails: own.map((f, i) => newEmail(i, { subject: f.subject ?? '', body: f.body, sameThread: i > 0 && !f.subject })), rows: 1 }
  const header = (rows[0] ?? []).map(normHeader)
  const data = rows.slice(1)
  let cols = bodyColumns(header, data)
  const rawHeader = rows[0] ?? []
  const stepish = rawHeader.findIndex((h) => STEP_HEADER.test(h))
  // One step column reads as a plain body column, so a one-email sequence still counts.
  if (cols.length === 0 && stepish >= 0) cols = [stepish]
  if (cols.length === 0 || (cols.length === 1 && !STEP_HEADER.test(rawHeader[cols[0] ?? 0] ?? ''))) return { ok: false, error: NO_STEPS }
  const subjectCol = header.findIndex((h) => SUBJECT_HEADERS.includes(h))
  const stepSubjects = new Map<number, number>()
  header.forEach((h, i) => {
    const step = stepOf(h)
    if (step !== null && /subject/.test(h)) stepSubjects.set(step, i)
  })
  const subjectFor = (c: number) => {
    const step = stepOf(header[c] ?? '')
    return step !== null && stepSubjects.has(step) ? (stepSubjects.get(step) as number) : subjectCol
  }
  const row = data.find((r) => cols.some((c) => (r[c] ?? '').trim()))
  if (!row) return { ok: false, error: NO_STEPS }
  const parts = cols.map((c) => {
    const raw = (row[c] ?? '').trim()
    if (!raw) return { subject: '', body: '' }
    const sc = subjectFor(c)
    const split = sc >= 0 ? { subject: (row[sc] ?? '').trim() || null, body: raw } : splitSubject(raw)
    return { subject: split.subject ?? '', body: split.body }
  })
  let last = parts.length - 1
  while (last >= 0 && !parts[last]?.body) last--
  const emails = parts.slice(0, last + 1).map((p, i) => newEmail(i, { subject: p.subject, body: p.body, sameThread: i > 0 && !p.subject }))
  const withText = data.filter((r) => cols.some((c) => (r[c] ?? '').trim())).length
  return { ok: true, emails, rows: withText }
}

/** Whether email `i` is sent with its subject: the first, or a new thread. */
export const showsSubject = (e: SeqEmail, i: number) => i === 0 || !e.sameThread

/** The text sent for email `i`: the subject rides as the first line when it has one. */
export function sentMessage(e: SeqEmail, i: number): string {
  const subject = showsSubject(e, i) ? e.subject.trim() || null : null
  const body = e.body.trim()
  return subject ? `Subject: ${subject}\n\n${body}` : body
}

/** The first email that cannot be sent, as its sentence, or null. */
export function emailProblem(emails: SeqEmail[]): string | null {
  for (let i = 0; i < emails.length; i++) {
    const email = emails[i] as SeqEmail
    if (!email.body.trim()) return `Email ${i + 1} is empty.`
    if (sentMessage(email, i).length > MAX_MESSAGE_CHARS) return `Email ${i + 1} is over 10,000 characters.`
  }
  return null
}

/** `now` as the local day, YYYY-MM-DD. */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * The email after a run. `improved` is the message the server returned, or null
 * when it wrote nothing (the typed email stands). A reply in the thread has no
 * subject of its own, so one the writer added is dropped.
 */
export function finalEmail(e: SeqEmail, i: number, improved: string | null): FinalEmail {
  const typed = showsSubject(e, i) ? e.subject.trim() || null : null
  if (improved === null) return { subject: typed, body: e.body.trim() }
  const { subject, body } = splitSubject(stripUnverifiedMarkers(improved))
  return { subject: showsSubject(e, i) ? (subject ?? typed) : null, body }
}

/** An email as one text: `Subject: ...`, a blank line, the body. */
export function emailText(f: FinalEmail): string {
  return f.subject ? `Subject: ${f.subject}\n\n${f.body}` : f.body
}

/** The earlier-email entry for `f`: today, email, its text cut to 500 characters. */
export function touchOf(f: FinalEmail, now = new Date()): PriorTouch {
  return { on: today(now), channel: 'email', summary: emailText(f).slice(0, TOUCH_SUMMARY_CHARS).trim() }
}

/** `{{x}}`, `{x}`, `[First Name]`, `%first_name%`. */
export const MERGE_FIELD = /\{\{\s*[^{}]+?\s*\}\}|\{[A-Za-z_][\w.\s]*\}|\[[A-Z][\w ]{1,30}\]|%[A-Za-z_]\w*%/g

/** Fill-in fields in `text`, as written, each once, in order of first use. */
export function fieldsOf(text: string): string[] {
  return [...new Set(text.match(MERGE_FIELD) ?? [])]
}

const fieldKey = (token: string) => token.replace(/\s+/g, '').toLowerCase()

/** The fields in the draft of email `i` (its subject only when it is sent) that its final text no longer has. */
export function lostFields(e: SeqEmail, i: number, final: FinalEmail): { had: string[]; lost: string[] } {
  const had = fieldsOf(`${showsSubject(e, i) ? e.subject : ''}\n${e.body}`)
  const kept = new Set(fieldsOf(emailText(final)).map(fieldKey))
  return { had, lost: had.filter((f) => !kept.has(fieldKey(f))) }
}

/** A cell that starts with = + - @ tab or CR gets a ' in front, so a spreadsheet does not run it. */
const FORMULA = /^[=+\-@\t\r]/

function quoteCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export const cell = (value: string) => quoteCell(FORMULA.test(value) ? `'${value}` : value)

/** The CSV a person saves: Email, Subject, Message; one row for each email; CRLF; no `<unverified>` marker. */
export function sequenceCsv(emails: FinalEmail[]): string {
  const rows = emails.map((e, i) => [String(i + 1), stripUnverifiedMarkers(e.subject ?? ''), stripUnverifiedMarkers(e.body)])
  return [['Email', 'Subject', 'Message'], ...rows].map((line) => line.map(cell).join(',')).join('\r\n')
}

/** `<name without .csv, .tsv, .txt or .md>-amdahl.csv`, or `sequence-amdahl.csv` with no source. */
export function sequenceFileName(source: string | null): string {
  const base = (source ?? 'sequence').replace(/\.(csv|tsv|txt|md)$/i, '')
  return `${base}-amdahl.csv`
}
