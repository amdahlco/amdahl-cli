// src/prompt-recipients.ts
//
// Sample recipients for `amdahl prompt`, as the API takes them: {recipient:
// {company, name?}, recipient_notes?, label}. They come from a CSV file
// (`--recipients people.csv`) or from the lines a person types in the guided
// questions. The columns and spellings are the console's (its CSV import,
// lib/optimizer/leads.ts): Company is required; Name (or a first and a last
// name) and notes are optional, and the console's "title" column stands in for
// notes when there is no notes column.

import { usageError } from './errors'
import { cutAtWord } from './text'
import { csvDelimiter, parseCsv } from './commands/batch'

const COMPANY = ['company', 'company_name', 'account', 'account_name', 'organization', 'organisation', 'organization_name']
const NAME = ['name', 'full_name', 'contact_name', 'person_name', 'contact']
const FIRST = ['first_name', 'firstname', 'first', 'given_name', 'contact_first_name']
const LAST = ['last_name', 'lastname', 'last', 'surname', 'family_name', 'contact_last_name']
const NOTES = ['notes', 'recipient_notes', 'note']
const EMAIL = ['email', 'email_address', 'work_email', 'contact_email']
const DOMAIN = ['domain', 'company_domain', 'website_domain', 'account_domain']
const TITLE = ['title', 'job_title', 'position', 'role', 'person_title', 'headline']

/** The server's cap on a label (amdahl-app messages/_promptRecipients.ts, MAX_LABEL_CHARS). */
const MAX_LABEL_CHARS = 200

/** One recipient as the API takes it. `email` and `domain` are the recipient's own fields, which the server reads too. */
export function recipientItem(company: string, name: string, notes: string, email = '', domain = ''): Record<string, unknown> {
  return {
    recipient: { company, ...(name ? { name } : {}), ...(email ? { email } : {}), ...(domain ? { domain } : {}) },
    ...(notes ? { recipient_notes: notes } : {}),
    label: cutAtWord(name ? `${name}, ${company}` : company, MAX_LABEL_CHARS),
  }
}

/** True for a file the CLI reads as a CSV: by its extension. */
export function isCsvPath(path: string): boolean {
  return /\.csv$/i.test(path)
}

/**
 * The recipients in a CSV with a header row. A file with no company column is refused before
 * anything is sent, naming the column; so is a row with no company.
 */
export function recipientsFromCsv(path: string, text: string): Record<string, unknown>[] {
  const { rows, lines } = parseCsv(text, csvDelimiter(text))
  const [header, ...body] = rows
  if (!header) throw usageError(`--recipients ${path} is empty.`)
  const names = header.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'))
  const at = (aliases: string[]) => names.findIndex((n) => aliases.includes(n))
  const company = at(COMPANY)
  if (company < 0) {
    throw usageError(`--recipients ${path} needs a "company" column.`, 'The first row must name the columns. Required: company. Optional: name, email, domain, notes.')
  }
  const name = at(NAME)
  const first = at(FIRST)
  const last = at(LAST)
  const notes = at(NOTES)
  const title = at(TITLE)
  const email = at(EMAIL)
  const domain = at(DOMAIN)
  // Excel pads a sheet with rows of commas: a row with every cell empty is not a person.
  const people = body.map((row, i) => ({ row, line: lines[i + 1] })).filter(({ row }) => row.some((c) => c.trim() !== ''))
  if (people.length === 0) throw usageError(`--recipients ${path} has a header row and no people.`)
  return people.map(({ row, line }) => {
    if (row.length !== names.length) throw usageError(`Line ${line} of ${path} has ${row.length} cells; the header has ${names.length}.`)
    const cell = (k: number) => (k >= 0 ? (row[k] ?? '').trim() : '')
    const who = cell(company)
    if (!who) throw usageError(`Line ${line} of ${path} has no company.`)
    const person = cell(name) || [cell(first), cell(last)].filter(Boolean).join(' ')
    return recipientItem(who, person, cell(notes) || cell(title), cell(email), cell(domain))
  })
}

/**
 * One typed line: `Company`, `Company | Name` or `Company | Name | what you know about them`; a tab
 * also splits. A line with neither is the company alone, commas and all. Null for no company.
 */
export function recipientFromLine(line: string): Record<string, unknown> | null {
  const [company = '', name = '', ...rest] = line.split(/\s*[|\t]\s*/).map((part) => part.trim())
  if (!company) return null
  return recipientItem(company, name, rest.filter(Boolean).join(' | '))
}
