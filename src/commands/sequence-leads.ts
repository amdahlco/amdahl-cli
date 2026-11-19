// src/commands/sequence-leads.ts
//
// `amdahl sequence ... --leads <list.csv>`: a whole sequence for EACH person in
// a lead list. The console's Sequence tab does the same ("For each person", and
// "Write the rest again"): see sequence-leads.ts for what is copied from it.
//
//   amdahl sequence <emails> --leads <list.csv>      improve the emails for each person
//   amdahl sequence --write "<goal>" --leads <list>  write a sequence for each person
//
// Every check is made before the first question and the first request. Email k
// is sent as batches for every person whose earlier emails came back (see
// sequence-leads-run.ts). The results CSV goes next to the list:
// `<list>-amdahl-sequence.csv`, every original column, then each email's
// columns, then `amdahl_status`. That file IS the export of the text: nothing
// else keeps it. It is written before the first batch and after every step
// (never half written), and `Results: <path>` is printed first, so Ctrl+C or a
// timeout loses nothing: `--resume` reads it back and writes only the emails
// that are missing. `--json` also writes it, and prints one document (with
// `file`) instead of the lines. `--for <tool>` also writes that tool's import
// file.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { amdahlCommand } from '../command-name'
import { resolveCredential, str, type Ctx } from '../context'
import { EXIT, usageError } from '../errors'
import { readTextFile } from '../files'
import { readPeople, leadLabel, sharedEmails, type PeopleList } from '../lead-people'
import { writeResultsFile } from '../results-file'
import { fieldsIn, matchFields } from '../sequence-fields'
import { emailText, type FinalEmail, type SeqEmail } from '../sequence-parse'
import { STATUS_COLUMN, hasSubject, peopleCsv, peopleFileName, personStatus, readResults, stepCount, type PeopleSource, type PersonRow } from '../sequence-leads'
import { buildSendToFile, leftOutLine, stripUnverifiedMarkers as stripUnverified, overLimitLine, planSendTo, sendToFileName, sequenceGuideLines, toolFor, type SendToFile, type SendToPlan, type StepEmail } from '../send-to'
import { COLUMNS, wrap } from '../text'
import { canAsk } from '../terminal'
import { shellWord } from './batch'
import { matchFlagWords, settleFields } from './sequence-leads-match'
import { runPeople, type Halt, type PersonState } from './sequence-leads-run'
import type { WritePlan } from './sequence-run'

const MATCH_FLAGS = ['match', 'fallback', 'same', 'drop']

/** Refuse the flags that do not go together, before anything is read. Without `--leads`, refuse the ones that need it. */
export function checkLeadsFlags(ctx: Ctx, file: string | undefined, writeFlag: string | undefined): void {
  const { flags } = ctx
  if (typeof flags.leads !== 'string') {
    for (const name of [...MATCH_FLAGS, 'for', 'resume']) if (flags[name] !== undefined) throw usageError(`--${name} goes with --leads <list.csv>.`)
    return
  }
  if (!flags.leads) throw usageError('--leads needs a lead list: a CSV file.')
  if (file === undefined && writeFlag === undefined) throw usageError('Give a file of emails, or --write "<goal>", with --leads.')
  if (flags.csv !== undefined) throw usageError('--csv does not go with --leads: the results are saved next to the list.')
  if (flags.context !== undefined) throw usageError('--context does not go with --leads: each person\'s row is their context.')
  if (flags.resume === true && flags.force === true) throw usageError('--resume and --force do not go together: one picks up the results file, the other replaces it.')
  if (writeFlag !== undefined) for (const name of MATCH_FLAGS) if (flags[name] !== undefined) throw usageError(`--${name} goes with emails you improve, not with --write: a written email has no fill-in fields.`)
  if (typeof flags.for === 'string' && !flags.for.trim()) throw usageError('--for needs a tool.')
}

/** The list, read and checked: people in it, or the sentence that says why not. */
export function readLeadsFile(ctx: Ctx): { path: string; list: PeopleList } {
  const path = str(ctx.flags.leads) ?? ''
  const read = readPeople(readTextFile(path), basename(path))
  if (!read.ok) throw usageError(read.error)
  return { path, list: read.list }
}

/** `3 emails for each of 50 people: up to 150 runs`. */
function startQuestion(verb: string, emails: string, people: number, runs: number): string {
  const who = people === 1 ? '1 person' : `each of ${people} people`
  return `This ${verb} ${emails} for ${who}: up to ${runs} ${runs === 1 ? 'run' : 'runs'}. Start? [Y/n]`
}

/** `Write 3 emails for each of the other 49 people: up to 147 runs. Start? [Y/n]`. */
function otherQuestion(emails: number, people: number, runs: number): string {
  const who = people === 1 ? 'the other person' : `each of the other ${people} people`
  return `Write ${emails} emails for ${who}: up to ${runs} ${runs === 1 ? 'run' : 'runs'}. Start? [Y/n]`
}

const yes = (answer: string) => answer.trim() === '' || /^y/i.test(answer.trim())

/** Write a file; a file that appeared since the check is not replaced unless `replace`. */
function writeFile(path: string, text: string, replace: boolean): void {
  try {
    writeFileSync(path, text, { flag: replace ? 'w' : 'wx' })
  } catch (err) {
    if ((err as { code?: string } | null)?.code === 'EEXIST') throw usageError(`${path} already exists.`, 'Move it, or add --force to replace it.')
    throw err
  }
}

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`)

/** The summary line: how many people have every email, and where the others stopped. */
function summaryLine(emails: number, people: PersonState[], halt: Halt | null, declined: boolean): string {
  const written = people.filter((p) => p.finals.every(Boolean)).length
  const head = `Wrote ${emails} emails for ${written} of ${people.length} people.`
  const stopped = people.filter((p) => p.failed)
  const groups = new Map<string, number>()
  for (const p of stopped) {
    const key = `at email ${(p.failed?.at ?? 0) + 1} (${p.failed?.reason})`
    groups.set(key, (groups.get(key) ?? 0) + 1)
  }
  const parts = stopped.length ? ` ${stopped.length} stopped: ${[...groups].map(([key, n]) => `${n} ${key}`).join(', ')}.` : ''
  const left = halt?.remaining === undefined ? '' : ` ${halt.remaining} ${halt.remaining === 1 ? 'run is' : 'runs are'} left.`
  if (halt) return `${head}${parts} Email ${halt.at + 1} ${halt.lost ? 'was not finished' : 'was refused'}: ${sentence(halt.reason)}${left}${halt.hint ? ` ${halt.hint}` : ''}`
  if (declined) return `${head}${parts} The other ${people.length - written - stopped.length} were not written.`
  return `${head}${parts}`
}

/** The command that picks the run up where it stopped. */
function pickUpCommand(ctx: Ctx, job: LeadsJob, src: PeopleSource, headers: string[], leadsPath: string): string {
  const { flags } = ctx
  const what = job.plan ? ['--write', shellWord(job.plan.goal)] : [job.file === '-' ? '-' : shellWord(job.file ?? '')]
  const plan = job.plan ? (str(flags.plan) ? ['--plan', shellWord(str(flags.plan) ?? '')] : ['--emails', String(stepCount(src))]) : []
  const fill = src.kind === 'improve' ? matchFlagWords(src.matches, headers) : []
  const tool = typeof flags.for === 'string' ? ['--for', shellWord(flags.for)] : []
  return amdahlCommand(['sequence', ...what, '--leads', shellWord(leadsPath), ...plan, ...fill, ...tool, '--resume'].join(' '))
}

/** What the people who were written for come out as in `--json`. */
function jsonRows(people: PersonState[]): Record<string, unknown>[] {
  return people.map((p) => ({
    row: p.lead.row,
    emails: p.finals.map((f) => (f ? { subject: f.subject ? stripUnverified(f.subject) : null, message: stripUnverified(f.body) } : null)),
    status: personStatus(p.finals, p.failed?.at ?? null),
  }))
}

/** The sequencer's import file: only the people with every email. */
function importFile(listPath: string, table: PeopleList['table'], plan: SendToPlan, people: PersonState[]): SendToFile {
  return buildSendToFile({
    path: listPath,
    headers: table.headers,
    channel: 'email',
    preset: plan.preset,
    rows: people.map((p) => {
      const steps: StepEmail[] = p.finals.map((f) => (f ? { subject: stripUnverified(f.subject ?? ''), body: stripUnverified(f.body) } : null))
      const first = steps[0]
      const all = p.finals.every(Boolean) && first
      return { cells: p.lead.cells, steps, written: all ? { kind: 'written', subject: first.subject, body: first.body } : p.failed ? { kind: 'failed' } : { kind: 'unwritten' } }
    }),
  })
}

/** The human lines after the import file is written, as `optimize --list --for` prints them, for a sequence. */
function printImport(ctx: Ctx, plan: SendToPlan, built: SendToFile, path: string | null): void {
  const { out } = ctx
  const { preset } = plan
  const left = leftOutLine(built.leftOut, 'email', preset)
  if (!path) {
    out.info(`Nothing to send to ${preset.label}.${left ? ` ${left}` : ''}`)
    return
  }
  out.result({}, `Import file${preset.id === 'other' ? '' : ` for ${preset.label}`}: ${path}`)
  out.info(`${built.ready} ${built.ready === 1 ? 'person' : 'people'} ready ${preset.id === 'other' ? 'to import' : `for ${preset.label}`}.${left ? ` ${left}` : ''}`)
  const lines = sequenceGuideLines(preset, built.stepSubjects)
  const head = lines.slice(0, 3).map((line, i) => `${i + 1}. ${line}`)
  out.info(wrap(head.join('\n'), COLUMNS, '  ').join('\n'))
  out.info(lines.slice(3).map((line) => `     ${line}`).join('\n'))
  for (const note of [preset.note, built.overLimit > 0 ? overLimitLine(built.overLimit, preset) : undefined]) if (note) out.info(wrap(note, COLUMNS).join('\n'))
}

/** What `amdahl sequence` gives `--leads`: the emails or the plan, and the request options. */
export interface LeadsJob {
  /** The emails file the person gave (`-` for stdin), or null when writing. */
  file: string | null
  emails: SeqEmail[]
  plan: WritePlan | null
  base: Record<string, unknown>
}

/** The first person's emails, as the sample: under `Sample for <name>:`, like one sequence's output. */
function printSample(ctx: Ctx, p: PersonState, job: LeadsJob): void {
  const { out } = ctx
  const n = p.finals.length
  const blocks = p.finals.map((f: FinalEmail | null, k) => (f ? `Email ${k + 1} of ${n}: ${job.plan?.steps[k]?.name.trim() || `Email ${k + 1}`}\n${emailText({ subject: f.subject ? stripUnverified(f.subject) : null, body: stripUnverified(f.body) })}` : null)).filter((b): b is string => b !== null)
  if (blocks.length) out.result({}, `Sample for ${leadLabel(p.lead)}:\n\n${blocks.join('\n\n')}`)
}

/** `amdahl sequence ... --leads`: see the header. */
export async function sequenceLeads(ctx: Ctx, job: LeadsJob, loaded: { path: string; list: PeopleList }): Promise<number> {
  const { flags, out, io } = ctx
  const { list, path: leadsPath } = loaded
  const { table, leads } = list
  const force = flags.force === true
  const resume = flags.resume === true
  const ask = canAsk(ctx)
  const matches = job.plan ? [] : matchFields(fieldsIn(job.emails), table.headers)
  const src: PeopleSource = job.plan ? { kind: 'write', goal: job.plan.goal, steps: job.plan.steps } : { kind: 'improve', emails: job.emails, matches }
  const n = stepCount(src)
  const subjects = Array.from({ length: n }, (_, k) => hasSubject(src, k))

  const target = join(dirname(leadsPath), peopleFileName(basename(leadsPath)))
  const tool = typeof flags.for === 'string' ? toolFor(flags.for) : null
  const plan = tool ? planSendTo(tool, { path: leadsPath, kind: 'csv', header: table.headers, items: leads.map(() => ({ channel: 'email' })) }, 'email') : null
  const importPath = plan ? join(dirname(leadsPath), sendToFileName(leadsPath, plan.preset)) : null
  if (resume && !existsSync(target)) throw usageError(`${target} does not exist, so there is nothing to pick up.`, 'Run the command without --resume to write the emails.')
  if (!resume && !force && existsSync(target)) throw usageError(`${target} already exists.`, 'Add --resume to pick up where it stopped, or --force to start again.')
  if (importPath && !force && !resume && existsSync(importPath)) throw usageError(`${importPath} already exists.`, 'Move it, or add --force to replace it.')
  const earlier = resume ? readResults(readFileSync(target, 'utf8'), target, leadsPath, table, leads, subjects) : []
  const fillLines = job.plan ? [] : await settleFields(ctx, matches, table.headers, leads, leadsPath, ask)
  const people: PersonState[] = leads.map((lead, j) => ({ lead, finals: Array.from({ length: n }, (_, k) => earlier[j]?.[k] ?? null), failed: null }))
  const pending = people.filter((p) => !p.finals.every(Boolean))
  const runsFor = (who: PersonState[]) => who.reduce((sum, p) => sum + p.finals.filter((f) => !f).length, 0)
  const shared = sharedEmails(leads)

  const credential = await resolveCredential(ctx)
  if (!out.json) {
    if (list.skipped) out.info(`Skipped ${list.skipped} empty ${list.skipped === 1 ? 'row' : 'rows'}.`)
    if (list.overCap) out.info(`Amdahl takes up to 500 people for one run. The first 500 are used, and the other ${list.overCap} are left out.`)
    if (shared) out.info(`${shared} rows share an email with another row.`)
    if (fillLines.length) out.info(fillLines.join('\n'))
  }
  if (src.kind === 'improve' && ask && pending.length > 0) {
    if (!yes(await io.prompt(startQuestion('improves', resume ? 'the missing emails' : `${n} emails`, pending.length, runsFor(people))))) {
      out.info('Nothing was sent.')
      return EXIT.ok
    }
  }

  let created = false
  const save = () => {
    const rows: PersonRow[] = people.map((p) => ({ lead: p.lead, finals: p.finals, status: personStatus(p.finals, p.failed?.at ?? null) }))
    writeResultsFile(target, peopleCsv(table, rows, subjects), !force && !resume && !created)
    created = true
  }
  save()
  if (!out.json) out.result({}, `Results: ${target}`)

  let halt: Halt | null = null
  let declined = false
  let thrown: unknown = null
  try {
    const sample = src.kind === 'write' && ask && !people.some((p) => p.finals.some(Boolean)) ? people[0] : undefined
    let rest = people
    if (sample) {
      halt = await runPeople(ctx, credential, src, table, [sample], save)
      printSample(ctx, sample, job)
      rest = people.slice(1)
      const fine = !halt && !sample.failed
      if (fine && rest.length > 0 && !yes(await io.prompt(otherQuestion(n, rest.length, runsFor(rest))))) declined = true
      else if (!fine) declined = true
    }
    if (!halt && !declined) halt = await runPeople(ctx, credential, src, table, rest, save)
  } catch (err) {
    thrown = err
  }

  try {
    save()
  } catch (err) {
    thrown ??= err
  }
  if (thrown) throw thrown
  const built = plan ? importFile(leadsPath, table, plan, people) : null
  const wrote = built && plan && importPath && built.ready > 0 ? importPath : null
  if (built && wrote) writeFile(wrote, built.csv, force || resume)
  const written = people.filter((p) => p.finals.every(Boolean)).length
  const stopped = people.filter((p) => p.failed)
  const ok = !halt && stopped.length === 0 && (!built || built.ready > 0)

  if (out.json) {
    out.result({
      ok,
      mode: src.kind,
      people: people.length,
      written,
      file: target,
      left_out: { over_cap: list.overCap, empty_rows: list.skipped },
      duplicates: shared,
      stopped: stopped.map((p) => ({ row: p.lead.row, email: p.lead.email || null, at_email: (p.failed?.at ?? 0) + 1, reason: p.failed?.reason ?? '' })),
      rows: jsonRows(people),
      ...(halt ? { halted: { at_email: halt.at + 1, reason: halt.reason } } : {}),
      ...(plan && built
        ? {
            send_to: {
              tool: plan.preset.id,
              channel: 'email',
              file: wrote,
              ready: built.ready,
              left_out: { failed: built.leftOut.failed, not_written: built.leftOut.unwritten, needs_input: built.leftOut.needsInput, no_contact: built.leftOut.noContact },
              over_limit: built.overLimit,
            },
          }
        : {}),
    })
  } else {
    out.info(summaryLine(n, people, halt, declined))
    if (plan && built) printImport(ctx, plan, built, wrote)
    if (written < people.length && halt?.code !== 'quota_exceeded') out.info(`To write the rest: ${pickUpCommand(ctx, job, src, table.headers, leadsPath)}`)
  }
  return halt ? halt.exit : ok ? EXIT.ok : EXIT.general
}
