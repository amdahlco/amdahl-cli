// src/commands/grade.ts
//
// `amdahl grade <file|->`: grade a draft without rewriting it, through
// POST /api/platform/v1/messages/optimize with `mode: "grade"`. The result has
// no message: only `grade` (five rubric lines, a 1 to 5 score with `passed`
// and `total` beside it) and `disclosures`.
//
// What is printed follows what the API promises:
//   - a grade never stands alone: the score is always printed with its lines,
//     each with its verdict and reason (the evidence it rests on);
//   - a null score is "Not graded", never 0 (a line that could not be
//     evaluated is out of the score, not a fail);
//   - a grade never predicts replies, and it is one reading: both are said on
//     every grade.
// The score is printed as the API returns it. `--json` prints {ok, file, result}
// as `optimize` does.

import { amdahlCommand } from '../command-name'
import { resolveCredential, type Ctx } from '../context'
import { CliError, EXIT, usageError } from '../errors'
import { readTextFile } from '../files'
import { rememberRun } from '../history'
import { field, record, records, wrap } from '../text'
import { askingAllowed } from './feedback'
import { channelOf, credentialOrSignIn, optimizeOne, requestOptions } from './optimize'

/** The rubric's lines, said as the docs name them. An unknown id prints as the server sent it. */
const LINE_NAMES: Record<string, string> = {
  relevant_positioning: 'Relevant positioning',
  grounding: 'Grounding',
  verified_specifics: 'Verified specifics',
  differentiation: 'Differentiation',
  cta_clarity: 'Clear ask',
}

/** Why a line could not be evaluated, in words. Anything else prints as the server's code, spaced. */
const NOT_EVALUATED: Record<string, string> = {
  corpus_empty: 'no calls are synced yet',
  evidence_read_failed: 'Amdahl could not read your calls (our outage, not a fault in the message)',
  evidence_unavailable: 'this environment does not read your calls',
}

/** What the evidence lines read, when they are not evaluated because no evidence was asked for. */
const READS_CALLS = 'Four of the five lines read your customers\' calls; add --evidence workspace to grade them.'

/** `corpus_empty` as `no calls are synced yet`; an unknown code as itself with spaces. */
function reasonWords(code: string): string {
  if (NOT_EVALUATED[code]) return NOT_EVALUATED[code]
  return /^[a-z][a-z0-9_]*$/.test(code) ? code.replace(/_/g, ' ') : code
}

const MARK = { pass: 'pass', fail: 'fail', none: 'n/a ' }

/**
 * The grade for a person, as lines: the score (or "Not graded"), each rubric
 * line with its verdict and reason, what the evidence did, and what a grade
 * does not say. Every line fits 80 columns.
 */
export function gradeLines(result: Record<string, unknown>): string[] {
  const grade = record(result.grade)
  const lines: string[] = []
  const score = typeof grade?.score === 'number' && Number.isFinite(grade.score) ? grade.score : null
  const passed = typeof grade?.passed === 'number' ? grade.passed : null
  const total = typeof grade?.total === 'number' ? grade.total : null
  const bar = typeof grade?.bar === 'number' ? grade.bar : null
  if (score === null) {
    lines.push('Not graded.')
    const why = field(grade?.not_applicable_reason)
    if (why) lines.push(...wrap(`No line could be evaluated: ${reasonWords(why)}.`))
  } else {
    const of = passed !== null && total !== null ? `: ${passed} of ${total} lines passed` : ''
    lines.push(`Grade ${score} of 5${of}.`)
    if (bar !== null && typeof grade?.passes_bar === 'boolean') lines.push(`It ${grade.passes_bar ? 'meets' : 'is below'} the bar of ${bar}.`)
    // A score over fewer lines than the rubric has says so: 1 of 1 passing is 5, but it is one line.
    const rubricSize = records(grade?.lines).length
    if (total !== null && rubricSize > 0 && total < rubricSize) lines.push(...wrap(`It rests on ${total} of the ${rubricSize} lines; the others were not evaluated.`))
  }

  const rubric = records(grade?.lines)
  if (rubric.length > 0) {
    lines.push('', 'The lines it rests on:')
    for (const line of rubric) {
      const id = field(line.id)
      const name = LINE_NAMES[id] ?? id
      const evaluated = line.applicable !== false && typeof line.pass === 'boolean'
      lines.push(`  ${evaluated ? (line.pass === true ? MARK.pass : MARK.fail) : MARK.none}  ${name}`)
      const reason = field(line.reason)
      if (evaluated) {
        if (reason) lines.push(...wrap(reason, 80, '        '))
      } else {
        const code = field(line.not_applicable_reason) || reason
        lines.push(...wrap(`Not evaluated${code ? `: ${reasonWords(code)}` : ''}.`, 80, '        '))
      }
    }
  }

  const evidence = record(result.evidence)
  const abstained = rubric.some((l) => l.applicable === false || l.pass === null)
  if (evidence?.used === true) lines.push('', 'Checked against your calls.')
  else if (evidence?.requested === 'workspace') {
    const why = field(evidence.reason)
    lines.push('', ...wrap(`Not checked against your calls${why ? `: ${reasonWords(why)}` : ''}.`))
  } else if (abstained) lines.push('', ...wrap(READS_CALLS))

  const claims = records(result.unsupported_claims)
  if (claims.length > 0) {
    lines.push('', `${claims.length === 1 ? '1 claim' : `${claims.length} claims`} your calls don't back:`)
    for (const claim of claims.slice(0, 3)) lines.push(...wrap(`- ${field(claim.span)}`, 80, '  '))
    if (claims.length > 3) lines.push(`  and ${claims.length - 3} more (all of them: add --json).`)
  }

  const judge = field(record(grade?.judge)?.model)
  const spread = record(record(result.disclosures)?.repeat_spread)
  const share = typeof spread?.share === 'number' ? Math.round(spread.share * 100) : null
  const moved = typeof spread?.moved_past === 'number' ? spread.moved_past : null
  lines.push(
    '',
    ...wrap(
      `This is one reading${judge ? ` by ${judge}` : ''}. It measures the message against the rubric and your evidence. It does not predict replies.` +
        (share !== null && moved !== null ? ` On a repeat, about ${share}% of texts scored more than ${moved} apart.` : '')
    )
  )
  return lines
}

/** The longest message the server takes, counted with `.length` as the server counts it. */
const MAX_MESSAGE_CHARS = 10_000

/** What `amdahl grade` says to a person who gave it nothing to grade. */
const PASTE_PROMPT = 'Paste the email or LinkedIn message to grade, then press Enter on an empty line:'

/** `amdahl grade <file|->`. */
export async function grade(ctx: Ctx, args: string[]): Promise<number> {
  const { io, out } = ctx
  if (args.length > 1) throw usageError('Give one message to grade: a file, or - for standard input.', `Usage: ${amdahlCommand('grade <file|->')}`)
  const base = { ...requestOptions(ctx), mode: 'grade' }
  let file = args[0]
  let message: string
  let credential
  if (file === undefined) {
    if (askingAllowed(ctx)) {
      credential = await credentialOrSignIn(ctx)
      message = await io.readPaste(PASTE_PROMPT)
      file = '-'
      if (!message.trim()) {
        out.info('Nothing pasted, so nothing was graded.')
        return EXIT.ok
      }
    } else if (io.stdinIsTTY) {
      throw usageError('Give a file to grade, or pipe the message on stdin.', `Usage: ${amdahlCommand('grade <file|->')}`)
    } else {
      file = '-'
      message = await io.readStdin()
    }
  } else {
    message = file === '-' ? await io.readStdin() : readTextFile(file)
  }
  if (!message.trim()) throw usageError(`${file === '-' ? 'Stdin' : file} is empty.`)
  if (message.length > MAX_MESSAGE_CHARS) throw usageError(`A message is at most ${MAX_MESSAGE_CHARS} characters; ${file === '-' ? 'this one' : file} has ${message.length}.`)

  credential ??= await resolveCredential(ctx)
  if (!out.json && io.stderrIsTTY) out.info('Grading it...')
  let result: Record<string, unknown>
  try {
    result = await optimizeOne(ctx, credential, message, base, file ?? '-')
  } catch (err) {
    // The refusal names the call by its path, which a grade shares with a rewrite: say what was asked.
    if (err instanceof CliError && err.message.startsWith('This credential cannot optimize.')) {
      throw new CliError(err.code, err.message.replace('cannot optimize', 'cannot grade'), err.exit, err.hint, err.detail, err.data)
    }
    throw err
  }
  if (result.ok === false) {
    if (out.json) out.result({ ok: false, file, result })
    out.info(`Not graded (${String(result.reason ?? 'unknown')}): ${String(result.detail ?? '')}`)
    return EXIT.general
  }
  rememberRun(ctx, { run_id: result.run_id, kind: 'grade', channel: channelOf(base) }, credential.profile)
  if (out.json) {
    out.result({ ok: true, file, result })
    return EXIT.ok
  }
  const runId = field(result.run_id)
  out.result({}, [...gradeLines(result), ...(runId ? ['', `Run: ${runId}`] : [])].join('\n'))
  return EXIT.ok
}
