// src/send-to.ts
//
// `amdahl optimize --list <file.csv> --for <tool>`: the messages Amdahl wrote,
// as one CSV a sequencer can import, and the three lines that say how to import
// it. The console's "Send to" writes the same file for the same list, so the
// presets, the header names, the variable syntax and the rules for which lead is
// left out are copied BY HAND from amdahl-frontend,
// apps/universal-ui/lib/optimizer/send-to/presets.ts and build.ts, as they were
// at amdahl-frontend commit 2a47d5612 (#2180), plus the spec change from the
// review of this CLI (no formula guard, Amdahl's own input columns dropped).
// Nothing here runs the console's code. __tests__/send-to.test.ts compares the
// CLI with values copied from the console's own test (e2e-stub/optimizer-send-to.spec.ts
// at that commit) and with each tool's header names and variable syntax typed
// out again in the test. A change in the console is not caught here: make it
// in both places. The vendor docs each preset follows are listed in presets.ts.
//
// Only leads Amdahl wrote are in the file. A failed lead, a lead that needed
// input, one not written and one with no contact for the channel are left out,
// and counted. The list's own columns follow Amdahl's, in their order, except
// the ones Amdahl reads itself (AMDAHL_INPUT_COLUMNS). No cell gets a `'` guard:
// a sequencer imports a value as it is, so a `'` would reach the email or the
// phone number.

import { basename } from 'node:path'
import { usageError } from './errors'

export type Channel = 'email' | 'linkedin'

/** The tool ids the console and the API share; gmail and outlook have no import file. */
export const SEND_TO_IDS = ['instantly', 'smartlead', 'lemlist', 'heyreach', 'reply_io', 'apollo', 'outreach', 'salesloft', 'hubspot', 'lgm', 'woodpecker', 'other'] as const
export type SendToId = (typeof SEND_TO_IDS)[number]

type IdentityKey = 'first_name' | 'last_name' | 'company' | 'linkedin_url'

export interface SendToPreset {
  id: SendToId
  label: string
  channels: readonly Channel[]
  needsNames?: boolean
  headers?: Partial<Record<IdentityKey, string>>
  where: string
  match: (channel: Channel) => string
  insert: string
  note?: string
  maxValue?: number
  variable: (column: string) => string
}

const braces = (column: string) => `{{${column}}}`
const name = (column: string) => column
const single = (column: string) => `{${column}}`
const PASTE = 'Paste into your step'
const MENU = 'Add them from the variable menu in your step'

const cols = (channel: Channel, to: string) => (channel === 'email' ? `amdahl_subject and amdahl_message ${to}` : `amdahl_message ${to}`)
const key = (channel: Channel, email: string, linkedin: string) => (channel === 'linkedin' ? linkedin : email)

export const SEND_TO_PRESETS: readonly SendToPreset[] = [
  {
    id: 'instantly',
    label: 'Instantly',
    channels: ['email'],
    headers: { company: 'company_name' },
    where: 'In your campaign, open Leads and choose Upload CSV.',
    match: (c) => `Map email to Email, and ${cols(c, 'to custom variables')}.`,
    insert: PASTE,
    variable: braces,
  },
  {
    id: 'smartlead',
    label: 'Smartlead',
    channels: ['email'],
    headers: { company: 'company_name' },
    where: 'Engage > Campaigns > your campaign > Import Leads > Import CSV.',
    match: (c) => `Map email to Email, and ${cols(c, 'to custom variables')}.`,
    insert: PASTE,
    variable: braces,
  },
  {
    id: 'lemlist',
    label: 'lemlist',
    channels: ['email', 'linkedin'],
    headers: { first_name: 'firstName', last_name: 'lastName', company: 'companyName', linkedin_url: 'linkedinUrl' },
    where: 'In your campaign, open Leads list > Import new leads > CSV.',
    match: (c) => `${key(c, 'email', 'linkedinUrl')} and the name columns map on their own. ${cols(c, 'become custom variables')}.`,
    insert: PASTE,
    maxValue: 2000,
    variable: braces,
  },
  {
    id: 'heyreach',
    label: 'HeyReach',
    channels: ['linkedin'],
    needsNames: true,
    where: 'Leads > Add Leads > Import from CSV.',
    match: () => 'Map linkedin_url to the profile URL. Add a custom variable from amdahl_message.',
    insert: 'Name the variable amdahl_message, set a fallback value for it, then paste',
    note: 'HeyReach does not document the exact form of a variable in a message, so add it from the Add variable menu in your step if {amdahl_message} does not work.',
    variable: single,
  },
  {
    id: 'reply_io',
    label: 'Reply.io',
    channels: ['email', 'linkedin'],
    where: 'Add contacts > Import from a CSV file.',
    match: (c) => `Map ${key(c, 'email to Email', 'linkedin_url to LinkedIn')}. Create a custom field for ${c === 'email' ? 'each of amdahl_subject and amdahl_message' : 'amdahl_message'}.`,
    insert: PASTE,
    variable: braces,
  },
  {
    id: 'apollo',
    label: 'Apollo',
    channels: ['email'],
    where: 'Import a CSV of contacts.',
    match: () => 'Map email to Email. Create a custom contact field for amdahl_subject and one for amdahl_message, then map to them.',
    insert: MENU,
    variable: name,
  },
  {
    id: 'outreach',
    label: 'Outreach',
    channels: ['email'],
    where: 'Actions > Bulk Create > Prospects.',
    match: () => 'Map email to Email, amdahl_subject to Custom 1 and amdahl_message to Custom 2.',
    insert: PASTE,
    variable: (column) => (column === 'amdahl_subject' ? '{{custom1}}' : '{{custom2}}'),
  },
  {
    id: 'salesloft',
    label: 'Salesloft',
    channels: ['email'],
    where: 'People > Create People > Import from CSV.',
    match: () => 'Map email to Email Address. An admin first adds a person field for amdahl_subject and one for amdahl_message, then you map to them.',
    insert: MENU,
    variable: name,
  },
  {
    id: 'hubspot',
    label: 'HubSpot',
    channels: ['email'],
    where: 'Contacts > Import, then upload the CSV.',
    match: () => 'Map email to Email. Choose Create new property for amdahl_subject and for amdahl_message.',
    insert: 'Add them with Personalize in your sequence email',
    note: 'HubSpot sequences can drop line breaks from a multi-line property, so check one email before you enroll.',
    variable: name,
  },
  {
    id: 'lgm',
    label: 'La Growth Machine',
    channels: ['linkedin'],
    where: 'Leads > Import leads > Import CSV.',
    match: () => 'Map linkedin_url to the profile URL. Import amdahl_message as a custom attribute.',
    insert: 'Add it from the variable menu in your step',
    note: 'La Growth Machine does not document the exact form of a custom attribute, so copy it from its menu.',
    variable: name,
  },
  {
    id: 'woodpecker',
    label: 'Woodpecker',
    channels: ['email'],
    where: 'In your campaign, choose Add prospects > Import.',
    match: () => 'Map email to Email, amdahl_subject to Snippet 1 and amdahl_message to Snippet 2.',
    insert: 'Add them with the {{ }} button in your step',
    variable: (column) => (column === 'amdahl_subject' ? 'Snippet 1' : 'Snippet 2'),
  },
  {
    id: 'other',
    label: 'Other (any tool)',
    channels: ['email', 'linkedin'],
    where: 'Use the CSV import for leads in your tool.',
    match: (c) => `${key(c, 'Map email to your email field', 'Map linkedin_url to your profile URL field')}, and ${cols(c, 'to custom fields')}.`,
    insert: 'Paste into your step (most tools use this form)',
    variable: braces,
  },
]

/** The preset a `--for` value names: its id, in any case, with `-` for `_` (reply-io). */
export function presetFor(value: string): SendToPreset | undefined {
  const id = value.trim().toLowerCase().replace(/-/g, '_')
  return SEND_TO_PRESETS.find((p) => p.id === id)
}

export const subjectColumn = 'amdahl_subject'
export const messageColumn = 'amdahl_message'

// ---- Reading the list's columns, as the console's lead reader does ----

type LeadField = 'email' | 'first' | 'last' | 'name' | 'company' | 'linkedin'

/** Each field's column in the list's header, or -1. */
export type LeadMap = Record<LeadField, number>

const LEAD_FIELDS: ReadonlyArray<{ key: LeadField; names: readonly string[] }> = [
  { key: 'email', names: ['email', 'email_address', 'work_email', 'e_mail', 'contact_email', 'person_email', 'business_email'] },
  { key: 'first', names: ['first_name', 'firstname', 'first', 'given_name', 'contact_first_name'] },
  { key: 'last', names: ['last_name', 'lastname', 'last', 'surname', 'family_name', 'contact_last_name'] },
  { key: 'name', names: ['name', 'full_name', 'contact_name', 'person_name', 'contact'] },
  { key: 'company', names: ['company', 'company_name', 'account', 'account_name', 'organization', 'organisation', 'organization_name'] },
  { key: 'linkedin', names: ['linkedin', 'linkedin_url', 'linkedin_profile', 'person_linkedin_url', 'li_url', 'linkedin_profile_url'] },
]

const norm = (h: string) =>
  h
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')

/** Which column holds each identity field, by the header in any common spelling. */
export function autoMap(headers: string[]): LeadMap {
  const n = headers.map(norm)
  const map = {} as LeadMap
  for (const f of LEAD_FIELDS) map[f.key] = n.findIndex((h) => f.names.includes(h))
  return map
}

interface Lead {
  cells: string[]
  email: string
  name: string
  company: string
  linkedin: string
}

function leadOf(cells: string[], map: LeadMap): Lead {
  const cell = (k: LeadField) => (map[k] >= 0 ? (cells[map[k]] ?? '').trim() : '')
  const first = cell('first')
  return { cells, email: cell('email'), name: cell('name') || [first, cell('last')].filter(Boolean).join(' '), company: cell('company'), linkedin: cell('linkedin') }
}

// ---- Reading what Amdahl wrote ----

/** Drops the backend's claim-grounding markers and keeps the text inside them: what a person pastes into a real email. */
export function stripUnverifiedMarkers(text: string): string {
  const open = '<unverified>'
  const close = '</unverified>'
  if (!text.includes(open) && !text.includes(close)) return text
  return text
    .replace(/<unverified>([\s\S]*?)<\/unverified>/g, '$1')
    .split(open)
    .join('')
    .split(close)
    .join('')
}

/** A leading `Subject: ...` line split off an email. */
export function splitSubject(text: string): { subject: string | null; body: string } {
  const m = text.match(/^\s*subject\s*:\s*(.*)\r?\n/i)
  if (!m) return { subject: null, body: text.trim() }
  return { subject: m[1]?.trim() || null, body: text.slice(m[0].length).trim() }
}

/** What one list row came back as: a message, or why there is none. */
export type Written = { kind: 'written'; subject: string; body: string } | { kind: 'failed' } | { kind: 'unwritten' } | { kind: 'needs_input' }

/** One batch item (as the server returns it), read the way the console reads a lead's result. */
export function writtenOf(item: Record<string, unknown> | undefined): Written {
  const result = item?.result && typeof item.result === 'object' && !Array.isArray(item.result) ? (item.result as Record<string, unknown>) : null
  if (item?.status === 'failed' || result?.ok === false) return { kind: 'failed' }
  if (!item || item.status !== 'done' || !result) return { kind: 'unwritten' }
  if (result.outcome === 'needs_input') return { kind: 'needs_input' }
  if (typeof result.message !== 'string') return { kind: 'unwritten' }
  const { subject, body } = splitSubject(stripUnverifiedMarkers(result.message))
  return { kind: 'written', subject: subject ?? '', body }
}

// ---- Building the file ----

export interface LeftOut {
  failed: number
  unwritten: number
  needsInput: number
  noContact: number
}

export interface SendToFile {
  name: string
  csv: string
  ready: number
  leftOut: LeftOut
  overLimit: number
}

/** One CSV cell, quoted where it must be. It is never changed: a sequencer imports a value raw, so no `'` guard. */
export function cell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** The list columns Amdahl reads itself (by header, trimmed and lowercased, as the list reader does). They stay out of the import file. */
export const AMDAHL_INPUT_COLUMNS: readonly string[] = ['message', 'channel', 'evidence', 'on_unsupported', 'facts', 'rules', 'item_id']

/** A header as lowercase snake_case ASCII. */
export function snakeHeader(header: string): string {
  return header
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** `<list-name>-<tool>.csv`: `q4 leads.csv` for lemlist is `q4-leads-lemlist.csv`. */
export function sendToFileName(listPath: string, preset: SendToPreset): string {
  const list = basename(listPath).replace(/\.(csv|tsv|txt)$/i, '')
  const base = snakeHeader(list).replace(/_/g, '-') || 'leads'
  return `${base}-${preset.id.replace(/_/g, '-')}.csv`
}

function namesOf(lead: Lead, map: LeadMap): { first: string; last: string } {
  const at = (field: 'first' | 'last') => (map[field] >= 0 ? (lead.cells[map[field]] ?? '').trim() : '')
  const parts = lead.name.split(/\s+/).filter(Boolean)
  return { first: at('first') || parts[0] || '', last: at('last') || (map.last >= 0 ? '' : parts.slice(1).join(' ')) }
}

function hasContact(lead: Lead, map: LeadMap, channel: Channel, preset: SendToPreset): boolean {
  if (channel === 'email') return Boolean(lead.email)
  if (!lead.linkedin) return false
  if (!preset.needsNames) return true
  const { first, last } = namesOf(lead, map)
  return Boolean(first && last)
}

interface Column {
  name: string
  value: (written: Extract<Written, { kind: 'written' }>, lead: Lead) => string
}

function identityColumns(map: LeadMap, preset: SendToPreset): { columns: Column[]; used: Set<number> } {
  const used = new Set<number>()
  const columns: Column[] = []
  const head = (k: IdentityKey) => preset.headers?.[k] ?? k
  const take = (...fields: LeadField[]) => fields.forEach((f) => map[f] >= 0 && used.add(map[f]))
  if (map.email >= 0) {
    take('email')
    columns.push({ name: 'email', value: (_, l) => l.email })
  }
  if (map.name >= 0 || map.first >= 0) {
    take('first', 'last')
    columns.push({ name: head('first_name'), value: (_, l) => namesOf(l, map).first })
    columns.push({ name: head('last_name'), value: (_, l) => namesOf(l, map).last })
  }
  if (map.company >= 0) {
    take('company')
    columns.push({ name: head('company'), value: (_, l) => l.company })
  }
  if (map.linkedin >= 0) {
    take('linkedin')
    columns.push({ name: head('linkedin_url'), value: (_, l) => l.linkedin })
  }
  return { columns, used }
}

function otherColumns(headers: string[], used: Set<number>, taken: Set<string>): Column[] {
  const out: Column[] = []
  headers.forEach((header, i) => {
    if (used.has(i) || AMDAHL_INPUT_COLUMNS.includes(header.trim().toLowerCase())) return
    const base = snakeHeader(header) || `column_${i + 1}`
    let columnName = base
    for (let n = 2; taken.has(columnName); n += 1) columnName = `${base}_${n}`
    taken.add(columnName)
    out.push({ name: columnName, value: (_, l) => l.cells[i] ?? '' })
  })
  return out
}

export interface SendToInput {
  /** The list's file path, for the file name. */
  path: string
  /** The list's header row, as read (a BOM already gone). */
  headers: string[]
  /** One entry per list row, in order: its cells, and what Amdahl wrote for it. */
  rows: { cells: string[]; written: Written }[]
  channel: Channel
  preset: SendToPreset
}

/** The import file for one tool: only the written leads, with a contact for the channel. */
export function buildSendToFile({ path, headers: raw, rows, channel, preset }: SendToInput): SendToFile {
  const headers = raw.map((h) => h.replace(/^\uFEFF/, '').trim())
  const map = autoMap(headers)
  const leftOut: LeftOut = { failed: 0, unwritten: 0, needsInput: 0, noContact: 0 }
  const ready: Array<{ written: Extract<Written, { kind: 'written' }>; lead: Lead }> = []
  for (const row of rows) {
    const lead = leadOf(row.cells, map)
    const written = row.written
    if (written.kind === 'failed') leftOut.failed += 1
    else if (written.kind === 'unwritten') leftOut.unwritten += 1
    else if (written.kind === 'needs_input') leftOut.needsInput += 1
    else if (!hasContact(lead, map, channel, preset)) leftOut.noContact += 1
    else ready.push({ written, lead })
  }
  const identity = identityColumns(map, preset)
  const taken = new Set<string>([...identity.columns.map((c) => c.name), subjectColumn, messageColumn])
  const columns: Column[] = [
    ...identity.columns,
    ...(channel === 'email' ? [{ name: subjectColumn, value: (w: Extract<Written, { kind: 'written' }>) => w.subject }] : []),
    { name: messageColumn, value: (w: Extract<Written, { kind: 'written' }>) => w.body },
    ...otherColumns(headers, identity.used, taken),
  ]
  const lines = ready.map(({ written, lead }) => columns.map((c) => cell(c.value(written, lead).replace(/\r\n?/g, '\n'))).join(','))
  const overLimit = preset.maxValue ? ready.filter(({ written }) => written.body.length > (preset.maxValue ?? 0)).length : 0
  return {
    name: sendToFileName(path, preset),
    csv: [columns.map((c) => c.name).join(','), ...lines].join('\r\n'),
    ready: ready.length,
    leftOut,
    overLimit,
  }
}

/** `3 left out: 1 failed, 2 with no email.`, or null when none was left out. */
export function leftOutLine(left: LeftOut, channel: Channel, preset: SendToPreset): string | null {
  const total = left.failed + left.unwritten + left.needsInput + left.noContact
  if (total === 0) return null
  const missing = channel === 'email' ? 'email' : preset.needsNames ? 'LinkedIn URL or full name' : 'LinkedIn URL'
  const parts = [
    left.failed ? `${left.failed} failed` : null,
    left.unwritten ? `${left.unwritten} not written yet` : null,
    left.needsInput ? `${left.needsInput} needed input` : null,
    left.noContact ? `${left.noContact} with no ${missing}` : null,
  ].filter((p): p is string => p !== null)
  return `${total} left out: ${parts.join(', ')}.`
}

/** The three steps for a tool, then any note: where to import, what to map, what to paste. */
export function guideLines(preset: SendToPreset, channel: Channel): string[] {
  const email = channel === 'email'
  const variables = [...(email ? [`Subject ${preset.variable(subjectColumn)}`] : []), `${email ? 'Body' : 'Message'} ${preset.variable(messageColumn)}`]
  return [`Import: ${preset.where}`, preset.match(channel), `${preset.insert}: ${variables.join(', ')}`]
}

/** `2 messages ready for lemlist` (or `ready to import` for any tool). */
export function readyLine(ready: number, preset: SendToPreset): string {
  return `${ready} ${ready === 1 ? 'message' : 'messages'} ready ${preset.id === 'other' ? 'to import' : `for ${preset.label}`}`
}

/** `1 message is over lemlist's 2,000 character limit for a variable.` */
export function overLimitLine(over: number, preset: SendToPreset): string {
  return `${over} ${over === 1 ? 'message is' : 'messages are'} over ${preset.label}'s ${(preset.maxValue ?? 0).toLocaleString('en-US')} character limit for a variable.`
}

// ---- Checking the list and the tool before anything is sent ----

export interface SendToPlan {
  preset: SendToPreset
  /** The channel the file is for, and the one batch items that name none are sent with. */
  channel: Channel
}

const NO_FILE = ['gmail', 'outlook']

/** The tool a `--for` value names, or a usage error that lists them. */
export function toolFor(value: string): SendToPreset {
  const preset = presetFor(value)
  if (preset) return preset
  const lower = value.trim().toLowerCase()
  if (NO_FILE.includes(lower)) {
    throw usageError(`${lower === 'gmail' ? 'Gmail' : 'Outlook'} sends from a mailbox, so it has no import file.`, 'Use --for other for any tool that imports a CSV.')
  }
  throw usageError(`--for must be one of: ${SEND_TO_IDS.join(', ')}.`, 'Use other for a tool that is not listed.')
}

/**
 * Whether the list and the tool fit, before anything is queued: the channel the
 * file is for (from `--channel`, the list's channel column, or the tool when it
 * takes only one), and the columns that channel needs. A list that would give an
 * empty file is refused here, not after the batch is paid for.
 */
export function planSendTo(preset: SendToPreset, list: { path: string; kind: 'csv' | 'jsonl'; header?: string[]; items: Record<string, unknown>[] }, flagChannel: string | undefined): SendToPlan {
  if (list.kind !== 'csv' || !list.header) {
    throw usageError('--for needs a CSV list: the import file keeps your list\'s columns.', `${list.path} is not a CSV. Make one, or leave --for out.`)
  }
  const valid = (c: unknown): c is Channel => c === 'email' || c === 'linkedin'
  const own = new Set(list.items.map((i) => i.channel).filter(valid))
  if (valid(flagChannel)) own.add(flagChannel)
  if (own.size > 1) {
    throw usageError('--for writes one channel at a time, and this list has both email and LinkedIn rows.', `Split ${list.path} by channel, and run each part with --for.`)
  }
  const only = preset.channels.length === 1 ? preset.channels[0] : undefined
  const channel = [...own][0] ?? only
  if (!channel) {
    throw usageError(`${preset.label} takes email and LinkedIn lists, so --for needs to know which this is.`, 'Add --channel email or --channel linkedin.')
  }
  if (!preset.channels.includes(channel)) {
    throw usageError(`${preset.label} takes ${preset.channels[0] === 'email' ? 'email' : 'LinkedIn'} lists only, and this one is ${channel === 'email' ? 'email' : 'LinkedIn'}.`, 'Pick a tool for this channel, or use --for other.')
  }
  const map = autoMap(list.header)
  if (channel === 'email' && map.email < 0) {
    throw usageError(`${list.path} has no email column.`, 'Name the column email, email_address or work_email, so the tool can import it.')
  }
  if (channel === 'linkedin' && map.linkedin < 0) {
    throw usageError(`${list.path} has no LinkedIn URL column.`, 'Name the column linkedin_url, linkedin or linkedin_profile, so the tool can import it.')
  }
  if (channel === 'linkedin' && preset.needsNames && map.name < 0 && !(map.first >= 0 && map.last >= 0)) {
    throw usageError(`${preset.label} needs a first and a last name for each lead, and ${list.path} has no name columns.`, 'Add first_name and last_name columns, or one name column.')
  }
  return { preset, channel }
}
