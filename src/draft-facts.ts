// src/draft-facts.ts
//
// `amdahl sequence --leads`: the optimizer reads no draft that is sent with
// facts or rules, so a person's email also goes as facts, word for word, plus
// one rule. Copied BY HAND from amdahl-frontend,
// apps/universal-ui/lib/optimizer/draft-facts.ts at commit d9a53a2b9 (#2286).
// A change in the console is not caught here: make it in both places.

import { MAX_RULES } from './sequence-plan'

/** Most facts one request carries, and the most characters in one. */
export const MAX_FACTS = 10
export const MAX_FACT_CHARS = 1000

export const DRAFT_RULE = "Write the message from the sender's message in the facts. Keep its substance, order and voice, and improve the wording."

// Under MAX_FACT_CHARS, with room for the "Part 10 of 10" label.
const CHUNK_CHARS = 900

interface Piece {
  text: string
  sep: string
}

/** A cut falls on whitespace in the chunk's second half when there is some, else at the limit, never inside a surrogate pair. */
function cut(text: string, sep: string): Piece[] {
  const out: Piece[] = []
  let rest = text
  let next = sep
  while (rest.length > CHUNK_CHARS) {
    const space = /\s+\S*$/.exec(rest.slice(0, CHUNK_CHARS + 1))
    let at = space && space.index >= CHUNK_CHARS / 2 ? space.index : CHUNK_CHARS
    if (at === CHUNK_CHARS && /[\uDC00-\uDFFF]/.test(rest[at] ?? '')) at -= 1
    out.push({ text: rest.slice(0, at), sep: next })
    const gap = /^\s*/.exec(rest.slice(at))?.[0] ?? ''
    next = gap
    rest = rest.slice(at + gap.length)
  }
  out.push({ text: rest, sep: next })
  return out
}

function pieces(paragraph: string): Piece[] {
  if (paragraph.length <= CHUNK_CHARS) return [{ text: paragraph, sep: '\n\n' }]
  const parts = paragraph.split(/(?<=[.!?])(\s+)/)
  const out: Piece[] = []
  for (let i = 0; i < parts.length; i += 2) out.push(...cut(parts[i] ?? '', i === 0 ? '\n\n' : (parts[i - 1] ?? '')))
  return out
}

/** The draft as facts, word for word, in parts of under 1000 characters. Empty for no draft. */
export function draftFacts(draft: string): string[] {
  const chunks: string[] = []
  for (const piece of draft.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).flatMap(pieces)) {
    const last = chunks.length - 1
    if (last >= 0 && (chunks[last] ?? '').length + piece.sep.length + piece.text.length <= CHUNK_CHARS) chunks[last] += piece.sep + piece.text
    else chunks.push(piece.text)
  }
  if (chunks.length <= 1) return chunks.map((chunk) => `The sender's message, word for word:\n${chunk}`)
  return chunks.map((chunk, i) => `Part ${i + 1} of ${chunks.length} of the sender's message, word for word:\n${chunk}`)
}

export interface DraftContext {
  facts: string[]
  rules: string[]
}

const count = (lines: readonly string[]) => lines.filter((l) => l.trim()).length

export type DraftFit = { ok: true; context: DraftContext } | { ok: false; over: 'facts' | 'rules'; extra: number }

/** The context plus the draft as facts and DRAFT_RULE, or the list that goes over the optimizer's limit. */
export function withDraftFacts(context: DraftContext, draft: string): DraftFit {
  const chunks = draftFacts(draft)
  if (chunks.length === 0) return { ok: true, context }
  const facts = [...context.facts, ...chunks]
  const rules = [...context.rules, DRAFT_RULE]
  if (count(facts) > MAX_FACTS) return { ok: false, over: 'facts', extra: count(facts) - MAX_FACTS }
  if (count(rules) > MAX_RULES) return { ok: false, over: 'rules', extra: count(rules) - MAX_RULES }
  return { ok: true, context: { facts, rules } }
}

/** One line for a draft that does not fit beside its facts or rules. */
export function draftFitProblem(fit: Extract<DraftFit, { ok: false }>): string {
  if (fit.over === 'facts') return 'This email is too long to send with this row. Shorten it, or remove some columns.'
  return `Up to ${MAX_RULES - 1} rules when you start from an email. Remove ${fit.extra} ${fit.extra === 1 ? 'rule' : 'rules'}.`
}
