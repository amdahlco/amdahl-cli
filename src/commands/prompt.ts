// src/commands/prompt.ts
//
// `amdahl prompt <file|->`: grade or improve a reusable prompt (the
// instructions a writer follows to write an outbound email to any recipient)
// by the emails it writes. POST /api/platform/v1/messages/optimize_prompt
// starts a run and answers at once with its id; GET
// /messages/optimize_prompt/:id?wait_ms= holds the read until the run settles.
// A run takes minutes, so the wait is one long read after another, and the
// run's id is always printed: `amdahl prompt --run <id>` reads it later, and
// `--no-wait` starts it and stops.
//
//   --mode improve (the default) revises the prompt and returns it only when
//          the revision wrote better email on recipients held out of the
//          revising. Its `lift` is that held-out difference and nothing else.
//   --mode grade   writes one email per recipient and grades each; the
//          prompt's grade is their mean.
//
// Neither predicts replies, and both are one reading: said on every result.
// The revised prompt, when there is one, goes to stdout; the report goes to
// stderr. A grade, or a run that kept the prompt, has only the report, on
// stdout. `--json` prints {ok, file, started, result}.

import { amdahlCommand } from '../command-name'
import { apiClient, call, resolveCredential, str, type Credential, type Ctx } from '../context'
import { CliError, EXIT, usageError } from '../errors'
import { readTextFile } from '../files'
import { rememberRun } from '../history'
import { clip, field, paragraphs, record, records, wrap } from '../text'
import { askingAllowed } from './feedback'
import { CHANNELS, credentialOrSignIn, oneOf, readContext } from './optimize'

const PLATFORM = '/api/platform/v1'

/** The longest prompt the server takes (it counts characters, as `.length` does). */
const MAX_PROMPT_CHARS = 20_000

/** Sample recipients a run takes, and how many `improve` needs (some are held out). */
const RECIPIENTS = { min: 1, max: 6, minForImprove: 2 }

/** How long one read holds (the server's cap is 30 s). */
export const PROMPT_WAIT_MS = 30_000

/** How long this command waits for a run in all before it gives the run's id instead. */
export const PROMPT_TIMEOUT_MS = 20 * 60_000

const MODES = ['improve', 'grade']

/** The rubric's lines, named as `amdahl grade` names them. */
const LINE_NAMES: Record<string, string> = {
  relevant_positioning: 'Relevant positioning',
  grounding: 'Grounding',
  verified_specifics: 'Verified specifics',
  differentiation: 'Differentiation',
  cta_clarity: 'Clear ask',
}

/** Why a lift is not a number. */
const LIFT_WHY: Record<string, string> = {
  held_out_under_3: 'fewer than 3 held-out emails on a side (6 recipients give 3)',
  no_revision: 'no revision was kept',
  a_side_not_graded: 'one side could not be graded',
}

/** A mean as the API returns it, or "not graded" for null: never 0. */
function mean(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : 'not graded'
}

function count(n: unknown, one: string, many = `${one}s`): string {
  return typeof n === 'number' ? `${n} ${n === 1 ? one : many}` : ''
}

/** One side of a prompt's grade: `3.4 of 5, over 2 emails, 1 passing the bar of 4.2`; null when nothing was graded. */
function side(grade: Record<string, unknown> | null): string | null {
  if (!grade || typeof grade.mean !== 'number') return null
  const parts = [`${mean(grade.mean)} of 5`]
  const n = count(grade.n, 'email')
  if (n) parts.push(`over ${n}`)
  const bar = typeof grade.bar === 'number' ? grade.bar : null
  if (typeof grade.emails_passing_bar === 'number') parts.push(`${grade.emails_passing_bar} passing${bar !== null ? ` the bar of ${bar}` : ' the bar'}`)
  return parts.join(', ')
}

/** Each line's pass rate over the emails: `Clear ask 2 of 2`, `Grounding not evaluated`. */
function lineRates(grade: Record<string, unknown> | null): string[] {
  const lines = record(grade?.lines)
  if (!lines) return []
  return Object.entries(lines).flatMap(([id, value]) => {
    const row = record(value)
    if (!row) return []
    const name = LINE_NAMES[id] ?? id
    return [typeof row.rate === 'number' && typeof row.passed === 'number' && typeof row.total === 'number' ? `${name} ${row.passed} of ${row.total}` : `${name} not evaluated`]
  })
}

/** Where an email sits in the run, in words. */
const SPLIT: Record<string, string> = { held_out: 'held out', graded: 'graded', train: 'train' }

/** One email the run wrote: who it is for, which version, its grade, and the email. */
function emailLines(email: Record<string, unknown>, showRevisedScore: boolean): string[] {
  const grade = record(email.grade)
  const score = typeof grade?.score === 'number' ? `${grade.score} of 5` : 'not graded'
  const passed = typeof grade?.passed === 'number' && typeof grade?.total === 'number' ? ` (${grade.passed} of ${grade.total} lines)` : ''
  const split = SPLIT[field(email.split)] ?? field(email.split)
  const head = [field(email.label), field(email.variant), split].filter(Boolean).join(', ')
  // A revised email's score beside the original's is a before and after: only a reportable lift may show one.
  const hidden = field(email.variant) === 'revised' && !showRevisedScore
  const lines = [hidden ? `${head || 'Email'}` : `${head || 'Email'}: ${score}${passed}`]
  const text = paragraphs(email.email)
  if (text) lines.push(...wrap(text, 80, '    '))
  const holes = records(email.placeholders).map((p) => field(p.placeholder)).filter(Boolean)
  if (holes.length > 0) lines.push(...wrap(`Still to fill: ${holes.join(', ')}`, 80, '    '))
  const claims = Array.isArray(email.unsupported_claims) ? email.unsupported_claims.length : 0
  if (claims > 0) lines.push(`    ${count(claims, 'claim')} nothing backs.`)
  return lines
}

/**
 * What a settled run says, for a person: the headline for its outcome, the
 * lift only when it is reportable, the lines it rests on, the emails it wrote
 * that the grade rests on, and what a grade does not say.
 */
export function promptRunLines(run: Record<string, unknown>): string[] {
  const outcome = field(run.outcome)
  const grades = record(run.grade)
  const original = record(grades?.original)
  const revised = record(grades?.revised)
  const lines: string[] = []

  const was = side(original)
  const now = side(revised)
  // Only a reportable lift may set the revision against the original: its means side by side are a before and after.
  const reportable = run.lift_reportable === true && typeof run.lift === 'number'
  if (outcome === 'improved' && reportable) {
    lines.push(...wrap(`Amdahl revised your prompt. On the emails held out of the revising it averages ${now ?? 'not graded'}; yours averaged ${was ?? 'not graded'}.`))
  } else if (outcome === 'improved') {
    lines.push(...wrap(`Amdahl kept a revised prompt. Your original averages ${was ?? 'not graded'} on the emails held out of the revising.`))
  } else if (outcome === 'unchanged' && reportable && (run.lift as number) > 0) {
    // The sidecar keeps the prompt when the better revision left placeholders (or another note says why):
    // a revision did score higher, and it was not kept. `notes` below say why.
    lines.push(...wrap(`A revision scored higher on the held-out emails, but Amdahl did not keep it, so your prompt stays as it is. ${was ? `Your prompt averages ${was}.` : ''}`.trim()))
  } else if (outcome === 'unchanged') {
    lines.push(...wrap(`No revision wrote better email on the held-out recipients, so your prompt stays as it is. ${was ? `It averages ${was}.` : 'Its emails could not be graded.'}`))
  } else {
    lines.push(...wrap(was ? `Prompt grade: ${was}.` : 'Not graded: none of its emails could be graded.'))
  }
  if (outcome === 'improved' || outcome === 'unchanged') {
    if (run.lift_reportable === true && typeof run.lift === 'number') {
      const kept = outcome === 'improved'
      lines.push(`${kept ? 'Lift' : "The revision's lift"} on the held-out recipients${kept ? '' : ' (not kept)'}: ${run.lift > 0 ? '+' : ''}${run.lift}.`)
    } else {
      const why = field(run.lift_not_reportable_reason)
      lines.push(...wrap(`No lift is reported${why ? `: ${LIFT_WHY[why] ?? why.replace(/_/g, ' ')}` : ''}.`))
    }
  }

  // What the sidecar says about this run, as it says it (why a better revision was not kept, for one).
  const says = records(run.notes).map((n) => field(n.says)).filter(Boolean)
  for (const note of says) lines.push(...wrap(note))

  const rates = lineRates(original)
  if (rates.length > 0) {
    lines.push('', ...wrap(`Lines, over the ${outcome === 'graded' ? '' : 'held-out '}emails: ${rates.join(', ')}.`))
    // A mean over fewer lines than the rubric has says so: one line passing is a 5, but it is one line.
    const unevaluated = rates.filter((r) => r.endsWith('not evaluated')).length
    if (unevaluated > 0 && unevaluated < rates.length) lines.push(...wrap(`The score rests on ${rates.length - unevaluated} of the ${rates.length} lines; the others were not evaluated.`))
  }

  const emails = records(run.emails)
  const shown = emails.filter((e) => field(e.split) !== 'train')
  if (shown.length > 0) {
    lines.push('', 'Emails it wrote:')
    shown.forEach((email, i) => lines.push(...(i > 0 ? [''] : []), ...emailLines(email, reportable)))
  }
  const trained = emails.length - shown.length
  if (trained > 0) lines.push('', ...wrap(`${count(trained, 'email')} trained the revision. Their scores are not lift; they are in --json.`))

  const judge = field(record(record(run.judges)?.final)?.model)
  lines.push('', ...wrap(`This is one reading${judge ? ` by ${judge}` : ''}. It measures the emails against the rubric and your evidence. It does not predict replies.`))
  return lines
}

/** The recipients file: 1 to 6 objects with a `recipient`, as the API takes them. */
function readRecipients(path: string, mode: string): unknown[] {
  const text = readTextFile(path)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw usageError(`--recipients ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!Array.isArray(parsed)) throw usageError('--recipients must be a JSON array of {"recipient": {...}} objects.', 'Each recipient may have name, company, email, domain, linkedin_url and attributes; also recipient_notes and label.')
  if (parsed.length < RECIPIENTS.min || parsed.length > RECIPIENTS.max) throw usageError(`--recipients needs ${RECIPIENTS.min} to ${RECIPIENTS.max} recipients, not ${parsed.length}.`)
  if (mode === 'improve' && parsed.length < RECIPIENTS.minForImprove) {
    throw usageError('Improving a prompt needs at least 2 recipients: the first half train it, the rest are held out.', 'Add one, or grade the prompt with --mode grade.')
  }
  parsed.forEach((item, i) => {
    if (!record(item) || !record(record(item)?.recipient) || Object.keys(record(record(item)?.recipient) ?? {}).length === 0) {
      throw usageError(`--recipients item ${i + 1} needs a "recipient" object with at least one of name, company, email, domain or linkedin_url.`)
    }
  })
  return parsed
}

/** One read of a run, holding up to {@link PROMPT_WAIT_MS}. */
async function readRun(ctx: Ctx, credential: Credential, id: string, wait = true): Promise<Record<string, unknown>> {
  const query = wait ? `?wait_ms=${PROMPT_WAIT_MS}` : ''
  return call(() => apiClient(ctx, credential).request<Record<string, unknown>>(`${PLATFORM}/messages/optimize_prompt/${encodeURIComponent(id)}${query}`))
}

/** The states a run does not leave. */
const SETTLED = new Set(['complete', 'failed'])

/** Wait for a run to settle: one long read after another. Returns the last read. */
async function waitForRun(ctx: Ctx, credential: Credential, id: string): Promise<Record<string, unknown>> {
  const started = ctx.io.now()
  let phase = ''
  for (;;) {
    const run = await readRun(ctx, credential, id)
    if (SETTLED.has(field(run.status)) || ctx.io.now() - started >= PROMPT_TIMEOUT_MS) return run
    const now = field(run.phase)
    if (now && now !== phase && !ctx.out.json) {
      phase = now
      ctx.out.info(`Working: ${now.replace(/_/g, ' ')}...`)
    }
    // A server that answers at once (no long-poll) is read again a little later, not in a tight loop.
    await ctx.io.sleep(2000)
  }
}

/** Print a run read and say how it ended by the exit code. */
function printRun(ctx: Ctx, file: string | undefined, started: Record<string, unknown> | null, run: Record<string, unknown>): number {
  const { out } = ctx
  const status = field(run.status)
  const id = field(run.run_id) || field(started?.run_id)
  const failed = status === 'failed' || record(run.error) !== null
  const finished = status === 'complete' && !failed
  if (out.json) {
    out.result({ ok: finished, ...(file !== undefined ? { file } : {}), ...(started ? { started } : {}), result: run })
    return finished ? EXIT.ok : EXIT.general
  }
  if (!finished) {
    if (failed) {
      const e = record(run.error)
      out.info(`The prompt run failed${field(e?.message) ? `: ${field(e?.message)}` : '.'}${id ? ` (run ${id})` : ''}`)
    } else {
      out.info(`The run is still going (${status || 'unknown'}).\nRead it later:\n  ${amdahlCommand(`prompt --run ${id}`)}`)
    }
    return EXIT.general
  }
  const report = [...promptRunLines(run), ...(id ? ['', `Run: ${id}`] : [])].join('\n')
  if (field(run.outcome) === 'improved' && typeof run.prompt === 'string' && run.prompt.trim()) {
    out.info(report)
    out.result({}, run.prompt)
  } else out.result({}, report)
  return EXIT.ok
}

/** `amdahl prompt <file|-> [--mode improve|grade] [--recipients <file.json>] [--channel email|linkedin] [--context <file.json>] [--no-wait]`, or `--run <id>`. */
export async function prompt(ctx: Ctx, args: string[]): Promise<number> {
  const { io, out, flags } = ctx
  const usage = `Usage: ${amdahlCommand('prompt <file|-> [--mode improve|grade] [--recipients <file.json>]')}`

  // Read a run started earlier.
  const runId = str(flags.run)
  if (typeof flags.run === 'string') {
    if (!runId) throw usageError('--run needs a run id: the one `amdahl prompt` printed.')
    if (args.length > 0) throw usageError('Give a prompt to run, or --run <id> to read one, not both.', usage)
    for (const flag of ['mode', 'recipients', 'channel', 'context']) {
      if (flags[flag] !== undefined) throw usageError(`--${flag} goes with a prompt to run, not with --run.`)
    }
    const credential = await resolveCredential(ctx)
    if (flags['no-wait'] === true) return printRun(ctx, undefined, null, await readRun(ctx, credential, runId, false))
    if (!out.json && io.stderrIsTTY) out.info('Reading the run. It may still be going.')
    return printRun(ctx, undefined, null, await waitForRun(ctx, credential, runId))
  }

  if (args.length > 1) throw usageError('Give one prompt: a file, or - for standard input.', usage)
  const mode = oneOf('mode', str(flags.mode), MODES) ?? 'improve'
  const channel = oneOf('channel', str(flags.channel), CHANNELS)
  const body: Record<string, unknown> = {}
  if (str(flags.mode)) body.mode = mode
  if (channel) body.channel = channel
  const contextPath = str(flags.context)
  if (contextPath) body.context = readContext(contextPath)
  const recipientsPath = str(flags.recipients)
  if (recipientsPath) body.recipients = readRecipients(recipientsPath, mode)

  let file = args[0]
  let text: string
  let credential: Credential | undefined
  if (file === undefined) {
    if (askingAllowed(ctx)) {
      credential = await credentialOrSignIn(ctx)
      text = await io.readPaste('Paste the prompt, then press Enter on an empty line:')
      file = '-'
      if (!text.trim()) {
        out.info('Nothing pasted, so nothing was sent.')
        return EXIT.ok
      }
    } else if (io.stdinIsTTY) {
      throw usageError('Give a file with the prompt, or pipe the prompt on stdin.', usage)
    } else {
      file = '-'
      text = await io.readStdin()
    }
  } else {
    text = file === '-' ? await io.readStdin() : readTextFile(file)
  }
  if (!text.trim()) throw usageError(`${file === '-' ? 'Stdin' : file} is empty.`)
  if (text.length > MAX_PROMPT_CHARS) throw usageError(`A prompt is at most ${MAX_PROMPT_CHARS} characters; this one has ${text.length}.`)
  body.prompt = text

  credential ??= await resolveCredential(ctx)
  const started = await call(() => apiClient(ctx, credential).request<Record<string, unknown>>(`${PLATFORM}/messages/optimize_prompt`, { method: 'POST', body }))
  const id = field(started.run_id)
  if (!id) throw new CliError('unexpected_response', 'The prompt run started, but the server sent no run id.', EXIT.general)
  rememberRun(ctx, { run_id: id, kind: 'prompt', channel }, credential.profile)

  const rawLabels = record(started.recipients)?.labels
  const labels = Array.isArray(rawLabels) ? rawLabels.map(field).filter(Boolean) : []
  const sampled = record(started.recipients)?.sampled === true
  if (!out.json) {
    const who = labels.length > 0 ? `${count(labels.length, 'recipient')}${sampled ? ', picked from your workspace' : ''}: ${clip(labels.join('; '), 120)}` : ''
    out.info(wrap(`Started a prompt run (${field(started.mode) || mode}, run ${id})${who ? ` on ${who}` : ''}. It takes a few minutes.`).join('\n'))
  }
  if (flags['no-wait'] === true) {
    if (out.json) out.result({ ok: true, file, started })
    else out.info(`Read it later:\n  ${amdahlCommand(`prompt --run ${id}`)}`)
    return EXIT.ok
  }
  if (!out.json) out.info(`If you stop before it ends, read it later:\n  ${amdahlCommand(`prompt --run ${id}`)}`)
  return printRun(ctx, file, started, await waitForRun(ctx, credential, id))
}
