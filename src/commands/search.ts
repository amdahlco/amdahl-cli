// src/commands/search.ts
//
// `amdahl search "<question>"`: one question about the workspace's customers,
// calls and deals, through POST /api/platform/v1/search/query with
// `answer: true`, so a person reads a short cited answer over the rows that
// matched, or the rows themselves. `--json` prints the server's whole answer.
//
// Research is something search starts, never a command of its own. Search
// hands a statistical or long ask to a research job by itself, and
// `--research` asks it to (`route: "research"`). When a job starts, the CLI
// waits on GET /research/:id with `wait_ms` and prints its cited answer, then
// the tables, quotes and figures it rests on (blocks.ts). A
// CLI sign-in cannot start one (it has no `conversations:write`), so the
// server runs the search instead and says so; the CLI then adds one line on
// the key that can (`amdahl keys create --preset agent`).
//
// A workspace with nothing connected answers with `setup_needed`: its
// message and link print, then the command that opens the add page.
//
// `--recipe <id> [--<fill-in> <value>]` asks one of the console's recipe
// questions (recipes.ts, recipes-data.ts) instead of the person's own. When a
// research job starts its id is printed with the command that reads it later,
// and `--research-id <id>` reads a job started earlier (the same wait).

import { amdahlCommand } from '../command-name'
import { apiClient, call, resolveCredential, str, type Credential, type Ctx } from '../context'
import { CliError, EXIT, usageError } from '../errors'
import { blockLines } from '../blocks'
import { clip, count, cutAtWord, day, field, paragraphs, plainMarkdown, record, records, wrap } from '../text'
import { FILL_MAX } from '../recipes-data'
import { connectLine } from './connections'
import { FILL_FLAGS, loadLibrary, recipeById, recipeQuestion } from './recipes'

const PLATFORM = '/api/platform/v1'

/** The longest question the server takes, counted with `.length` (UTF-16 units) as the server counts it. */
const MAX_QUESTION_CHARS = 10_000

/** How long one research read waits on the server (its cap is 45 s). */
export const RESEARCH_WAIT_MS = 45_000

/** How long `search` waits for a research job in all before it gives the job's id instead. */
export const RESEARCH_TIMEOUT_MS = 15 * 60_000

/** Rows a person sees under an answer, and with no answer. */
const ROWS_UNDER_ANSWER = 5
const ROWS_ALONE = 10

/** The sentence that says what research needs: a Customer agent key, and the command that makes one. */
export function researchKeyLine(): string {
  return `Research needs a Customer agent key: ${amdahlCommand('keys create --name research --preset agent')}`
}

/** What a sign-in is told before its search answer, when it asked for research: the key, then what it gets instead. */
export function researchKeyFirst(): string {
  return `${researchKeyLine()}. Here is the search answer instead.`
}

/** The research states a wait ends on. */
const SETTLED = new Set(['complete', 'failed', 'canceled', 'needs_input'])

// Field names a row's title, date and text are found under, across the search
// lanes (warehouse rows, call matches, deal rows). The first one present wins.
const TITLE_FIELDS = ['title', 'call_title', 'meeting_title', 'subject', 'deal_name', 'account_name', 'company_name', 'name']
const DATE_FIELDS = ['occurred_at', 'started_at', 'date', 'call_date', 'call_timestamp', 'close_date', 'created_at', 'updated_at']
// `content_preview` is the quote of a semantic or lexical match.
const TEXT_FIELDS = ['content_preview', 'text', 'quote', 'snippet', 'excerpt', 'content', 'summary', 'body', 'description']
const WHO_FIELDS = ['speaker', 'speaker_name', 'account_name', 'company_name', 'owner_name', 'deal_stage_label', 'speaker_type']
// A deal's amount, said after its stage.
const AMOUNT_FIELDS = ['deal_amount', 'amount']

function first(row: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = row[name]
    if (typeof value === 'string' && value.trim()) return field(value)
    if (typeof value === 'number') return String(value)
  }
  return ''
}

/**
 * One row in at most three lines: its title, who and when, then its text cut
 * to fit. A row with none of the known fields prints its first few scalar
 * fields as `key: value`.
 */
export function rowLines(row: Record<string, unknown>, n: number): string[] {
  const title = first(row, TITLE_FIELDS)
  const who = first(row, WHO_FIELDS)
  const when = day(first(row, DATE_FIELDS))
  const body = first(row, TEXT_FIELDS)
  const amount = first(row, AMOUNT_FIELDS)
  const head = [title, who !== title ? who : '', amount, when].filter(Boolean).join(', ')
  if (head || body) {
    const lines = [`${n}. ${clip(head || body, 74)}`]
    if (head && body) lines.push(...wrap(clip(body, 220), 80, '   ').slice(0, 3))
    return lines
  }
  const pairs = Object.entries(row)
    .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? field(v) : String(v)}`)
  return [`${n}. ${clip(pairs.join(', ') || JSON.stringify(row), 74)}`]
}

/** The rows (or similarity matches) the lane returned. */
function rowsOf(result: Record<string, unknown>): Record<string, unknown>[] {
  return records(result.results)
}

/**
 * What to say when the server found rows but wrote no answer over them:
 * `not_enough_data` (the rows do not answer the question) or `failed`. Empty
 * for an answer, and for `skipped` (no rows, which has its own line).
 */
function noAnswerLines(status: string, rows: number): string[] {
  if (rows === 0) return []
  if (status === 'not_enough_data') {
    return [...wrap(`Amdahl couldn't answer that from these rows. Try rephrasing the question, or run ${amdahlCommand('connections')} to see whether your data is synced.`), '']
  }
  if (status === 'failed') return [...wrap(`Amdahl found rows but couldn't write an answer this time. Here are the rows. Try again, or rephrase the question.`), '']
  return []
}

/** The freeform lane's own envelope (`detail.internal`): its status, its explanation and note, and whether a deadline cut it. */
function internalOf(result: Record<string, unknown>): Record<string, unknown> | null {
  return record(record(result.detail)?.internal)
}

/**
 * Whether the search ran out of time or could not read: a part cut by its
 * deadline (`cut_by: "deadline"`, on the lane or on any sub-question) or a failed
 * read (`corpus.empty_reason: "read_failed"`). Neither is an honest "no match".
 */
export function ranOutOfTime(result: Record<string, unknown>): boolean {
  if (internalOf(result)?.cut_by === 'deadline') return true
  if (records(record(result.detail)?.groups).some((g) => record(g.internal)?.cut_by === 'deadline')) return true
  return record(result.corpus)?.empty_reason === 'read_failed'
}

/**
 * What the server said about an empty or unsupported result, in its own words, trimmed. A search that
 * ran and found nothing (`empty`, `no_match`) says it in `detail.message`: its `explanation` is the
 * query plan ("Looks up deals whose name exactly matches..."), which says nothing of the result. Any
 * other status (`unsupported`, `failed`) is explained by the `explanation`. The `note` is the server's
 * own hint to a program and is never printed.
 */
function serverReason(result: Record<string, unknown>): string {
  const internal = internalOf(result)
  const status = field(internal?.status)
  const code = field(record(result.corpus)?.empty_reason)
  const noMatch = status === 'empty' || (status !== 'unsupported' && status !== 'failed' && (code === 'no_match' || code === ''))
  const message = field(record(result.detail)?.message)
  const said = noMatch ? message : field(internal?.explanation) || message
  return said ? cutAtWord(said, 300) : ''
}

/** What an empty result's reason code says, for a server that gave no sentence of its own. */
const EMPTY_WORDS: Record<string, string> = {
  unsupported: "Amdahl couldn't turn that question into a search it can run.",
  not_synced: "Your data hasn't synced yet, so there was nothing to search.",
  scope_disjoint: "That filter is outside the data this credential can read.",
  weak_matches_only: 'Only weak matches were found, none about the question.',
  spelling_variants_unsearched: 'The search could not look for that spelling. Try the exact words as they are written.',
}

/** A why or compare question: the kind a single search does not answer, and research does. */
const WHY_OR_COMPARE = /\b(why|compar(?:e|es|ed|ing|ison)|versus|vs\.?|differ(?:s|ence|ent)?|how come)\b/i

/** The one next step for an empty or unsupported why or compare question. */
function nextStepLine(): string {
  return wrap('Next: add --research, which can answer a why or compare question (it needs a Customer agent key), or name the company exactly as your CRM spells it.').join('\n')
}

/** The line for a search cut short, with the one way on: research can run longer. */
export function outOfTimeLines(rows: number, researchAsked = false, researchId = ''): string[] {
  // Research was already asked for: it cannot be suggested again. Say it ran out of time even so, and
  // where the job can be read later when it started one.
  if (researchAsked) {
    return wrap(
      `The search ran out of time${rows === 0 ? ' before it found anything' : ', so these rows may be incomplete'}, even with --research.` +
        (researchId ? ` The research job may still finish: read it later with ${amdahlCommand(`search --research-id ${researchId}`)}.` : ' Try again, or narrow the question.')
    )
  }
  return wrap(
    rows === 0
      ? `The search ran out of time before it found anything. Run the same command with --research: it can run longer. ${researchKeyLine()}`
      : `Part of the search ran out of time, so these rows may be incomplete. Run the same command with --research: it can run longer. ${researchKeyLine()}`
  )
}

/**
 * The search answer for a person: the cited answer or the rows, and what the
 * server noted. With no rows it says why in the server's words (its
 * explanation or note), never a bare "No matches.", and for a why or
 * compare `question` it adds the one next step.
 */
export function searchLines(result: Record<string, unknown>, question = '', researchAsked = false): string[] {
  const lines: string[] = []
  const rows = rowsOf(result)
  const answer = record(result.answer)
  const answered = answer?.status === 'answered' && paragraphs(answer.text)
  if (answered) lines.push(...wrap(plainMarkdown(answered)), '')
  else lines.push(...noAnswerLines(field(answer?.status), rows.length))
  const shown = rows.slice(0, answered ? ROWS_UNDER_ANSWER : ROWS_ALONE)
  if (shown.length > 0) {
    if (answered || lines.length > 0) lines.push(answered ? 'From:' : 'Rows it read:')
    shown.forEach((row, i) => lines.push(...rowLines(row, i + 1)))
    if (rows.length > shown.length) lines.push(`And ${count(rows.length - shown.length, 'more row')} (all of them: add --json).`)
  } else if (!answered) {
    const freshness = field(record(result.data_freshness)?.message)
    const reason = serverReason(result)
    const code = field(record(result.corpus)?.empty_reason) || field(internalOf(result)?.status)
    const said = reason || (code && code !== 'no_match' && code !== 'empty' ? EMPTY_WORDS[code] ?? '' : '')
    if (said) lines.push(...wrap(said))
    if (freshness) lines.push(...wrap(freshness))
    if (!said && !freshness) lines.push('No matches.')
    if (!researchAsked && WHY_OR_COMPARE.test(question)) lines.push('', nextStepLine())
  }
  const gap = field(record(result.statistical_gap)?.message)
  if (gap) lines.push(...wrap(gap))
  return lines
}

/** Whether a note says the research handoff was refused for want of a credential that can start one. */
function refusedForScope(notes: string[]): boolean {
  return notes.some((n) => /ran search instead/i.test(n) && /conversations:write|credential/i.test(n))
}

/** The research answer for a person: its cited text, then up to three questions to ask next. */
export function researchLines(job: Record<string, unknown>): string[] {
  const answer = record(job.answer)
  const text = plainMarkdown(paragraphs(answer?.text))
  const lines = wrap(text || 'The research finished with no answer.')
  if (answer?.partial === true) lines.push('', 'It stopped at its budget, so this answers from what it had read.')
  // What the answer rests on (tables, quotes, figures), in the order the job presented it.
  const details = blockLines(answer?.content_blocks, text)
  if (details.length > 0) lines.push('', 'Details:', ...details)
  const next = (Array.isArray(answer?.follow_ups) ? answer.follow_ups : []).map(field).filter(Boolean).slice(0, 3)
  if (next.length > 0) {
    lines.push('', 'Ask next:')
    for (const q of next) lines.push(...wrap(`- ${q}`))
  }
  return lines
}

/**
 * Wait for a research job to settle: one long-poll read after another, up to
 * {@link RESEARCH_TIMEOUT_MS}. Returns the last read.
 */
async function waitForResearch(ctx: Ctx, credential: Credential, id: string): Promise<Record<string, unknown>> {
  const client = apiClient(ctx, credential)
  const started = ctx.io.now()
  for (;;) {
    const job = await call(() => client.request<Record<string, unknown>>(`${PLATFORM}/research/${encodeURIComponent(id)}?wait_ms=${RESEARCH_WAIT_MS}`))
    if (SETTLED.has(field(job.status)) || ctx.io.now() - started >= RESEARCH_TIMEOUT_MS) return job
    // A server that answers at once (no long-poll) is read again a little later, not in a tight loop.
    await ctx.io.sleep(2000)
  }
}

/** The line that says how to read a research job later, by its id. */
export function researchLaterLine(id: string): string {
  return `Read it later:\n  ${amdahlCommand(`search --research-id ${id}`)}`
}

/** A research id is a run id: a UUID. */
const RESEARCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `amdahl search --research-id <id>`: read a research job started earlier,
 * waiting for it as `search --research` does, and print it the same way. It
 * needs a credential that can read research (a Customer agent key).
 */
async function readResearch(ctx: Ctx, args: string[]): Promise<number> {
  const id = str(ctx.flags['research-id'])
  const usage = `Usage: ${amdahlCommand('search --research-id <id>')}`
  if (!id) throw usageError('--research-id needs the id of a research job.', usage)
  if (args.length > 0 || ctx.flags.recipe !== undefined || ctx.flags.research === true || ctx.flags.limit !== undefined) {
    throw usageError('--research-id reads a job that already started: give it alone.', usage)
  }
  if (!RESEARCH_ID.test(id)) throw usageError(`"${field(id).slice(0, 40)}" is not a research id.`, `A research id looks like 9fd4f2e3-bc8e-436b-86d7-a677a89e8d16; search prints it when a job starts. ${usage}`)
  const credential = await resolveCredential(ctx)
  let job: Record<string, unknown>
  try {
    job = await waitForResearch(ctx, credential, id)
  } catch (err) {
    if (err instanceof CliError && err.exit === EXIT.forbidden) {
      throw new CliError('missing_scope', `This credential can't read research ${id}.`, EXIT.forbidden, researchKeyLine())
    }
    // An id that is no job of this workspace's: the server's own words name a `research://` address, which is no use to a person.
    if (err instanceof CliError && (err.code === 'not_found' || err.code === 'http_404' || /research:\/\//i.test(err.message))) {
      throw new CliError('not_found', 'No research job with that id in this workspace.', err.exit, `Check the id: search prints it when a job starts. A job started in another workspace can't be read here. ${usage}`)
    }
    throw err
  }
  return printResearch(ctx, {}, job)
}

/** The recipe flags a command line gave, by fill-in key. */
function fillValues(ctx: Ctx): Record<string, string | undefined> {
  return Object.fromEntries(FILL_FLAGS.map((key) => [key, typeof ctx.flags[key] === 'string' ? (ctx.flags[key] as string) : undefined]))
}

/** `amdahl search "<question>" [--research] [--limit <n>]`, `--recipe <id> [--<fill-in> <value>]`, or `--research-id <id>`. */
export async function search(ctx: Ctx, args: string[]): Promise<number> {
  const { out } = ctx
  if (typeof ctx.flags['research-id'] === 'string') return readResearch(ctx, args)
  let question = args.join(' ').trim()
  let recipeServerId: string | undefined
  const fills = fillValues(ctx)
  if (typeof ctx.flags.recipe === 'string') {
    if (question) throw usageError('Give a question or --recipe, not both.', `${amdahlCommand('recipes')} lists the recipes.`)
    // The library as the server has it, else the bundled copy; `recipe_id` goes with the search only when the server was read.
    const library = await loadLibrary(ctx)
    const recipe = recipeById(ctx.flags.recipe, library)
    if (recipe.fills.some((f) => !FILL_FLAGS.includes(f.key))) {
      throw usageError(`${recipe.title} takes a fill-in this version of amdahl does not know.`, 'Update amdahl: npm install -g amdahl@latest.')
    }
    recipeServerId = library.source === 'server' ? recipe.id : undefined
    const built = recipeQuestion(recipe, fills)
    question = built.question
    if (built.cut.length > 0 && !out.json) out.info(`Used the first ${FILL_MAX} characters of ${built.cut.map((k) => `--${k}`).join(' and ')}.`)
    if (!out.json) out.info(wrap(`${recipe.title}: ${question}`).join('\n'))
  } else {
    const stray = FILL_FLAGS.find((key) => fills[key] !== undefined)
    if (stray) throw usageError(`--${stray} goes with --recipe <id>.`, `${amdahlCommand('recipes')} lists the recipes.`)
  }
  if (!question) throw usageError('Ask a question.', `Usage: ${amdahlCommand('search "<question>" [--research]')}. Or a recipe: ${amdahlCommand('recipes')}`)
  if (question.length > MAX_QUESTION_CHARS) throw usageError(`A question is at most ${MAX_QUESTION_CHARS} characters.`)
  const body: Record<string, unknown> = { query: question, answer: true }
  if (recipeServerId) body.recipe_id = recipeServerId
  if (ctx.flags.research === true) body.route = 'research'
  const limit = str(ctx.flags.limit)
  if (limit !== undefined) {
    const n = Number(limit)
    if (!Number.isInteger(n) || n < 1) throw usageError('--limit must be a whole number above 0.')
    body.limit = n
  }

  const credential = await resolveCredential(ctx)
  const client = apiClient(ctx, credential)
  if (!out.json && ctx.io.stderrIsTTY) out.info('Searching...')
  const result = await call(() => client.request<Record<string, unknown>>(`${PLATFORM}/search/query`, { method: 'POST', body }))
  const notes = (Array.isArray(result.notes) ? result.notes : []).map(field).filter(Boolean)
  const setup = record(result.setup_needed)
  const handoff = record(result.research)

  // A fresh handle carries no answer, even one that says `complete` (a cached job): read the job.
  if (handoff && field(handoff.research_id) && !record(handoff.answer)) {
    if (!out.json && field(handoff.status) !== 'complete') {
      out.info(`Amdahl started research on it. This can take a few minutes.\nResearch id: ${field(handoff.research_id)}\n${researchLaterLine(field(handoff.research_id))}`)
    }
    let job: Record<string, unknown>
    try {
      job = await waitForResearch(ctx, credential, field(handoff.research_id))
    } catch (err) {
      // The job started but this credential cannot read it back: an error, in --json too, with the
      // search answer (and the job's id) beside it.
      if (err instanceof CliError && err.exit === EXIT.forbidden) {
        throw new CliError('missing_scope', `Research ${field(handoff.research_id)} started, but this credential can't read it.`, EXIT.forbidden, researchKeyLine(), undefined, result)
      }
      throw err
    }
    return printResearch(ctx, result, job)
  }
  if (handoff && field(handoff.status)) return printResearch(ctx, result, handoff)

  const rows = rowsOf(result)
  const answered = record(result.answer)?.status === 'answered'
  // A search cut by its deadline (or a failed read) found nothing because it ran out of time: that is
  // not "no matches". With nothing to show it is a failure (exit 1) that points at research.
  const cut = !setup && ranOutOfTime(result)
  if (out.json) {
    const failed = cut && rows.length === 0 && !answered
    out.result({ ...result, ok: !failed })
    return failed ? EXIT.general : EXIT.ok
  }
  const researchAsked = ctx.flags.research === true
  const researchId = field(handoff?.research_id)
  if (cut && rows.length === 0 && !answered) {
    out.info(outOfTimeLines(0, researchAsked, researchId).join('\n'))
    return EXIT.general
  }
  if (cut) out.info(outOfTimeLines(rows.length, researchAsked, researchId).join('\n'))
  if (setup) {
    out.result({}, [...wrap(field(setup.message) || 'This workspace has no data connected yet.'), connectLine()].join('\n'))
    return EXIT.ok
  }
  // Said before any rows: a person who asked for research should hear first why this is not it.
  if (refusedForScope(notes)) out.info(wrap(researchKeyFirst()).join('\n'))
  else {
    const refused = notes.find((n) => /ran search instead/i.test(n))
    if (refused) out.info(wrap(refused).join('\n'))
  }
  out.result({}, searchLines(result, question, ctx.flags.research === true).join('\n'))
  return EXIT.ok
}

/** Print a settled (or still running) research job; the exit code says how it ended. */
function printResearch(ctx: Ctx, search: Record<string, unknown>, job: Record<string, unknown>): number {
  const { out } = ctx
  const status = field(job.status)
  const id = field(job.research_id)
  if (out.json) {
    out.result({ ...search, ok: status === 'complete', research: job })
    return status === 'complete' ? EXIT.ok : EXIT.general
  }
  if (status === 'complete') {
    out.result({}, researchLines(job).join('\n'))
    return EXIT.ok
  }
  if (status === 'running') {
    out.info(`The research is still running.\nResearch id: ${id}\n${researchLaterLine(id)}\nOr open it in the console: ${amdahlCommand('open')}`)
    return EXIT.general
  }
  if (status === 'needs_input') {
    const q = field(record(job.question_for_you)?.question)
    out.info(`The research stopped on a question it can't ask here${q ? `: ${q}` : '.'} Ask again with more detail.`)
    return EXIT.general
  }
  out.info(`The research ${status === 'canceled' ? 'was canceled' : 'failed'}${field(job.error) ? `: ${field(job.error)}` : '.'}`)
  return EXIT.general
}
