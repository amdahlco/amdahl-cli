// src/commands/optimize.ts
//
// `amdahl optimize`: rewrite messages through POST /api/platform/v1/messages/optimize.
// Each file (or `-` for stdin) runs on its own, one after another, with no
// retry and a 180 s timeout. A result of `ok: false` (the optimizer was
// unreachable or unconfigured) is not a rewrite: it prints the reason and the
// command exits 1. Without `--json`, the message goes to stdout and the
// summary and up to three lines on what Amdahl did go to stderr.

import { readFileSync } from 'node:fs'
import { apiClient, resolveCredential, toCliError, str, type Ctx } from '../context'
import { CliError, EXIT, usageError } from '../errors'
import { printable } from '../output'

/** Per-file request timeout. */
export const OPTIMIZE_TIMEOUT_MS = 180_000

const CHANNELS = ['email', 'linkedin']
const EVIDENCE = ['off', 'workspace']
const ON_UNSUPPORTED = ['flag', 'remove']

/** One file's outcome in `--json` output. */
interface FileResult {
  ok: boolean
  file: string
  result: Record<string, unknown>
}

function oneOf(flag: string, value: string | undefined, allowed: string[]): string | undefined {
  if (value === undefined) return undefined
  if (!allowed.includes(value)) throw usageError(`--${flag} must be one of: ${allowed.join(', ')}.`)
  return value
}

/** Read and check the `--context` file: a JSON object. */
function readContext(path: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw usageError(`Could not read --context ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw usageError('--context must be a JSON object with rules, voice_examples and facts.')
  }
  return parsed as Record<string, unknown>
}

/** Reject after `ms`; the request itself is abandoned. */
function withTimeout<T>(promise: Promise<T>, ms: number, file: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CliError('timeout', `Optimizing ${file} timed out after ${ms / 1000} s.`, EXIT.network)),
      ms
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// `steps` carries codes (`w3` with `repaired:2,deleted:1`); these say them in
// plain words. An unknown weakest part or second-check reason still prints its
// generic line, since the API says to treat an unknown veto as a refusal.
const WEAKEST: Record<string, string> = {
  rules: 'how it follows your rules',
  ask: 'the ask',
  opener: 'the opener',
  fit: 'how it fits the recipient',
  proof: 'its proof points',
  length: 'the length',
  style: 'the tone',
  preference: 'how it matches your preferences',
  voice: 'how much it sounds like you',
}

const CONCERNS: Record<string, string> = {
  conflicts_with_callers_ask: 'it asks for a different length or time than your ask',
  drops_ask: 'it leaves out your ask',
  adds_claim: 'it states something neither your draft nor your facts support',
  drops_entity: 'it drops a name, link or placeholder you had',
  inflates: 'it is longer than you asked for',
  no_gain: 'it changed little beyond the wording',
  breaks_rules: 'it breaks one of your rules',
}

const EVIDENCE_MISSED: Record<string, string> = {
  corpus_empty: 'the workspace has none yet',
  evidence_unavailable: 'this environment does not read them',
  evidence_read_failed: 'the read failed, so a retry may work',
}

/** At most this many lines, so the section never buries the message. */
const MAX_LINES = 3

function list(value: unknown): Record<string, unknown>[] | null {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object') : null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? printable(value).trim() : ''
}

function sentence(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** What the `steps` trail did to the message, and what it left for the sender to check. */
function readSteps(steps: Record<string, unknown>[]): { did: string; check: string[] } {
  const reasonOf = (node: string) => text(steps.find((s) => s.node === node)?.reason)
  const changed = (node: string) => steps.some((s) => s.node === node && s.changed === true)
  const counts = new Map(
    reasonOf('w3')
      .split(',')
      .map((part) => part.split(':'))
      .filter(([, n]) => /^\d+$/.test(n ?? ''))
      .map(([code, n]) => [code, Number(n)] as const)
  )
  const did: string[] = []
  const fixed = [
    counts.get('repaired') ? `rewrote ${counts.get('repaired')}` : '',
    counts.get('deleted') ? `cut ${counts.get('deleted')} nothing backed` : '',
  ].filter(Boolean)
  if (fixed.length) did.push(`Checked each sentence: ${fixed.join(', ')}.`)
  const repair = reasonOf('w5')
  if (changed('w5') && repair.startsWith('repaired:')) {
    const weakest = WEAKEST[repair.slice('repaired:'.length)]
    did.push(weakest ? `Reworked ${weakest}.` : 'Reworked its weakest part.')
  }
  const check: string[] = []
  const open = counts.get('open')
  if (open) check.push(`${plural(open, 'sentence problem')} still open`)
  const second = reasonOf('w6')
  if (changed('w6') && !second.startsWith('kept_before_repair')) {
    const concern = CONCERNS[second]
    check.push(concern ? `a second check says ${concern}` : 'a second check flagged it')
  }
  return { did: did.join(' '), check }
}

/**
 * At most three short lines on what the run did, from fields the API already
 * returns: `what_changed`, `evidence` (with `lift.quotes`), `unsupported_claims`,
 * `context_use`, `steps` and `omitted`. What the sender must check before
 * sending is never dropped; past that, the lines worth most are kept. They print
 * with what Amdahl did first and the check last. Empty when nothing says
 * anything worth reading.
 */
export function whatAmdahlDid(result: Record<string, unknown>): string[] {
  // A kept draft is not the version the steps describe.
  const steps = result.unchanged === true ? { did: '', check: [] } : readSteps(list(result.steps) ?? [])
  const check = [...steps.check]

  const grounded: string[] = []
  const evidence = record(result.evidence)
  const claims = list(result.unsupported_claims)
  if (evidence?.used === true) {
    const quotes = record(result.lift)?.quotes
    grounded.push(
      typeof quotes === 'number' && quotes > 0
        ? `Checked against ${plural(quotes, 'customer quote')}`
        : "Checked against your customers' conversations"
    )
    if (claims) {
      const still = claims.filter((c) => c.status !== 'removed').length
      const removed = claims.length - still
      if (removed) grounded.push(`cut ${plural(removed, 'unbacked claim')}`)
      if (!claims.length) grounded.push('found no unbacked claims')
      if (still) check.unshift(`${plural(still, 'unbacked claim')} ${still === 1 ? 'is' : 'are'} still in it`)
    }
  } else if (evidence?.requested === 'workspace' && EVIDENCE_MISSED[text(evidence.reason)]) {
    grounded.push(`Customer conversations not read: ${EVIDENCE_MISSED[text(evidence.reason)]}`)
  }
  const used = (list(record(result.context_use)?.rows) ?? []).filter((r) => r.verdict === 'pass')
  const sources = [
    used.some((r) => r.bucket === 'internal') ? "Amdahl's own records" : '',
    used.some((r) => r.bucket === 'external') ? 'what their company or market published' : '',
  ].filter(Boolean)
  if (sources.length) grounded.push(`${grounded.length ? 'built' : 'Built'} on ${sources.join(' and ')}`)

  const omitted = list(result.omitted) ?? []
  const whys = [...new Set(omitted.map((o) => text(o.why)).filter(Boolean))]
  const more = whys.length > 1 ? ` (${plural(whys.length - 1, 'more reason')} in --json)` : ''
  const leftOut = omitted.length
    ? `Left out ${plural(omitted.length, 'thing')}${whys[0] ? `: ${sentence(whys[0])}` : '.'}${more}`
    : ''

  // In print order, each with its rank: 1 is kept first.
  const lines = [
    { rank: 2, line: sentence(text(result.what_changed)) },
    { rank: 3, line: grounded.length ? sentence(grounded.join('; ')) : '' },
    { rank: 5, line: steps.did },
    { rank: 4, line: leftOut },
    { rank: 1, line: check.length ? sentence(`Check before sending: ${check.join('; ')}`) : '' },
  ].filter((l) => l.line && l.line !== '.')
  const kept = new Set([...lines].sort((a, b) => a.rank - b.rank).slice(0, MAX_LINES))
  return lines.filter((l) => kept.has(l)).map((l) => l.line)
}

/** `amdahl optimize [<file>... | -]`. */
export async function optimize(ctx: Ctx, args: string[]): Promise<number> {
  const { io, out, flags } = ctx
  let files = args
  if (files.length === 0) {
    if (io.stdinIsTTY) {
      throw usageError(
        'Give a file to optimize, or pipe the message on stdin.',
        'Usage: amdahl optimize <file>... | - [--channel email|linkedin]'
      )
    }
    files = ['-']
  }
  if (files.filter((f) => f === '-').length > 1) throw usageError('Stdin (-) can be read only once.')

  const base: Record<string, unknown> = {}
  const channel = oneOf('channel', str(flags.channel), CHANNELS)
  const evidence = oneOf('evidence', str(flags.evidence), EVIDENCE)
  const onUnsupported = oneOf('on-unsupported', str(flags['on-unsupported']), ON_UNSUPPORTED)
  if (channel) base.channel = channel
  if (evidence) base.evidence = evidence
  if (onUnsupported) base.on_unsupported = onUnsupported
  if (flags.tries === true) base.include_tries = true
  const contextPath = str(flags.context)
  if (contextPath) base.context = readContext(contextPath)

  // Read every input before the first request, so a typo in the third file
  // fails before the first one is spent.
  const inputs: { file: string; message: string }[] = []
  for (const file of files) {
    let message: string
    try {
      message = file === '-' ? await io.readStdin() : readFileSync(file, 'utf8')
    } catch (err) {
      throw usageError(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!message.trim()) throw usageError(`${file === '-' ? 'Stdin' : file} is empty.`)
    inputs.push({ file, message })
  }

  const credential = await resolveCredential(ctx)
  const client = apiClient(ctx, credential)
  const results: FileResult[] = []
  let exit: number = EXIT.ok
  for (const { file, message } of inputs) {
    let result: Record<string, unknown>
    try {
      result = await withTimeout(
        client.request<Record<string, unknown>>('/api/platform/v1/messages/optimize', {
          method: 'POST',
          body: { message, ...base },
        }),
        OPTIMIZE_TIMEOUT_MS,
        file
      )
    } catch (err) {
      throw toCliError(err)
    }
    const ok = result.ok !== false
    results.push({ ok, file, result })
    if (!ok) {
      exit = EXIT.general
      out.info(`${file}: not optimized (${String(result.reason ?? 'unknown')}): ${String(result.detail ?? '')}`)
      continue
    }
    if (!out.json) {
      if (inputs.length > 1) out.info(`== ${file} ==`)
      if (result.unchanged === true) out.info('No rewrite beat your draft; it is returned unchanged.')
      else if (typeof result.summary === 'string') out.info(result.summary)
      out.result({}, String(result.message ?? ''))
      const did = whatAmdahlDid(result)
      if (did.length) out.info(did.join('\n'))
    }
  }
  if (out.json) out.result(results.length === 1 ? (results[0] as unknown as Record<string, unknown>) : (results as unknown as Record<string, unknown>[]))
  return exit
}
