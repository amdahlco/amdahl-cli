// src/commands/sequence-run.ts
//
// The run of `amdahl sequence`: one POST /api/platform/v1/messages/optimize for
// each email, strictly in order, because each email is written as a follow-up
// to the final emails before it. Email i sends `context.prior_touches`, one
// entry for each earlier email, built from its FINAL text (the improved one,
// or the typed one when Amdahl kept the draft). Writing sends no message: the
// plan's two rules and the touches are the context. A failure (`ok: false`, or
// an error) stops the run: the emails before it are already printed, and the
// later ones are not sent. The emails print as each one comes back: the text
// on stdout, what changed on stderr. An email refused as rate limited is tried
// once more after the wait the server names (at most 60 s). Nothing is written
// to disk here.

import { changeLines } from '../changes'
import { canAsk } from '../terminal'
import { toCliError, type Credential, type Ctx } from '../context'
import { CliError, EXIT } from '../errors'
import { sentLines } from '../next-steps'
import { rememberRun } from '../history'
import { planRules, type PlanStep } from '../sequence-plan'
import { startTicker } from '../sequence-ticker'
import { emailText, finalEmail, lostFields, sentMessage, showsSubject, touchOf, type FinalEmail, type SeqEmail } from '../sequence-parse'
import { field, incompleteLine, records } from '../text'
import { feedbackLines, optimizeOne, whatAmdahlDid } from './optimize'

/** What a sequence is written for, and its plan. */
export interface WritePlan {
  goal: string
  steps: PlanStep[]
}

/** One run: the emails (blank ones when writing), the plan when writing, and the request options. */
export interface Job {
  emails: SeqEmail[]
  plan: WritePlan | null
  /** `channel`, `evidence` and `on_unsupported`, sent with every email. */
  base: Record<string, unknown>
  /** The `--context` file: facts, rules, voice examples and the like, sent with every email. */
  fileContext: Record<string, unknown> | null
  /** `--from`: the first email to run (from 0), after these finished ones (read from the saved CSV). */
  resume?: { earlier: FinalEmail[] }
}

/** One email that came back. */
export interface Done {
  /** From 1. */
  index: number
  subject: string | null
  message: string
  run_id: unknown
  result: Record<string, unknown>
  final: FinalEmail
}

export interface Failure {
  index: number
  reason: string
  detail: string
  hint?: string
  /** An account refusal (sign-in, plan, access) that has nothing to do with the email itself. */
  account?: boolean
}

export interface Outcome {
  done: Done[]
  failed: Failure | null
  /** The fill-in fields: each once that no email lost, and the emails that lost one. */
  fields: { kept: string[]; lost: { email: number; fields: string[] }[] }
  exit: number
  /** Why the run ended early without a failed email: Ctrl+C, or a closed stdout pipe. */
  stopped?: 'interrupted' | 'closed'
}

/** The longest Amdahl waits before it tries a refused email again, and the wait when the server names none. */
const MAX_RETRY_SECONDS = 60
const DEFAULT_RETRY_SECONDS = 10

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`)

/** `4`, `4 and 5`, `4, 5 and 6`. */
function listOf(numbers: number[]): string {
  return numbers.length < 2 ? String(numbers[0] ?? '') : `${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`
}

/** The `context` of email `i`: the file's, the plan's rules first, and the touches so far. Only keys that carry something. */
function contextFor(job: Job, i: number, finals: FinalEmail[], now: Date): Record<string, unknown> | undefined {
  const { rules: fileRules, ...rest } = job.fileContext ?? {}
  const written = job.plan ? planRules(job.plan.goal, job.plan.steps, i) : []
  const rules = [...written, ...(Array.isArray(fileRules) ? fileRules : [])]
  const touches = finals.slice(0, i).map((f) => touchOf(f, now)).filter((t) => t.summary)
  const context: Record<string, unknown> = { ...rest }
  if (rules.length) context.rules = rules
  if (touches.length) context.prior_touches = touches
  return Object.keys(context).length ? context : undefined
}

/** The first question a result asks the sender, as the line that says the email needs input. */
function needsInputLine(n: number, result: Record<string, unknown>, kept: boolean): string {
  const ask = field(records(result.ask)[0]?.asks)
  const first = `Email ${n} needs your input${ask ? `: ${sentence(ask)}` : '.'}`
  return kept ? `${first} Kept your draft.` : first
}

/** A reply keeps no subject, so a subject line the writer added is not shown as a change either. */
function withoutAddedSubject(result: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(result.changes)) return result
  return { ...result, changes: records(result.changes).filter((row) => !(row.before == null && /^\s*subject\s*:/i.test(field(row.after)))) }
}

const KEPT_LINE = /^(Checked|Used|Left out|Flagged) /

/** The stderr lines of one email: what changed, a kept draft, a question, and what must be checked. */
function noteLines(n: number, result: Record<string, unknown>, needsInput: boolean, writing: boolean): string[] {
  if (needsInput) return [needsInputLine(n, result, !writing)]
  const lines = result.unchanged === true ? ['Kept your draft: no rewrite beat it.'] : changeLines(result)
  const incomplete = incompleteLine(result)
  if (incomplete) lines.push(`Email ${n}: ${incomplete}`)
  for (const did of whatAmdahlDid(result, lines.length > 0)) if (KEPT_LINE.test(did)) lines.push(`Email ${n}: ${did}`)
  return lines
}

/** The one stderr line, or one for each email, about the fill-in fields. Empty when there were none. */
export function fieldLines(fields: Outcome['fields'], kept: string[]): string[] {
  if (fields.lost.length) return fields.lost.map((l) => `Email ${l.email} lost ${l.fields.join(', ')}. Add ${l.fields.length === 1 ? 'it' : 'them'} back before you send.`)
  return kept.length ? [`Kept your fill-in fields: ${kept.join(', ')}.`] : []
}

/** The line that says which email stopped the run and which were not run. */
export function failureLine(failure: Failure, total: number, writing: boolean): string {
  const verb = writing ? 'written' : 'improved'
  const why = failure.detail ? `: ${sentence(failure.detail)}` : ` (${failure.reason.replace(/_/g, ' ')}).`
  const later = Array.from({ length: total - failure.index }, (_, k) => failure.index + 1 + k)
  const tail = later.length === 0 ? '' : later.length === 1 ? ` Email ${later[0]} was not run.` : ` Emails ${listOf(later)} were not run.`
  return `Email ${failure.index} was not ${verb}${why}${tail}`
}

/** A refusal about the account, not the email: the sign-in, the plan or the access. */
function isAccountRefusal(e: CliError): boolean {
  return e.exit === EXIT.unauthenticated || e.exit === EXIT.forbidden || e.exit === EXIT.noWorkspace || /^(quota_exceeded|quota_exhausted|payment_required|http_(401|402|403|409))$/.test(e.code)
}

/** What a person reads after the emails: how to report them as sent. One line; each email's run id is under it. */
export function sentThemLine(ctx: Ctx, done: Done[]): string[] {
  if (!done.some((d) => field(d.run_id))) return []
  const [line] = sentLines('<run id>', 'Sent them?', canAsk(ctx))
  return [line ?? '']
}

class Interrupted extends Error {}

/**
 * Run every email in order and print each as it comes back (not under `--json`).
 * Never throws for a failed email: that is the outcome's `failed`.
 */
export async function runSequence(ctx: Ctx, credential: Credential, job: Job): Promise<Outcome> {
  const { io, out } = ctx
  const writing = job.plan !== null
  const total = job.emails.length
  const earlier = job.resume?.earlier ?? []
  const finals: FinalEmail[] = [...earlier]
  const done: Done[] = []
  let failed: Failure | null = null
  let stopped: Outcome['stopped']
  let exit: number = EXIT.ok
  const now = new Date(io.now())
  const live = !out.json && io.stderrIsTTY
  let interrupted = false
  let cut: () => void = () => {}
  const interrupt = new Promise<never>((_, reject) => {
    cut = () => {
      interrupted = true
      reject(new Interrupted())
    }
  })
  interrupt.catch(() => {})
  const unlisten = io.onInterrupt?.(() => cut())
  // Race a wait against Ctrl+C. The request itself is not cancelled; its answer is dropped.
  const until = <T>(wait: Promise<T>) => {
    wait.catch(() => {})
    return Promise.race([wait, interrupt])
  }
  const remaining = total - earlier.length
  if (live && remaining > 1) out.info(`About ${remaining} minutes in all.`)
  try {
    for (let i = earlier.length; i < total; i++) {
      const n = i + 1
      const email = job.emails[i] as SeqEmail
      if (interrupted) {
        stopped = 'interrupted'
        break
      }
      // EPIPE arrives a tick after the write that hit the closed pipe, so let it land before the check.
      if (io.stdoutClosed) await new Promise((resolve) => setImmediate(resolve))
      if (io.stdoutClosed?.()) {
        stopped = 'closed'
        break
      }
      const blankOnTerminal = i > earlier.length && io.stdoutIsTTY && live
      if (live) out.info(`${blankOnTerminal ? '\n' : ''}Amdahl is ${writing ? 'writing' : 'improving'} email ${n} of ${total}.`)
      const context = contextFor(job, i, finals, now)
      let result: Record<string, unknown>
      let stopTick = () => {}
      try {
        const ask = () => {
          stopTick()
          stopTick = out.json ? () => {} : startTicker(io, `email ${n} of ${total}`)
          return optimizeOne(ctx, credential, writing ? '' : sentMessage(email, i), { ...job.base, ...(context ? { context } : {}) }, `email ${n}`).finally(() => stopTick())
        }
        try {
          result = await until(ask())
        } catch (err) {
          if (err instanceof Interrupted) throw err
          const refused = err instanceof CliError ? err : toCliError(err)
          if (refused.code !== 'rate_limited') throw refused
          const seconds = Math.min(MAX_RETRY_SECONDS, Math.ceil(refused.retryAfterSeconds ?? DEFAULT_RETRY_SECONDS))
          if (live) out.info(`Amdahl is busy. Trying email ${n} again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`)
          await until(io.sleep(seconds * 1000))
          result = await until(ask())
        }
      } catch (err) {
        stopTick()
        if (err instanceof Interrupted) {
          stopped = 'interrupted'
          break
        }
        const e = err instanceof CliError ? err : toCliError(err)
        failed = { index: n, reason: e.code, detail: e.message, ...(e.hint ? { hint: e.hint } : {}), ...(isAccountRefusal(e) ? { account: true } : {}) }
        exit = e.exit
        break
      }
      if (result.ok === false) {
        failed = { index: n, reason: String(result.reason ?? 'unknown'), detail: field(result.detail) }
        exit = EXIT.general
        break
      }
      const needsInput = result.outcome === 'needs_input'
      if (!needsInput && typeof result.message !== 'string') {
        failed = { index: n, reason: 'no_message', detail: 'Amdahl did not return a message.' }
        exit = EXIT.general
        break
      }
      rememberRun(ctx, { run_id: result.run_id, kind: 'optimize', channel: 'email' }, credential)
      const final = finalEmail(email, i, needsInput ? null : String(result.message))
      finals.push(final)
      done.push({ index: n, subject: final.subject, message: final.body, run_id: result.run_id, result, final })
      if (!out.json) {
        const head = writing ? `Email ${n} of ${total}: ${job.plan?.steps[i]?.name.trim() || `Email ${n}`}` : `Email ${n} of ${total}`
        const text = needsInput && writing ? head : `${head}\n${emailText(final)}`
        const blank = i > earlier.length && !(io.stdoutIsTTY && io.stderrIsTTY) ? '\n' : ''
        out.result({}, `${blank}${text}`)
        const notes = [...noteLines(n, showsSubject(email, i) ? result : withoutAddedSubject(result), needsInput, writing), ...feedbackLines(ctx, result)]
        if (notes.length) out.info(notes.join('\n'))
      }
    }
  } finally {
    unlisten?.()
  }
  if (stopped === 'interrupted') exit = EXIT.cancelled
  return { done, failed, fields: fieldsOf(job, done), exit, ...(stopped ? { stopped } : {}) }
}

/** Which fill-in fields each finished email kept and lost. A written sequence has no drafts, so none. */
function fieldsOf(job: Job, done: Done[]): Outcome['fields'] {
  if (job.plan) return { kept: [], lost: [] }
  const lost: { email: number; fields: string[] }[] = []
  const seen: string[] = []
  for (const d of done) {
    const check = lostFields(job.emails[d.index - 1] as SeqEmail, d.index - 1, d.final)
    for (const f of check.had) if (!seen.includes(f)) seen.push(f)
    if (check.lost.length) lost.push({ email: d.index, fields: check.lost })
  }
  const lostAll = new Set(lost.flatMap((l) => l.fields))
  return { kept: seen.filter((f) => !lostAll.has(f)), lost }
}

/** The document `--json` prints. */
export function jsonDocument(job: Job, outcome: Outcome, file: string | null, saved = 0, fileError: string | null = null): Record<string, unknown> {
  return {
    ok: outcome.failed === null && fileError === null && outcome.stopped !== 'interrupted',
    mode: job.plan ? 'write' : 'improve',
    emails: outcome.done.map((d) => ({ index: d.index, subject: d.subject, message: d.message, run_id: d.run_id ?? null, result: d.result })),
    fields: outcome.fields,
    ...(job.plan ? { plan: job.plan.steps.map((st) => ({ name: st.name, job: st.job })) } : {}),
    ...(outcome.failed ? { failed: { index: outcome.failed.index, reason: outcome.failed.reason, detail: outcome.failed.detail } } : {}),
    ...(file ? { file, saved } : {}),
    ...(fileError ? { file_error: { code: 'file_error', detail: fileError } } : {}),
    ...(outcome.stopped ? { stopped: outcome.stopped } : {}),
  }
}
