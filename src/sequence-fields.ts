// src/sequence-fields.ts
//
// `amdahl sequence --leads`: the fill-in fields of the emails ({{first_name}}),
// which column of the lead list fills each, and how each person's email gets
// them filled in. Copied BY HAND from amdahl-frontend, apps/universal-ui/lib/
// optimizer/sequence-fields.ts and sequence-people.ts (matchFields, unmatched,
// emptyFor, needsLook, fillFor) at commit d9a53a2b9 (#2286). A change in the
// console is not caught here: make it in both places.

import type { Lead } from './lead-people'
import { MERGE_FIELD, showsSubject, type SeqEmail } from './sequence-parse'

type FieldKey = 'first_name' | 'last_name' | 'company' | 'title' | 'city' | 'personal_line' | 'sender'

const NAMES: Record<FieldKey, string[]> = {
  first_name: ['first_name', 'firstname', 'fname', 'first', 'given_name', 'name'],
  last_name: ['last_name', 'lastname', 'surname', 'lname', 'family_name'],
  company: ['company', 'company_name', 'companyname', 'account', 'account_name', 'organization', 'organisation', 'organization_name'],
  title: ['title', 'job_title', 'jobtitle', 'role', 'position'],
  city: ['city', 'location'],
  personal_line: ['icebreaker', 'ice_breaker', 'personalization', 'personalisation', 'personalized_line', 'personalised_line', 'personal_line', 'opener', 'opening_line', 'first_line', 'custom_line'],
  sender: ['sender', 'sender_name', 'my_name', 'signature', 'sending_account_first_name', 'sending_account_name'],
}

const PERSON_PREFIX = /^(?:contact|lead|prospect|recipient|person)\./i
const COMPANY_NAME = /^(?:company|account|organi[sz]ation)\.name$/i

function normName(raw: string): string {
  const inner = (
    raw
      .replace(/^\{\{\s*|\s*\}\}$/g, '')
      .replace(/^[{[%]|[}\]%]$/g, '')
      .split('|')[0] ?? ''
  ).trim()
  const name = COMPANY_NAME.test(inner) ? 'company' : inner.replace(PERSON_PREFIX, '')
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
}

/** A fill-in field: its key (`first_name`, or `x:<name>` for one Amdahl does not know), and whether it is known. */
export function fieldOf(token: string): { key: string; known: boolean } {
  const name = normName(token)
  for (const key of Object.keys(NAMES) as FieldKey[]) {
    if (NAMES[key].includes(name) || NAMES[key].includes(name.replace(/_/g, ''))) return { key, known: true }
  }
  return { key: `x:${name || token}`, known: false }
}

/** The list column that fills a field, or -1. A known field tries its likeliest names first, so "First Name" wins over "Name". */
export function columnFor(key: string, headers: string[]): number {
  const names = (NAMES as Record<string, string[] | undefined>)[key]
  if (!names) return headers.findIndex((h) => fieldOf(h).key === key)
  const norm = headers.map(normName)
  for (const n of names) {
    const at = norm.findIndex((h) => h === n || h.replace(/_/g, '') === n)
    if (at >= 0) return at
  }
  return -1
}

/** A field in the emails: its key, how the emails write it (`{{first_name}}`) and which emails use it (from 0). */
export interface SequenceField {
  key: string
  token: string
  emails: number[]
}

/** The fields of the emails (a subject counts only when it is sent), in order of first use. */
export function fieldsIn(emails: SeqEmail[]): SequenceField[] {
  const found = new Map<string, SequenceField>()
  emails.forEach((e, i) => {
    const text = `${showsSubject(e, i) ? e.subject : ''}\n${e.body}`
    for (const m of text.matchAll(new RegExp(MERGE_FIELD))) {
      const { key } = fieldOf(m[0])
      const have = found.get(key)
      if (!have) found.set(key, { key, token: m[0].replace(/\s+/g, ''), emails: [i] })
      else if (!have.emails.includes(i)) have.emails.push(i)
    }
  })
  return [...found.values()]
}

/** "column" fills from a column, and `text` fills the people whose cell is empty. "same" puts `text` in for everyone. "left" leaves it out. */
export type FieldUse = 'column' | 'left' | 'same'

export interface FieldMatch {
  key: string
  token: string
  emails: number[]
  use: FieldUse
  column: number
  text: string
}

/** First name starts as "there", so a person with no first name still reads "Hi there,". */
export const startText = (key: string) => (key === 'first_name' ? 'there' : '')

export function matchFields(fields: SequenceField[], headers: string[]): FieldMatch[] {
  return fields.map((f) => ({ ...f, use: 'column', column: columnFor(f.key, headers), text: startText(f.key) }))
}

/** A field with nothing to fill it from. */
export const unmatched = (m: FieldMatch) => (m.use === 'column' && m.column < 0) || (m.use === 'same' && !m.text.trim())

/** How many people have an empty cell in the field's column. */
export function emptyFor(m: FieldMatch, leads: readonly Lead[]): number {
  if (m.use !== 'column' || m.column < 0) return 0
  return leads.filter((l) => !(l.cells[m.column] ?? '').trim()).length
}

/** Whether any field needs a look: no column, or a column empty for some people. */
export const needsLook = (matches: readonly FieldMatch[], leads: readonly Lead[]) => matches.some((m) => unmatched(m) || emptyFor(m, leads) > 0)

function tidy(text: string): string {
  return text
    .replace(/[ \t]+(?=[,.!?;:])/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** `text` with each fill-in field replaced for this person; a field the matches do not name stays as written. */
export function fillFor(text: string, lead: Lead, matches: readonly FieldMatch[]): string {
  if (!text) return text
  const filled = text.replace(new RegExp(MERGE_FIELD), (token) => {
    const m = matches.find((x) => x.key === fieldOf(token).key)
    if (!m) return token
    if (m.use === 'left') return ''
    if (m.use === 'same') return m.text.trim()
    const value = m.column >= 0 ? (lead.cells[m.column] ?? '').trim() : ''
    return value || m.text.trim()
  })
  return tidy(filled)
}
