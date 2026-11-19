// src/lead-people.ts
//
// `amdahl sequence --leads`: reading a lead list as the console does, and
// building the batch item for one person. Copied BY HAND from amdahl-frontend,
// apps/universal-ui/lib/optimizer/leads.ts at commit d9a53a2b9 (#2286): the
// column names, the rule for what counts as a person, the recipient and the
// item. Not copied: a list's own draft column is never read (the email for
// each person is the sequence's), and the word limit and kept-ask rules, which
// this command does not take. A change in the console is not caught here: make
// it in both places.

import { csvDelimiter, parseCsv } from './commands/batch'
import { draftFitProblem, withDraftFacts } from './draft-facts'
import { RESERVED_KEYS, domainOf, rowFacts } from './lead-facts'
import { autoMap, draftColumn, norm, type LeadMap } from './send-to'

/** The most people one run takes (the server's batch cap). */
export const MAX_LEADS = 500

/** The list's identity columns, and the list's own draft column (-1 for none), which is left out of the facts. */
export type PeopleMap = LeadMap & { title: number; domain: number; draft: number }

const TITLE_NAMES = ['title', 'job_title', 'position', 'role', 'person_title', 'headline']
const DOMAIN_NAMES = ['website', 'domain', 'company_domain', 'company_website', 'website_url', 'company_url']

export interface LeadTable {
  fileName: string
  headers: string[]
  rows: string[][]
  map: PeopleMap
}

export interface Lead {
  /** The row in the list, from 2 (row 1 is the header). */
  row: number
  cells: string[]
  email: string
  name: string
  first: string
  company: string
  title: string
  domain: string
  linkedin: string
  /** The email being improved for this person, set for each request. */
  draft: string
}

export interface PeopleList {
  table: LeadTable
  leads: Lead[]
  /** Rows with no email, name, company or LinkedIn. */
  skipped: number
  /** People past the first 500. */
  overCap: number
}

export const NOT_PEOPLE = 'No people in this file. It needs an email, LinkedIn, or name and company column.'

function peopleMap(headers: string[], rows: string[][]): PeopleMap {
  const n = headers.map(norm)
  return { ...autoMap(headers), title: n.findIndex((h) => TITLE_NAMES.includes(h)), domain: n.findIndex((h) => DOMAIN_NAMES.includes(h)), draft: draftColumn(headers, rows) }
}

const isLeadMap = (map: PeopleMap) => map.email >= 0 || map.linkedin >= 0 || (map.company >= 0 && (map.name >= 0 || map.first >= 0))

/** A lead list, or null when the file has no people columns or no rows. */
export function readLeadTable(text: string, fileName: string): LeadTable | null {
  const rows = parseCsv(text, csvDelimiter(text)).rows
  if (rows.length < 2) return null
  const headers = (rows[0] ?? []).map((h) => h.replace(/^\uFEFF/, '').trim())
  const body = rows.slice(1)
  const map = peopleMap(headers, body)
  return isLeadMap(map) ? { fileName, headers, rows: body, map } : null
}

/** The people in a list file, or the sentence that says why there are none. */
export function readPeople(text: string, fileName: string): { ok: true; list: PeopleList } | { ok: false; error: string } {
  const table = readLeadTable(text, fileName)
  if (!table) return { ok: false, error: NOT_PEOPLE }
  const { map } = table
  const leads: Lead[] = []
  let skipped = 0
  table.rows.forEach((cells, i) => {
    const cell = (at: number) => (at >= 0 ? (cells[at] ?? '').trim() : '')
    const first = cell(map.first)
    const name = cell(map.name) || [first, cell(map.last)].filter(Boolean).join(' ')
    const lead: Lead = {
      row: i + 2,
      cells,
      email: cell(map.email),
      name,
      first: first || name.split(/\s+/)[0] || '',
      company: cell(map.company),
      title: cell(map.title),
      domain: cell(map.domain),
      linkedin: cell(map.linkedin),
      draft: '',
    }
    if (!lead.email && !lead.name && !lead.company && !lead.linkedin) skipped += 1
    else leads.push(lead)
  })
  if (leads.length === 0) return { ok: false, error: 'Every row in this file is empty.' }
  return { ok: true, list: { table, leads: leads.slice(0, MAX_LEADS), skipped, overCap: Math.max(0, leads.length - MAX_LEADS) } }
}

/** A person as the list names them: name, else company, else email, else the row. */
export const leadLabel = (lead: Lead) => lead.name || lead.company || lead.email || `Row ${lead.row}`

const RECIPIENT_MAX = { email: 320, name: 200, company: 200, domain: 253, linkedin_url: 300 } as const
const MAX_ATTRIBUTES = 100
const MAX_ATTRIBUTE_KEY = 100
const MAX_ATTRIBUTE_VALUE = 1000

/** The batch item's `recipient`: the identity columns, and every other filled cell as an attribute. */
export function recipientOf(lead: Lead, table: LeadTable): Record<string, unknown> {
  const r: Record<string, unknown> = {}
  const put = (key: keyof typeof RECIPIENT_MAX, value: string) => {
    const v = value.trim()
    if (v && v.length <= RECIPIENT_MAX[key]) r[key] = v
  }
  put('email', lead.email)
  put('name', lead.name)
  put('company', lead.company)
  put('domain', domainOf(lead.domain))
  put('linkedin_url', lead.linkedin)
  const used = new Set(Object.values(table.map).filter((i) => i >= 0))
  const attributes: Record<string, string> = {}
  if (lead.title) attributes.title = lead.title.slice(0, MAX_ATTRIBUTE_VALUE)
  table.headers.forEach((header, i) => {
    if (used.has(i) || Object.keys(attributes).length >= MAX_ATTRIBUTES) return
    const value = (lead.cells[i] ?? '').trim()
    const key = header.trim().slice(0, MAX_ATTRIBUTE_KEY)
    if (!value || !key || key in attributes) return
    if (RESERVED_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) return
    attributes[key] = value.slice(0, MAX_ATTRIBUTE_VALUE)
  })
  if (Object.keys(attributes).length > 0) r.attributes = attributes
  return r
}

/**
 * One person's batch item: their row as `recipient` and facts, the email as
 * `message` (and as facts, with one rule: see draft-facts.ts), and `rules`.
 * No `message` when `draft` is empty. Throws a plain sentence when the email
 * does not fit beside the row's facts.
 */
export function leadItem(lead: Lead, table: LeadTable, rules: string[]): Record<string, unknown> {
  const fit = withDraftFacts({ facts: rowFacts(lead, table, table.map, []), rules }, lead.draft)
  if (!fit.ok) throw new Error(draftFitProblem(fit))
  const { facts, rules: all } = fit.context
  const context = { ...(all.length > 0 ? { rules: all } : {}), ...(facts.length > 0 ? { facts } : {}) }
  return {
    item_id: `row-${lead.row}`,
    channel: 'email',
    recipient: recipientOf(lead, table),
    ...(Object.keys(context).length > 0 ? { context } : {}),
    ...(lead.draft ? { message: lead.draft } : {}),
  }
}

/** The row an item came back for: `row-7` is 7; an item with no id is its place plus 2. */
export function rowOfItem(itemId: unknown, index: number): number {
  const m = typeof itemId === 'string' ? /^row-(\d+)$/.exec(itemId) : null
  return m ? Number(m[1]) : index + 2
}

/** How many people share an email address with another person in the list (an empty address is no address). */
export function sharedEmails(leads: readonly Lead[]): number {
  const seen = new Map<string, number>()
  for (const lead of leads) {
    const key = lead.email.trim().toLowerCase()
    if (key) seen.set(key, (seen.get(key) ?? 0) + 1)
  }
  return [...seen.values()].filter((c) => c > 1).reduce((sum, c) => sum + c, 0)
}
