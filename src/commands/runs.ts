// src/commands/runs.ts
//
// `amdahl runs`: the runs this computer made. The API has no read that lists a
// person's optimize runs, so the CLI keeps the ids it started (`history.ts`:
// id, time, kind and channel, never any text). Runs made from the console or
// an AI client are not in it; `amdahl run <id>` opens any run the person made,
// wherever it was made.
//
// `amdahl run <id>`: one run, read from GET /messages/optimize/runs/:id
// (`messages.get_run`): the draft the person sent and the message Amdahl
// returned, one above the other, and what the message left out. Only the person
// who made a run can read it; anyone else's id, another workspace's and an
// unknown id are the same not-found.

import { amdahlCommand } from '../command-name'
import { apiClient, call, resolveCredential, str, type Ctx } from '../context'
import { CliError, EXIT, usageError } from '../errors'
import { currentOwner, findRun, recentRuns, type RunRecord } from '../history'
import { count, field, paragraphs, record, records, wrap } from '../text'
import { gradeLines } from './grade'
import { runId } from './feedback'

const PLATFORM = '/api/platform/v1'

/** Runs shown by default. */
const DEFAULT_LIMIT = 10

/** `2026-11-12 09:30` (UTC) from an ISO time. */
function minute(iso: string): string {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : ''
}

const NOTE = 'Runs made from this computer. A run made in the console or an AI client is not listed here, but its id opens: amdahl run <id>.'

/** `amdahl runs [--limit <n>]`. */
export async function runs(ctx: Ctx): Promise<number> {
  const { out } = ctx
  const limitFlag = str(ctx.flags.limit)
  let limit = DEFAULT_LIMIT
  if (limitFlag !== undefined) {
    limit = Number(limitFlag)
    if (!Number.isInteger(limit) || limit < 1) throw usageError('--limit must be a whole number above 0.')
  }
  const owner = currentOwner(ctx)
  const all = recentRuns(ctx, owner)
  const shown = all.slice(0, limit)
  if (out.json) {
    out.result({ ok: true, source: 'this_computer', note: NOTE, ...(owner.key ? { key: owner.key } : {}), total: all.length, runs: shown.map(({ run_id, created_at, kind, channel }) => ({ run_id, created_at, kind, ...(channel ? { channel } : {}) })) })
    return EXIT.ok
  }
  if (all.length === 0) {
    out.result({}, [...wrap('No runs yet from this computer.'), ...wrap(`${amdahlCommand('optimize draft.md')} makes one, and it is listed here.`)].join('\n'))
    return EXIT.ok
  }
  const row = (r: RunRecord) => `${r.run_id}  ${minute(r.created_at)}  ${r.kind.padEnd(9)}${r.channel ?? ''}`.trimEnd()
  const more = all.length > shown.length ? [`And ${count(all.length - shown.length, 'older run')} (all of them: add --limit ${all.length}).`] : []
  // A key's runs are its own: say which key, so a list is never read as another workspace's or a sign-in's.
  const whose = owner.key ? ` made with the key ${owner.key}...` : ''
  out.result(
    {},
    [`Your latest runs${whose}, newest first (times are UTC):`, ...shown.map(row), '', ...wrap(NOTE), ...more, `Open one: ${amdahlCommand('run <run-id>')}`, `Prompt runs: ${amdahlCommand('prompt --run <run-id>')}`].join('\n')
  )
  return EXIT.ok
}

/** What the run was sent: its context, said in counts. */
function contextLine(context: unknown): string {
  const c = record(context)
  if (!c) return ''
  const parts = [
    Array.isArray(c.facts) && c.facts.length ? count(c.facts.length, 'fact') : '',
    Array.isArray(c.rules) && c.rules.length ? count(c.rules.length, 'rule') : '',
    Array.isArray(c.voice_examples) && c.voice_examples.length ? count(c.voice_examples.length, 'voice example') : '',
  ].filter(Boolean)
  return parts.length ? `You sent ${parts.join(', ')}.` : ''
}

/** What a run read back says of its grade: the grade itself when the API returned it, else that it is not stored. */
const gradeNotStored = () => `A run does not keep its grade, so it cannot be shown again. Grade the draft again: ${amdahlCommand('grade <file>')}.`

/**
 * One run for a person: the draft, then the message, then what was left out.
 * `madeAsGrade`: this computer's history says the run was a grade, so a grade
 * is expected, and a run that does not return one says it is not stored.
 */
export function runLines(run: Record<string, unknown>, madeAsGrade = false): string[] {
  const id = field(run.run_id)
  const when = minute(field(run.created_at))
  const draft = paragraphs(run.draft)
  const message = paragraphs(run.message)
  const lines = [`Run ${id}${when ? `, made ${when} UTC` : ''}`, '']
  lines.push('Your draft:')
  lines.push(...(draft ? wrap(draft, 80, '  ') : ['  You sent none: Amdahl wrote it from your facts and rules.']))
  lines.push('', "Amdahl's message:")
  // A grade writes nothing, and the stored run can carry the draft back as its message: the same text is no rewrite.
  if (message && draft && message === draft) lines.push('  The same as your draft: Amdahl changed nothing (a grade writes no message).')
  else lines.push(...(message ? wrap(message, 80, '  ') : ['  Amdahl wrote no message for this run (a grade writes none).']))
  const omitted = records(run.omitted)
  if (omitted.length > 0) {
    lines.push('', 'Left out:')
    for (const o of omitted) lines.push(...wrap(`- ${field(o.what)}${field(o.why) ? `: ${field(o.why)}` : ''}`, 80, '  '))
  }
  const sent = contextLine(run.context)
  if (sent) lines.push('', sent)
  // A grade, when the API returned one with the run; otherwise, for a run known to be a grade (made here as
  // one, or whose message is the draft), that it is not stored. A rewrite has no grade to show.
  if (record(run.grade)) lines.push('', ...gradeLines(run))
  else if (madeAsGrade || (message && draft && message === draft)) lines.push('', ...wrap(gradeNotStored()))
  return lines
}

/** `amdahl run <run-id>`. */
export async function run(ctx: Ctx, args: string[]): Promise<number> {
  const usage = `Usage: ${amdahlCommand('run <run-id>')}`
  const [raw, ...rest] = args
  if (!raw || rest.length > 0) throw usageError('Give one run id.', `${usage}. ${amdahlCommand('runs')} lists the latest runs made from this computer.`)
  // A prompt run's id is `opt_` and 32 hex characters, not a UUID: it is read with `prompt --run`.
  if (/^opt_[0-9a-f]+$/i.test(raw)) throw usageError(`${raw} is a prompt run.`, `Read it with: ${amdahlCommand(`prompt --run ${raw}`)}`)
  const id = runId(raw, usage)
  const credential = await resolveCredential(ctx)
  let result: Record<string, unknown>
  try {
    result = await call(() => apiClient(ctx, credential).request<Record<string, unknown>>(`${PLATFORM}/messages/optimize/runs/${encodeURIComponent(id)}`))
  } catch (err) {
    if (err instanceof CliError && (err.code === 'not_found' || err.code === 'http_404')) {
      throw new CliError(err.code, `No run ${id} from you in this workspace.`, err.exit, `Only the person who made a run can open it. ${amdahlCommand('runs')} lists the ones this computer made.`)
    }
    throw err
  }
  ctx.out.result({ ...result, ok: true }, runLines(result, findRun(ctx, id)?.kind === 'grade').join('\n'))
  return EXIT.ok
}
