// src/lead-facts.ts
//
// `amdahl sequence --leads`: what a list row tells the optimizer about the
// person, as facts: who they are, then every other column that can be a fact,
// with links, addresses and phone numbers taken out first. Copied BY HAND from
// amdahl-frontend, apps/universal-ui/lib/optimizer/lead-facts.ts at commit
// d9a53a2b9 (#2286); only the part that builds a row's facts is here. A change
// in the console is not caught here: make it in both places.

import { MAX_FACTS, MAX_FACT_CHARS, draftFacts } from './draft-facts'
import type { Lead, LeadTable, PeopleMap } from './lead-people'
import { norm } from './send-to'

export const ROW_FACT_CHARS = 2000

const WHO_CHARS = 300
const HEADER_CHARS = 60
const MIN_VALUE_CHARS = 20
const NOTE_LIKE = ['note', 'comment', 'context', 'research', 'personali', 'icebreaker', 'last_touch', 'last_activity', 'last_contact', 'trigger', 'signal', 'pain', 'summary', 'bio', 'about']
const NEVER_FACT = ['email', 'e_mail', 'linkedin', 'twitter', 'facebook', 'url', 'website', 'photo', 'avatar', 'image', 'phone', 'mobile', 'fax', 'whatsapp', 'street', 'address', 'zip', 'postal', 'postcode']
const BLANK_CELLS = new Set(['', '-', 'n/a', 'na', 'null', 'none', '#n/a'])

const LINK = /(?:\b(?:https?|ftp):\/\/|\bwww\.|\b(?:mailto|tel):)[^\s)\]>"']+/gi
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu
const PATH_DOMAIN = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s)\]>"']*/gi
const PLUS_PHONE = /(?<![\w+])(?:\+|00)\d[\d\s().-]{5,}\d(?!\w)/g
const US_PHONE = /(?<![\w+])(?:1[\s.-]?)?(?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\w)/g
const BARE_PHONE = /(?<![\w$.,])1?[2-9]\d{9}(?!\w)/g
const TRUNK_PHONE = /(?<![\w.+])0\d{1,4}(?:[\s.-]?\d{2,4}){2,4}(?!\w)/g
const PO_BOX = /\bP\.?\s?O\.?\s+Box\s+\d+/gi
const STREET =
  /\b\d{1,6}[A-Za-z]?(?:\s+[A-Z0-9][\w'.-]*){1,4}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Court|Ct|Place|Pl|Parkway|Pkwy|Highway|Hwy|Terrace|Square|Sq|street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr)\b\.?(?:,?\s*(?:Suite|Ste|Apt|Unit|Floor|Fl|#)\.?\s*#?\s*\w+)?/g

/** Headers that hold a tenant id: never sent as a fact or an attribute. */
export const RESERVED_KEYS = new Set(['businessid', 'userid', 'tenantid', 'workspaceid'])

/** A website value as a bare domain. */
export function domainOf(value: string): string {
  const host = value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#]/)[0]
  return (host ?? '').toLowerCase()
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()

const phoneIf = (minDigits: number) => (m: string) => (m.replace(/\D/g, '').length >= minDigits ? ' ' : m)

/** `text` without links, email addresses, phone numbers and street addresses; empty when nothing readable is left. */
function scrub(text: string): string {
  const removed = text
    .replace(LINK, ' ')
    .replace(EMAIL, ' ')
    .replace(PATH_DOMAIN, ' ')
    .replace(PLUS_PHONE, phoneIf(7))
    .replace(US_PHONE, ' ')
    .replace(BARE_PHONE, ' ')
    .replace(TRUNK_PHONE, phoneIf(9))
    .replace(PO_BOX, ' ')
    .replace(STREET, ' ')
  const out =
    removed === text
      ? collapse(text)
      : collapse(removed)
          .replace(/\(\s*\)|\[\s*\]/g, '')
          .replace(/\s+([,;:.!?)\]])/g, '$1')
          .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
          .replace(/^[\s,;:|]+|[\s,;:|]+$/g, '')
  return /[\p{L}\p{N}]/u.test(out) ? collapse(out) : ''
}

function isIdHeader(header: string, n: string): boolean {
  return n.split('_').includes('id') || /uuid|sfdc|guid(?:_|$)/.test(n) || /[a-z0-9](?:Id|ID)$/.test(header.trim())
}

function canBeFact(header: string): boolean {
  const n = norm(header)
  if (!n || isIdHeader(header, n) || n.startsWith('amdahl')) return false
  if (RESERVED_KEYS.has(header.toLowerCase().replace(/[^a-z0-9]/g, ''))) return false
  return !NEVER_FACT.some((w) => n.includes(w))
}

const isNoteLike = (header: string) => NOTE_LIKE.some((w) => norm(header).includes(w))

function factColumns(table: LeadTable, map: PeopleMap): number[] {
  const used = new Set(Object.values(map).filter((i) => i >= 0))
  const cols = table.headers.map((_, i) => i).filter((i) => !used.has(i) && canBeFact(table.headers[i] ?? ''))
  return [...cols.filter((i) => isNoteLike(table.headers[i] ?? '')), ...cols.filter((i) => !isNoteLike(table.headers[i] ?? ''))]
}

function cut(text: string, limit: number): string {
  let end = limit - 3
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  const head = text.slice(0, end)
  const space = head.lastIndexOf(' ')
  return `${(space >= end / 2 ? head.slice(0, space) : head).replace(/[\s,;:]+$/, '')}...`
}

const shorten = (text: string, limit: number) => (text.length <= limit ? text : cut(text, limit))

interface Entry {
  label: string
  value: string
  who?: boolean
}

function whoEntry(lead: Lead): Entry | null {
  const name = scrub(lead.name)
  const title = scrub(lead.title)
  const company = scrub(lead.company)
  if (!name && !title && !company) return null
  let who = name
  if (title) who = who ? `${who}, ${title}` : title
  if (company) who = who ? `${who} at ${company}` : company
  const domain = scrub(domainOf(lead.domain))
  if (domain) who += ` (${domain})`
  return { label: name || title ? 'Recipient' : 'Recipient company', value: who, who: true }
}

const piece = (e: Entry, cap: number) => `${e.label}: ${shorten(e.value, e.who ? WHO_CHARS : cap)}`
const total = (facts: string[]) => facts.reduce((n, f) => n + f.length, 0)
const fits = (facts: string[]) => facts.every((f) => f.length <= MAX_FACT_CHARS) && total(facts) <= ROW_FACT_CHARS

function layout(entries: Entry[], room: number, cap: number): string[] {
  const shown = entries.map((e) => piece(e, cap))
  return shown.length <= room ? shown : [...shown.slice(0, room - 1), `Also: ${shown.slice(room - 1).join('; ')}`]
}

/**
 * The facts for one row: "Recipient: Sam Rivera, Head of Sales at Acme", then
 * "<Header>: <value>" for each other column with something in it, as many as
 * fit beside the draft's own facts, each cut to fit the limits.
 */
export function rowFacts(lead: Lead, table: LeadTable, map: PeopleMap, about: readonly string[]): string[] {
  const kept = about.map(collapse).filter(Boolean)
  const aboutLines = new Set(kept)
  const room = MAX_FACTS - kept.length - draftFacts(lead.draft).length
  if (room <= 0) return []
  const who = whoEntry(lead)
  const cells = factColumns(table, map).flatMap((i): Entry[] => {
    const raw = collapse(lead.cells[i] ?? '')
    const value = BLANK_CELLS.has(raw.toLowerCase()) ? '' : scrub(raw)
    return value ? [{ label: shorten(collapse(table.headers[i] ?? ''), HEADER_CHARS), value }] : []
  })
  const entries = [...(who ? [who] : []), ...cells].filter((e) => !aboutLines.has(`${e.label}: ${e.value}`))
  if (fits(layout(entries, room, MAX_FACT_CHARS))) return layout(entries, room, MAX_FACT_CHARS)
  let lo = MIN_VALUE_CHARS
  let hi = MAX_FACT_CHARS
  if (fits(layout(entries, room, lo))) {
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      if (fits(layout(entries, room, mid))) lo = mid
      else hi = mid
    }
    return layout(entries, room, lo)
  }
  const own = entries.slice(0, room - 1).map((e) => piece(e, lo))
  const rest = entries.slice(room - 1)
  const limit = Math.min(MAX_FACT_CHARS, ROW_FACT_CHARS - total(own))
  let also = 'Also:'
  let sent = 0
  for (const e of rest) {
    const next = `${also}${sent === 0 ? ' ' : '; '}${piece(e, lo)}`
    if (next.length > limit) break
    also = next
    sent += 1
  }
  return sent > 0 ? [...own, also] : own
}
