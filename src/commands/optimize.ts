// src/commands/optimize.ts
//
// `amdahl optimize`: rewrite messages through POST /api/platform/v1/messages/optimize.
// Each file (or `-` for stdin) runs on its own, one after another, with no
// retry and a 180 s timeout. A result of `ok: false` (the optimizer was
// unreachable or unconfigured) is not a rewrite: it prints the reason and the
// command exits 1. Without `--json`, the message goes to stdout and the
// summary and up to three lines on what Amdahl did go to stderr, then the run
// id. A feedback link to the run's internal page follows only for Amdahl staff
// who turn it on (`feedbackLink` in the config, or AMDAHL_FEEDBACK_LINK=1).
//
// With no file at a terminal it asks for the message to be pasted instead
// (the setup's "This terminal" does the same), and shows Amdahl's version
// under a rule, then what Amdahl did and how to run it next time. An agent
// (CLAUDECODE, CURSOR_AGENT), CI or AMDAHL_NO_PROMPT=1 gets the usage (exit 2).
//
// `--list <file>` (and `--batch <id>`) rewrite a whole list in one batch
// instead: see batch.ts. A file given without `--list` is still one message.
// For a person at a terminal (see terminal.ts), and not under `--json`, a run
// on a workspace with no data connected ends with one line on connecting calls
// or a CRM, so claims can be checked against them. An agent, a pipe and CI make
// no request for it and print no line.

import { amdahlCommand } from '../command-name'
import { feedbackLinkOn } from '../config'
import { apiClient, resolveCredential, toCliError, str, type Credential, type Ctx } from '../context'
import { CliError, EXIT, usageError } from '../errors'
import { readTextFile } from '../files'
import { consoleUrlFor } from '../oauth'
import { printable } from '../output'
import { rememberRun } from '../history'
import { sentLines } from '../next-steps'
import { truthfulSummary } from '../text'
import { atTerminal } from '../terminal'
import { browserSignIn } from './auth'
import { optimizeList } from './batch'

/** Said before a first sign-in: it is also where a new user's workspace is made. */
export const NEW_USER = 'New to Amdahl? The sign-in sets up your free workspace.'

/** Per-file request timeout. */
export const OPTIMIZE_TIMEOUT_MS = 180_000

export const CHANNELS = ['email', 'linkedin']
export const EVIDENCE = ['off', 'workspace']
const ON_UNSUPPORTED = ['flag', 'remove']

/** One file's outcome in `--json` output. */
interface FileResult {
  ok: boolean
  file: string
  result: Record<string, unknown>
}

export function oneOf(flag: string, value: string | undefined, allowed: string[]): string | undefined {
  if (value === undefined) return undefined
  if (!allowed.includes(value)) throw usageError(`--${flag} must be one of: ${allowed.join(', ')}.`)
  return value
}

/** Read and check the `--context` file: a JSON object. */
export function readContext(path: string): Record<string, unknown> {
  const text = readTextFile(path)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw usageError(`--context ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
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

// Every line starts with a verb that says what Amdahl did ("Removed", "Checked",
// "Flagged"). `steps` carries codes (`w3` with `repaired:2,deleted:1`); these
// say them in plain words. An unknown weakest part or second-check reason still
// prints its generic line, since the API says to treat an unknown veto as a
// refusal.
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

// What a second-check veto found, said after "a second-check concern".
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

/** What the `steps` trail did to the message, and what it flagged for the sender. */
function readSteps(steps: Record<string, unknown>[]): { did: string; flagged: string[] } {
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
  const repaired = counts.get('repaired') ?? 0
  const deleted = counts.get('deleted') ?? 0
  if (repaired && deleted) did.push(`Rewrote ${plural(repaired, 'sentence')} and cut ${deleted} that nothing backed.`)
  else if (repaired) did.push(`Rewrote ${plural(repaired, 'sentence')} that did not hold up.`)
  else if (deleted) did.push(`Cut ${plural(deleted, 'sentence')} that nothing backed.`)
  const repair = reasonOf('w5')
  if (changed('w5') && repair.startsWith('repaired:')) {
    const weakest = WEAKEST[repair.slice('repaired:'.length)]
    did.push(weakest ? `Reworked ${weakest}.` : 'Reworked its weakest part.')
  }
  const flagged: string[] = []
  const open = counts.get('open')
  if (open) flagged.push(`${plural(open, 'sentence problem')} it could not fix`)
  const second = reasonOf('w6')
  if (changed('w6') && !second.startsWith('kept_before_repair')) {
    const concern = CONCERNS[second]
    flagged.push(concern ? `a second-check concern (${concern})` : 'a second-check concern')
  }
  return { did: did.join(' '), flagged }
}

/** `a`, `a and b`, `a, b and c`. */
function and(parts: string[]): string {
  return parts.length < 2 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * At most three short lines on what the run did, each starting with what
 * Amdahl did, from fields the API already returns: `evidence` (with
 * `lift.quotes`), `unsupported_claims`, `context_use`, `steps` and `omitted`.
 * `what_changed` is not one of them: it is the same sentence on every run, so
 * it says nothing. The "Flagged" line, what the sender must check before sending,
 * is never dropped; past that, the lines worth most are kept. They print with
 * what Amdahl did first and the flags last. Empty when nothing says anything
 * worth reading.
 */
export function whatAmdahlDid(result: Record<string, unknown>): string[] {
  // A kept draft is not the version the steps describe.
  const steps = result.unchanged === true ? { did: '', flagged: [] } : readSteps(list(result.steps) ?? [])
  const flagged = [...steps.flagged]

  let checked = ''
  let removed = ''
  const evidence = record(result.evidence)
  const claims = list(result.unsupported_claims)
  if (evidence?.used === true) {
    const quotes = record(result.lift)?.quotes
    const read = typeof quotes === 'number' && quotes > 0 ? ` (${plural(quotes, 'quote')})` : ''
    if (claims) {
      const still = claims.filter((c) => c.status !== 'removed').length
      const cut = claims.length - still
      if (cut) removed = `Removed ${plural(cut, 'claim')} your calls don't back.`
      if (still) flagged.unshift(`${plural(still, 'claim')} your calls don't back`)
      checked = `Checked every claim against your calls${read}${claims.length ? '' : " and found none they don't back"}.`
    } else checked = `Checked the message against your calls${read}.`
  } else if (evidence?.requested === 'workspace' && EVIDENCE_MISSED[text(evidence.reason)]) {
    checked = `Skipped checking claims against your calls: ${EVIDENCE_MISSED[text(evidence.reason)]}.`
  }

  const used = (list(record(result.context_use)?.rows) ?? []).filter((r) => r.verdict === 'pass')
  const sources = [
    used.some((r) => r.bucket === 'internal') ? "Amdahl's own records" : '',
    used.some((r) => r.bucket === 'external') ? 'what their company or market published' : '',
  ].filter(Boolean)
  const usedLine = sources.length ? `Used ${plural(sources.length, 'source')}: ${and(sources)}.` : ''

  const omitted = list(result.omitted) ?? []
  const whys = [...new Set(omitted.map((o) => text(o.why)).filter(Boolean))]
  const more = whys.length > 1 ? ` (${plural(whys.length - 1, 'more reason')} in --json)` : ''
  const leftOut = omitted.length
    ? `Left out ${plural(omitted.length, 'thing')}${whys[0] ? `: ${sentence(whys[0])}` : '.'}${more}`
    : ''

  // In print order, each with its rank: 1 is kept first.
  const lines = [
    { rank: 5, line: checked },
    { rank: 3, line: removed },
    { rank: 6, line: usedLine },
    { rank: 7, line: steps.did },
    { rank: 4, line: leftOut },
    { rank: 1, line: flagged.length ? `Flagged ${and(flagged)}; check before sending.` : '' },
  ].filter((l) => l.line && l.line !== '.')
  const kept = new Set([...lines].sort((a, b) => a.rank - b.rank).slice(0, MAX_LINES))
  return lines.filter((l) => kept.has(l)).map((l) => l.line)
}

/**
 * The run id, then a link to the run's page in the console when `feedbackLink`
 * is on. That page is staff-only, so the link is off unless turned on. Empty
 * when the run has no id.
 */
export function feedbackLines(ctx: Ctx, result: Record<string, unknown>): string[] {
  const runId = text(result.run_id)
  if (!runId) return []
  if (!feedbackLinkOn(ctx.io, ctx.config)) return [`Run: ${runId}`]
  const url = `${consoleUrlFor(ctx.io, ctx.apiUrl)}/admin/optimizer/runs/${encodeURIComponent(runId)}`
  return [`Run: ${runId}`, `Feedback: ${url}`]
}

/** What a person is asked when the message is pasted at the terminal. */
export const PASTE_PROMPT = 'Paste an email or LinkedIn message, then press Enter on an empty line:'
/** The rule above Amdahl's version of a pasted message. */
export const VERSION_RULE = "── Amdahl's version ──────────────"

/** The line a pasted run ends with: how to optimize a draft without the paste. */
export function nextTimeLine(ctx: Ctx): string {
  const file = amdahlCommand('optimize draft.txt')
  // pbpaste is macOS's; elsewhere the file is the one way that works everywhere.
  // Two lines, so it fits 80 columns.
  return ctx.io.platform === 'darwin' ? `Next time: ${file},\nor pbpaste | ${amdahlCommand('optimize -')}` : `Next time: ${file}`
}

/** The line after a run on a workspace with no data connected: what connecting adds, and the command. */
export function noDataLine(): string {
  return `Connect calls or a CRM so Amdahl checks claims against them: ${amdahlCommand('connect')}`
}

/**
 * Whether to say, after a run, that the workspace has no data connected: only
 * for a person at a terminal, and never under `--json`.
 */
function tipsOn(ctx: Ctx): boolean {
  return !ctx.out.json && atTerminal(ctx)
}

/**
 * Whether the setup status counts no connection, for the line after a run
 * (a result can also say so itself: {@link saysNoData}). Asks the server only
 * when {@link tipsOn}. Never rejects: anything unknown is "has data", so a
 * workspace that holds data is never told to connect it.
 */
async function noDataConnected(ctx: Ctx, credential: Credential): Promise<boolean> {
  if (!tipsOn(ctx)) return false
  let timer: NodeJS.Timeout | undefined
  // A slow read never holds up the run's last line: past the cap, it says nothing.
  const cap = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), NO_DATA_CHECK_MS)
    timer.unref?.()
  })
  const read = apiClient(ctx, credential)
    .cli.setupStatus()
    .then((status) => 'total' in status.connections && status.connections.total === 0)
    .catch(() => false)
  return Promise.race([read, cap]).finally(() => clearTimeout(timer))
}

/** How long the no-data check's status read may take (it starts beside the rewrite). */
const NO_DATA_CHECK_MS = 5000

/** True when a result itself says the workspace has nothing connected. */
function saysNoData(result: Record<string, unknown>): boolean {
  return Boolean(record(result.setup_needed)) || text(record(result.evidence)?.reason) === 'corpus_empty'
}

/** The channel the request named, when it named one. */
export function channelOf(base: Record<string, unknown>): string | undefined {
  return typeof base.channel === 'string' ? base.channel : undefined
}

/** The request body's options from the flags: channel, evidence, context and the rest. */
export function requestOptions(ctx: Ctx): Record<string, unknown> {
  const { flags } = ctx
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
  return base
}

/** One optimize request, with the timeout, any failure as a CliError. */
export async function optimizeOne(ctx: Ctx, credential: Credential, message: string, base: Record<string, unknown>, file: string): Promise<Record<string, unknown>> {
  try {
    return await withTimeout(
      apiClient(ctx, credential).request<Record<string, unknown>>('/api/platform/v1/messages/optimize', {
        method: 'POST',
        body: { message, ...base },
      }),
      OPTIMIZE_TIMEOUT_MS,
      file
    )
  } catch (err) {
    throw toCliError(err)
  }
}

/**
 * The credential for a pasted run. With no sign-in (or an expired one), signs
 * in through the browser first, so nobody pastes a draft only to hear they
 * are not signed in.
 */
export async function credentialOrSignIn(ctx: Ctx): Promise<Credential> {
  try {
    return await resolveCredential(ctx)
  } catch (err) {
    if (!(err instanceof CliError && err.exit === EXIT.unauthenticated)) throw err
  }
  ctx.out.info(`Sign in first, then paste your message.\n${NEW_USER}`)
  const signedIn = await browserSignIn(ctx)
  ctx.out.info(`✓ Signed in · ${printable(signedIn.workspace.name)}`)
  return resolveCredential(ctx)
}

/**
 * Ask for a message to be pasted at the terminal, optimize it, and show
 * Amdahl's version (stdout) under a rule, what Amdahl did, and how to run it
 * next time (stderr). Signs in first when there is no sign-in. Nothing pasted
 * sends nothing (exit 0).
 */
export async function optimizePasted(ctx: Ctx): Promise<number> {
  const { io, out } = ctx
  const base = requestOptions(ctx)
  const credential = await credentialOrSignIn(ctx)
  const message = await io.readPaste(PASTE_PROMPT)
  if (!message.trim()) {
    out.info(`Nothing pasted, so nothing was sent.\n${nextTimeLine(ctx)}`)
    return EXIT.ok
  }
  out.info('Amdahl is rewriting it. This can take a minute.')
  const noData = noDataConnected(ctx, credential)
  const result = await optimizeOne(ctx, credential, message, base, 'your message')
  if (result.ok !== false) rememberRun(ctx, { run_id: result.run_id, kind: 'optimize', channel: channelOf(base) }, credential)
  if (result.ok === false) {
    if (out.json) out.result({ ok: false, file: '-', result })
    out.info(`Not optimized (${String(result.reason ?? 'unknown')}): ${String(result.detail ?? '')}`)
    return EXIT.general
  }
  if (out.json) {
    out.result({ ok: true, file: '-', result })
    return EXIT.ok
  }
  out.info(VERSION_RULE)
  if (result.unchanged === true) out.info('No rewrite beat your draft; it is returned unchanged.')
  out.result({}, String(result.message ?? ''))
  const did = whatAmdahlDid(result)
  const connect = tipsOn(ctx) && (saysNoData(result) || (await noData)) ? [noDataLine()] : []
  out.info([...did, ...feedbackLines(ctx, result), ...sentLines(result.run_id), ...connect, nextTimeLine(ctx)].join('\n'))
  return EXIT.ok
}

/** `amdahl optimize [<file>... | -]`. */
export async function optimize(ctx: Ctx, args: string[]): Promise<number> {
  const { io, out } = ctx
  // A flag given with an empty value is still the flag: it is refused in optimizeList, not ignored.
  if (typeof ctx.flags.list === 'string' || typeof ctx.flags.batch === 'string') {
    if (args.length > 0) throw usageError('Give the messages with --list <file>, or as files, not both.')
    return optimizeList(ctx, requestOptions(ctx))
  }
  if (ctx.flags['no-wait'] === true) throw usageError('--no-wait goes with --list <file>.')
  if (ctx.flags.force === true) throw usageError('--force goes with --list <file>.')
  if (ctx.flags.for !== undefined) throw usageError('--for goes with --list <file.csv>.')
  let files = args
  if (files.length === 0) {
    // An agent may run commands in a terminal, and so may a CI job: neither can paste, so they get the usage.
    if (atTerminal(ctx)) return optimizePasted(ctx)
    if (io.stdinIsTTY) {
      throw usageError(
        'Give a file to optimize, or pipe the message on stdin.',
        'Usage: amdahl optimize <file>... | - [--channel email|linkedin]'
      )
    }
    files = ['-']
  }
  if (files.filter((f) => f === '-').length > 1) throw usageError('Stdin (-) can be read only once.')

  const base = requestOptions(ctx)

  // Read every input before the first request, so a typo in the third file
  // fails before the first one is spent.
  const inputs: { file: string; message: string }[] = []
  for (const file of files) {
    const message = file === '-' ? await io.readStdin() : readTextFile(file)
    if (!message.trim()) throw usageError(`${file === '-' ? 'Stdin' : file} is empty.`)
    inputs.push({ file, message })
  }

  const credential = await resolveCredential(ctx)
  // Asked beside the first rewrite, so the line after the run adds no wait.
  const noData = noDataConnected(ctx, credential)
  const results: FileResult[] = []
  let exit: number = EXIT.ok
  for (const { file, message } of inputs) {
    const result = await optimizeOne(ctx, credential, message, base, file)
    const ok = result.ok !== false
    results.push({ ok, file, result })
    if (ok) rememberRun(ctx, { run_id: result.run_id, kind: 'optimize', channel: channelOf(base) }, credential)
    if (!ok) {
      exit = EXIT.general
      out.info(`${file}: not optimized (${String(result.reason ?? 'unknown')}): ${String(result.detail ?? '')}`)
      continue
    }
    if (!out.json) {
      if (inputs.length > 1) out.info(`== ${file} ==`)
      if (result.unchanged === true) out.info('No rewrite beat your draft; it is returned unchanged.')
      else if (typeof result.summary === 'string' && truthfulSummary(result.summary, base.context)) out.info(truthfulSummary(result.summary, base.context))
      out.result({}, String(result.message ?? ''))
      const lines = [...whatAmdahlDid(result), ...feedbackLines(ctx, result), ...sentLines(result.run_id)]
      if (lines.length) out.info(lines.join('\n'))
    }
  }
  if (out.json) out.result(results.length === 1 ? (results[0] as unknown as Record<string, unknown>) : (results as unknown as Record<string, unknown>[]))
  else if (tipsOn(ctx) && results.some((r) => r.ok) && (results.some((r) => saysNoData(r.result)) || (await noData))) out.info(noDataLine())
  return exit
}
