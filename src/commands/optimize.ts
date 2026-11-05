// src/commands/optimize.ts
//
// `amdahl optimize`: rewrite messages through POST /api/platform/v1/messages/optimize.
// Each file (or `-` for stdin) runs on its own, one after another, with no
// retry and a 180 s timeout. A result of `ok: false` (the optimizer was
// unreachable or unconfigured) is not a rewrite: it prints the reason and the
// command exits 1. Without `--json`, the message goes to stdout and the
// summary and a short "What Amdahl did" section go to stderr.

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
// plain words. A code with no entry here is left out of the section.
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
  corpus_empty: 'the workspace has no conversations yet',
  evidence_unavailable: 'this environment does not read them',
  evidence_read_failed: 'reading them failed, so a retry may work',
}

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

/** The `steps` trail as one plain line, or '' when no step changed the message. */
function stepsLine(steps: Record<string, unknown>[]): string {
  const said: string[] = []
  const reasonOf = (node: string) => text(steps.find((s) => s.node === node)?.reason)
  const counts = new Map(
    reasonOf('w3')
      .split(',')
      .map((part) => part.split(':'))
      .filter(([, n]) => /^\d+$/.test(n ?? ''))
      .map(([code, n]) => [code, Number(n)] as const)
  )
  const fixed = [
    counts.get('repaired') ? `rewrote ${counts.get('repaired')}` : '',
    counts.get('deleted') ? `removed ${counts.get('deleted')} that nothing backed` : '',
    counts.get('open') ? `${counts.get('open')} still open` : '',
  ].filter(Boolean)
  if (fixed.length) said.push(`Checked each sentence against what you sent: ${fixed.join(', ')}.`)
  const repair = reasonOf('w5')
  if (steps.some((s) => s.node === 'w5' && s.changed === true) && repair.startsWith('repaired:')) {
    const weakest = WEAKEST[repair.slice('repaired:'.length)]
    said.push(weakest ? `Reworked ${weakest}, its weakest part.` : 'Reworked its weakest part.')
  }
  const second = reasonOf('w6')
  if (steps.some((s) => s.node === 'w6' && s.changed === true)) {
    if (second.startsWith('kept_before_repair')) said.push('A second check kept the version from before that rework.')
    else {
      const concern = CONCERNS[second]
      said.push(`A second check had a concern${concern ? `: ${concern}` : ''}. Read it before sending.`)
    }
  }
  return said.join(' ')
}

/**
 * Up to four plain lines on what the run did and why, from fields the API
 * already returns: `what_changed`, `steps`, `omitted`, `evidence` (with
 * `lift.quotes`), `unsupported_claims` and `context_use`. Empty when none of
 * them says anything worth reading.
 */
export function whatAmdahlDid(result: Record<string, unknown>): string[] {
  const lines: string[] = []

  const changed = text(result.what_changed)
  if (changed) lines.push(sentence(changed))

  const steps = stepsLine(list(result.steps) ?? [])
  if (steps) lines.push(steps)

  const omitted = list(result.omitted) ?? []
  if (omitted.length) {
    const whys = [...new Set(omitted.map((o) => text(o.why)).filter(Boolean))]
    const shown = whys.slice(0, 2).map(sentence).join(' ')
    const more = whys.length > 2 ? ` (${whys.length - 2} more in --json)` : ''
    lines.push(`Left out ${plural(omitted.length, 'thing')}${shown ? `: ${shown}` : '.'}${more}`)
  }

  const checks: string[] = []
  const evidence = record(result.evidence)
  const claims = list(result.unsupported_claims)
  if (evidence?.used === true) {
    const quotes = record(result.lift)?.quotes
    const read = typeof quotes === 'number' && quotes > 0 ? ` (${plural(quotes, 'quote')})` : ''
    checks.push(`Checked against your customers' conversations${read}`)
    if (claims) {
      const still = claims.filter((c) => c.status !== 'removed').length
      const removed = claims.length - still
      if (removed) checks.push(`removed ${plural(removed, 'claim')} nothing there backs`)
      if (still) checks.push(`${plural(still, 'claim')} nothing there backs ${still === 1 ? 'is' : 'are'} still in it, so check before sending`)
      if (!claims.length) checks.push('every claim is backed')
    }
  } else if (evidence?.requested === 'workspace' && EVIDENCE_MISSED[text(evidence.reason)]) {
    checks.push(`Your customers' conversations were not read: ${EVIDENCE_MISSED[text(evidence.reason)]}`)
  }
  const used = (list(record(result.context_use)?.rows) ?? []).filter((r) => r.verdict === 'pass')
  const sources = [
    used.some((r) => r.bucket === 'internal') ? "Amdahl's record of the recipient" : '',
    used.some((r) => r.bucket === 'external') ? 'what their company or market published' : '',
  ].filter(Boolean)
  if (sources.length) checks.push(`${checks.length ? 'built' : 'Built'} on ${sources.join(' and ')}`)
  if (checks.length) lines.push(sentence(checks.join('; ')))

  return lines
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
      if (did.length) out.info(['What Amdahl did:', ...did.map((line) => `  ${line}`)].join('\n'))
    }
  }
  if (out.json) out.result(results.length === 1 ? (results[0] as unknown as Record<string, unknown>) : (results as unknown as Record<string, unknown>[]))
  return exit
}
