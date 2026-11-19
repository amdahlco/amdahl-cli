// src/commands/sequence.ts
//
// `amdahl sequence`: improve, or write, a sequence of 2 to 10 emails, each one
// written as a follow-up to the final emails before it. The console's Sequence
// tab does the same (see sequence-parse.ts for what is copied from it).
//
//   amdahl sequence <file|->         improve the emails in a text, markdown or CSV file
//   amdahl sequence --write "<goal>" write a new sequence, 2 to 6 emails, from a plan
//   amdahl sequence                  at a terminal: pick one of the two, then answer
//   amdahl sequence <file> --leads <list.csv>   a sequence for each person in a lead list
//                                    (see sequence-leads.ts)
//
// Every email is checked before the first request, so a typo costs nothing.
// The emails print one at a time as each comes back (the text on stdout, what
// Amdahl changed on stderr). A file is written only with `--csv`: all the
// emails, or, when the run stopped, the ones that came back. An agent, CI, a
// pipe, `--json` or AMDAHL_NO_PROMPT=1 is never asked a question. `--json`
// prints one document: see jsonDocument in sequence-run.ts.

import { existsSync } from 'node:fs'
import { amdahlCommand } from '../command-name'
import { resolveCredential, str, type Credential, type Ctx } from '../context'
import { EXIT, usageError } from '../errors'
import { PromptCancelled } from '../io'
import { readTextFile } from '../files'
import { DEFAULT_STEPS, GOAL_CHARS, MAX_PLAN_RULES, MAX_RULES, MAX_STEPS, MIN_STEPS, STARTERS, parsePlan, stepLine, suggestPlan, type PlanStep } from '../sequence-plan'
import { MAX_EMAILS, emailProblem, emailsFromCsv, splitSequence, type FinalEmail, type SeqEmail } from '../sequence-parse'
import { atTerminal, canAsk } from '../terminal'
import { credentialOrSignIn, requestOptions } from './optimize'
import { checkLeadsFlags, readLeadsFile, sequenceLeads } from './sequence-leads'
import { assertFree, checkCsvTarget, csvTarget, defaultTarget, readSaved, saveCsv } from './sequence-csv'
import { failureLine, fieldLines, jsonDocument, runSequence, sentThemLine, type Job } from './sequence-run'

const PASTE_PROMPT = 'Paste your emails, with a line of --- between them, then press Enter on an empty line:'
const IMPROVE = 'Improve emails I have'
const WRITE = 'Write a new sequence with Amdahl'
const OWN_GOAL = 'Type my own goal'

const USAGE = 'Usage: amdahl sequence <file> | -   or   amdahl sequence --write "<goal>"'

/** The emails in a file (text, markdown or CSV) or on stdin. */
async function readEmails(ctx: Ctx, file: string, leads: boolean): Promise<SeqEmail[]> {
  const text = file === '-' ? await ctx.io.readStdin() : readTextFile(file)
  if (!text.trim()) throw usageError(`${file === '-' ? 'Stdin' : file} is empty.`)
  if (file !== '-' && /\.(csv|tsv)$/i.test(file)) {
    const read = emailsFromCsv(text)
    if (!read.ok) throw usageError(read.error)
    if (read.rows > 1 && !leads) ctx.out.info(`This file has ${read.rows} rows; a sequence reads one. For a sequence per person: ${amdahlCommand('sequence <file> --leads <list.csv>')}`)
    return read.emails
  }
  return splitSequence(text)
}

/** What the split found, for a person at a terminal to check before anything is sent: each email's first line. */
function foundLines(emails: SeqEmail[]): string {
  const first = (e: SeqEmail) => (e.subject.trim() ? `Subject: ${e.subject.trim()}` : e.body.trim().split('\n')[0] ?? '').slice(0, 60)
  return [`Found ${emails.length} emails:`, ...emails.map((e, i) => `  ${i + 1}. ${first(e)}`)].join('\n')
}

/** Refuse a sequence that cannot run, before anything is sent. */
function checkEmails(emails: SeqEmail[], has: string, text = true): void {
  if (emails.length < 2) {
    const found = `Found ${emails.length} ${emails.length === 1 ? 'email' : 'emails'}.`
    const hint = `For one email: ${amdahlCommand('optimize <file>')}`
    throw usageError(text ? `${found} Put a line of --- between emails.` : `${found} A sequence needs 2 or more.`, hint)
  }
  if (emails.length > MAX_EMAILS) throw usageError(`Amdahl improves up to ${MAX_EMAILS} emails. ${has} ${emails.length}.`)
  const problem = emailProblem(emails)
  if (problem) throw usageError(problem)
}

/** The goal, checked: not empty, at most 300 characters. */
function checkGoal(goal: string): string {
  const text = goal.trim()
  if (!text) throw usageError('Say what the sequence is for.', `Usage: ${amdahlCommand('sequence --write "<goal>"')}`)
  if (text.length > GOAL_CHARS) throw usageError(`The goal is ${text.length} characters. Amdahl takes up to ${GOAL_CHARS}.`)
  return text
}

/** An email count, 2 to 6. */
function checkCount(raw: string, flag: string): number {
  const n = Number(raw.trim())
  if (!Number.isInteger(n) || n < MIN_STEPS || n > MAX_STEPS) throw usageError(`${flag} must be a whole number from ${MIN_STEPS} to ${MAX_STEPS}.`)
  return n
}

/** The plan: the `--plan` file when given (it sets the count), else the suggestion for the goal. */
function planFor(ctx: Ctx, goal: string, asked: number | undefined): PlanStep[] {
  const path = str(ctx.flags.plan)
  const flag = typeof ctx.flags.emails === 'string' ? checkCount(ctx.flags.emails, '--emails') : undefined
  if (path) {
    const steps = parsePlan(readTextFile(path), path)
    if (flag !== undefined && flag !== steps.length) throw usageError(`--emails ${flag} does not match the ${steps.length} emails in ${path}.`)
    return steps
  }
  return suggestPlan(goal, flag ?? asked ?? DEFAULT_STEPS)
}

/** The plan as the question's lines. */
function planText(steps: PlanStep[]): string {
  return [`The plan, ${steps.length} emails:`, ...steps.map((s, i) => `  ${i + 1}. ${stepLine(s)}`)].join('\n')
}

/** Print the plan and ask whether to write it. False when the answer is no. */
async function confirmPlan(ctx: Ctx, steps: PlanStep[]): Promise<boolean> {
  ctx.out.info(planText(steps))
  const answer = (await ctx.io.prompt(`Write these ${steps.length} emails? [Y/n]`)).trim()
  if (answer === '' || /^y/i.test(answer)) return true
  ctx.out.info(`Nothing was written. To change the plan, put one email per line in a file (Name: job) and run: ${amdahlCommand('sequence --write "<goal>" --plan plan.txt')}`)
  return false
}

/** The request options: email only, plus `--evidence`, `--on-unsupported` and the `--context` file. */
function requestBase(ctx: Ctx): Pick<Job, 'base' | 'fileContext'> {
  if (ctx.flags.channel !== undefined) throw usageError('--channel does not go with sequence: a sequence is email only.')
  const { context, ...rest } = requestOptions(ctx)
  const fileContext = (context as Record<string, unknown> | undefined) ?? null
  if (fileContext && 'prior_touches' in fileContext) throw usageError('--context cannot have prior_touches: Amdahl sends the emails before each one itself.')
  return { base: { channel: 'email', ...rest }, fileContext }
}

/**
 * A sequence to write: the goal, the plan, and the blank emails. `before` runs
 * after the checks and before the plan is shown, so a missing sign-in is found
 * before anyone is asked "Write these N emails?". Null when the person said no.
 */
async function writeJob(ctx: Ctx, goal: string, asked: number | undefined, ask: boolean, fileContext: Job['fileContext'], before: () => Promise<void>): Promise<Pick<Job, 'emails' | 'plan'> | null> {
  const checked = checkGoal(goal)
  const steps = planFor(ctx, checked, asked)
  const fileRules = Array.isArray(fileContext?.rules) ? fileContext.rules.length : 0
  if (fileRules + MAX_PLAN_RULES > MAX_RULES) throw usageError(`--context has ${fileRules} rules. With the plan's ${MAX_PLAN_RULES}, Amdahl takes at most ${MAX_RULES} for an email. Remove ${fileRules + MAX_PLAN_RULES - MAX_RULES}.`)
  if (ask) await before()
  if (ask && !(await confirmPlan(ctx, steps))) return null
  return { emails: steps.map((_, i) => ({ subject: '', body: '', sameThread: i > 0 })), plan: { goal: checked, steps } }
}

/** At a terminal with nothing given: the choice, then the paste or the goal. Null when nothing was pasted or the plan was declined. */
async function askJob(ctx: Ctx, fileContext: Job['fileContext'], before: () => Promise<void>): Promise<Pick<Job, 'emails' | 'plan'> | null> {
  const { io, out } = ctx
  const pick = await io.select('What do you want to do?', [IMPROVE, WRITE], { initial: 0 })
  if (pick === 0) {
    const text = await io.readPaste(PASTE_PROMPT)
    if (!text.trim()) {
      out.info('Nothing pasted, so nothing was sent.')
      return null
    }
    const emails = splitSequence(text)
    checkEmails(emails, 'You pasted')
    return { emails, plan: null }
  }
  const start = await io.select('What is the sequence for?', [...STARTERS.map((s) => `${s.name}: ${s.line}`), OWN_GOAL], { initial: 0 })
  const goal = STARTERS[start]?.goal ?? (await io.prompt('What is the sequence for? Say it in a sentence or two:'))
  const answer = (await io.prompt(`How many emails, ${MIN_STEPS} to ${MAX_STEPS}? Enter for ${DEFAULT_STEPS}:`)).trim()
  return writeJob(ctx, goal, answer ? checkCount(answer, 'The number of emails') : undefined, true, fileContext, before)
}

/** The line that says how to keep the emails, for a person at a terminal. */
function csvTip(file: string | null, writing: boolean): string {
  if (file && file !== '-') return `To save them as a CSV: ${amdahlCommand(`sequence ${file} --csv`)}`
  return writing ? 'To save them as a CSV: run the same command with --csv.' : `To save them as a CSV: ${amdahlCommand('sequence <file> --csv')}`
}

/** `--from <n>`: the email to start at (from 2), or null. */
function fromFlag(ctx: Ctx, file: string | undefined, writeFlag: string | undefined, leads: boolean): number | null {
  const raw = ctx.flags.from
  if (raw === undefined) return null
  const n = Number(String(raw).trim())
  if (!Number.isInteger(n) || n < 2 || n > MAX_EMAILS) throw usageError(`--from must be a whole number from 2 to ${MAX_EMAILS}: the email to improve next.`)
  if (leads || writeFlag !== undefined || file === undefined) throw usageError('--from goes with improving a file of emails, after a run saved some with --csv.')
  return n
}

/** The finished emails before `--from`, read from the CSV an earlier run saved. */
function savedBefore(ctx: Ctx, file: string, from: number): { path: string; finals: FinalEmail[] } {
  const flag = typeof ctx.flags.csv === 'string' ? ctx.flags.csv : null
  if (file === '-' && !flag) throw usageError('--from needs the CSV an earlier run saved: add --csv <file.csv>.')
  const path = flag || defaultTarget(ctx, file)
  const read = readSaved(ctx, path, from - 1)
  if ('error' in read) throw usageError(read.error)
  return { path, finals: read.finals }
}

/** What to run next after a stop: the same command, `--from` the next email, on the saved file. */
function continueLine(file: string | null, path: string, next: number): string {
  return `To pick up: ${amdahlCommand(`sequence ${file ?? '<file>'} --csv ${path} --from ${next}`)}`
}

/** `amdahl sequence [<file>|-] [--write "<goal>"]`. */
export async function sequence(ctx: Ctx, args: string[]): Promise<number> {
  const { flags, out } = ctx
  const file = args[0]
  const writeFlag = typeof flags.write === 'string' ? flags.write : undefined
  checkCsvTarget(ctx, args, writeFlag !== undefined)
  if (args.length > 1) throw usageError('Give one file of emails, or - for stdin.', USAGE)
  if (file !== undefined && writeFlag !== undefined) throw usageError('Give the emails to improve, or --write "<goal>", not both.')
  if (writeFlag === undefined && (flags.emails !== undefined || flags.plan !== undefined)) throw usageError('--emails and --plan go with --write "<goal>".')
  checkLeadsFlags(ctx, file, writeFlag)
  const leads = typeof flags.leads === 'string' ? readLeadsFile(ctx) : null
  if (flags.force === true && typeof flags.csv !== 'string' && !leads) throw usageError('--force goes with --csv.')
  const from = fromFlag(ctx, file, writeFlag, leads !== null)
  const bare = file === undefined && writeFlag === undefined
  // An agent, CI, a pipe and --json cannot be asked: they get the usage.
  if (bare && !(atTerminal(ctx) && !out.json)) throw usageError('Give a file of emails, or a goal to write them from.', USAGE)

  const saved = from !== null && file !== undefined ? savedBefore(ctx, file, from) : null
  // --from reads the CSV an earlier run saved, and writes the whole sequence back to it, with or without --csv.
  const target = csvTarget(ctx, file ?? null) ?? saved?.path ?? null
  if (target) assertFree(ctx, target, flags.force === true, saved !== null)
  const request = requestBase(ctx)
  let credential: Credential | null = bare ? await credentialOrSignIn(ctx, 'paste your emails') : null
  const signIn = async () => void (credential ??= await credentialOrSignIn(ctx, 'write your sequence'))
  let emails: SeqEmail[]
  let plan: Job['plan'] = null
  if (bare) {
    const asked = await askJob(ctx, request.fileContext, signIn)
    if (!asked) return EXIT.ok
    ;({ emails, plan } = asked)
  } else if (writeFlag !== undefined) {
    const written = await writeJob(ctx, writeFlag, undefined, canAsk(ctx), request.fileContext, signIn)
    if (!written) return EXIT.ok
    ;({ emails, plan } = written)
  } else {
    emails = await readEmails(ctx, file as string, leads !== null)
    const csv = file !== '-' && /\.(csv|tsv)$/i.test(file as string)
    checkEmails(emails, file === '-' ? 'The input has' : 'This file has', !csv)
    if (!csv && !leads && atTerminal(ctx) && !out.json) out.info(foundLines(emails))
    if (from !== null && from > emails.length) throw usageError(`--from ${from} is past the last email: this file has ${emails.length}.`)
  }

  if (leads) return sequenceLeads(ctx, { file: file ?? null, emails, plan, base: request.base }, leads)

  credential ??= await resolveCredential(ctx)

  const job: Job = { emails, plan, ...request, ...(saved ? { resume: { earlier: saved.finals } } : {}) }
  const outcome = await runSequence(ctx, credential, job)
  const { failed } = outcome
  const everything = [...(saved?.finals ?? []), ...outcome.done.map((d) => d.final)]
  if (!out.json) {
    const fields = fieldLines(outcome.fields, outcome.fields.kept)
    if (fields.length) out.info(fields.join('\n'))
    if (failed?.account && outcome.done.length === 0) out.info(`${failed.detail}${failed.hint ? `\n${failed.hint}` : ''}`)
    else if (failed) out.info(`${failureLine(failed, emails.length, plan !== null)}${failed.hint ? `\n${failed.hint}` : ''}`)
    const sent = sentThemLine(ctx, outcome.done)
    if (sent.length) out.info(sent.join('\n'))
  }

  const interrupted = outcome.stopped === 'interrupted'
  const where = target ?? (interrupted && atTerminal(ctx) ? defaultTarget(ctx, file ?? null) : null)
  let savedTo: string | null = null
  let fileError: string | null = null
  const wrote = outcome.done.length
  if (where && wrote > 0) {
    const problem = saveCsv(where, everything, flags.force === true || saved !== null || (where !== target && false))
    if (problem) fileError = problem
    else savedTo = where
    if (!out.json) {
      if (problem) out.info(problem)
      else if (!failed && !outcome.stopped) out.result({}, `Saved: ${where}`)
      else out.info(`Saved ${everything.length === 1 ? 'email 1' : `emails 1 to ${everything.length}`} only: ${where}`)
    }
  } else if (where && (failed || outcome.stopped) && !out.json) out.info(`Nothing was saved to ${where}.`)
  else if (!failed && !target && !out.json && !outcome.stopped && canAsk(ctx)) fileError = await offerSave(ctx, file ?? null, everything, plan !== null)
  else if (!failed && !target && !out.json && !outcome.stopped && atTerminal(ctx)) out.info(csvTip(file ?? null, plan !== null))
  if (interrupted && !out.json) {
    out.info(wrote === 0 ? 'Stopped. No email had come back yet.' : `Stopped. ${outcome.done.map((d) => `Email ${d.index}: run ${String(d.run_id ?? 'unknown')}`).join('; ')}.`)
    if (wrote > 0 && savedTo && file !== undefined && everything.length < emails.length) out.info(continueLine(file, savedTo, everything.length + 1))
    else if (wrote > 0 && !savedTo) out.info('Nothing was saved. To keep the emails next time, add --csv.')
  }
  if (!out.json && bare && plan) out.info(`Next time: ${amdahlCommand('sequence --write "<goal>" --csv')}`)
  if (out.json) out.result(jsonDocument(job, outcome, savedTo, everything.length, fileError))
  return fileError && outcome.exit === EXIT.ok ? EXIT.general : outcome.exit
}

/** At a terminal, after a finished run with no `--csv`: "Save as <file>? [Y/n]". The person's yes is the export. Returns the sentence about a failed save, or null. */
async function offerSave(ctx: Ctx, file: string | null, finals: FinalEmail[], writing: boolean): Promise<string | null> {
  const { out, io } = ctx
  const path = defaultTarget(ctx, file)
  if (existsSync(path)) {
    out.info(`${path} already exists. To replace it: ${amdahlCommand(`sequence ${file ?? '<file>'} --csv --force`)}`)
    return null
  }
  let answer: string
  try {
    answer = (await io.prompt(`Save as ${path}? [Y/n]`)).trim()
  } catch (err) {
    if (!(err instanceof PromptCancelled)) throw err
    answer = 'n'
  }
  if (answer !== '' && !/^y/i.test(answer)) {
    out.info(csvTip(file, writing))
    return null
  }
  const problem = saveCsv(path, finals, false)
  out.info(problem ?? `Saved: ${path}`)
  return problem
}
