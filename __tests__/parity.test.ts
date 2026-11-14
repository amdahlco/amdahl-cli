// 0.4.9 and 0.5.0: the commands that bring the CLI level with the
// MCP and the console: grade, prompt, runs and run, data, recipes and
// search --recipe, search --research-id, and the questions sent and feedback
// ask at a terminal. All against the strict mock server.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { outOfTimeLines } from '../src/commands/search'
import { outputColumns } from '../src/io'
import { runLines } from '../src/commands/runs'
import { MAX_KEPT } from '../src/history'
import { RECIPES } from '../src/recipes-data'
import { cutAtWord, firstSentence } from '../src/text'
import { readPaste } from '../src/select'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { promptProblems } from './helpers/strict'
import { API_KEY, GRADE_RUN, KNOWN_RUN, PROMPT_RUN, READONLY_KEY, SUGGESTED_LIBRARY, UNKNOWN_RUN, startMockServer, type MockServer } from './helpers/mock-server'

let server: MockServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

/** Signed in through the browser: a CLI OAuth token (data:read, connections:read, messages:execute). */
async function signedIn(options: Parameters<typeof startMockServer>[0] = {}): Promise<FakeIo> {
  server = await startMockServer(options)
  const io = fakeIo({ AMDAHL_API_URL: server.url })
  expect((await cli(io, 'login', '--json')).code).toBe(0)
  io.opened.length = 0
  io.stdoutIsTTY = true
  return io
}

/** An API key in AMDAHL_KEY (a Customer agent key: it can start research and read it back). */
async function withKey(options: Parameters<typeof startMockServer>[0] = {}): Promise<FakeIo> {
  server = await startMockServer(options)
  return fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_KEY: API_KEY })
}

const sentBody = (path: string) => JSON.parse(server!.log.filter((l) => l.path === path).at(-1)?.body ?? '{}')
const requests = (suffix: string) => server!.log.filter((l) => l.path.endsWith(suffix))
const flat = (text: string) => text.replace(/\s*\n\s*/g, ' ')
const fits80 = (text: string) => expect(text.split('\n').filter((l) => [...l].length > 80)).toEqual([])
const write = (io: FakeIo, name: string, text: string) => {
  const path = join(io.cwd, name)
  writeFileSync(path, text)
  return path
}

describe('grade', () => {
  it('prints the score with the lines it rests on, says what a grade is not, and posts mode grade', async () => {
    const io = await signedIn()
    const draft = write(io, 'draft.md', 'Hi Jordan, saw Corvid shipped SSO. Worth 15 minutes?')
    const r = await cli(io, 'grade', draft, '--evidence', 'workspace', '--channel', 'email')
    expect(r.code).toBe(0)
    expect(sentBody('/api/platform/v1/messages/optimize')).toEqual({ mode: 'grade', message: 'Hi Jordan, saw Corvid shipped SSO. Worth 15 minutes?', channel: 'email', evidence: 'workspace' })
    expect(r.stdout).toBe(
      [
        'Grade 4.2 of 5: 4 of 5 lines passed.',
        'It meets the bar of 4.2.',
        '',
        'The lines it rests on:',
        '  pass  Relevant positioning',
        '        It names what Corvid shipped.',
        '  pass  Grounding',
        '        Helix is in a call.',
        '  pass  Verified specifics',
        '        The 70% is in a call.',
        '  fail  Differentiation',
        '        It reads like boilerplate.',
        '  pass  Clear ask',
        '        One clear ask.',
        '',
        'Checked against your calls.',
        '',
        'This is one reading by claude-sonnet-5-5. It measures the message against the',
        'rubric and your evidence. It does not predict replies. On a repeat, about 15% of',
        'texts scored more than 0.2 apart.',
        '',
        `Run: ${GRADE_RUN}`,
        '',
      ].join('\n')
    )
    fits80(r.stdout)
  })

  it('without evidence, the lines that read calls say so, and the tip names --evidence workspace', async () => {
    const io = await signedIn()
    const r = await cli(io, 'grade', write(io, 'd.txt', 'Hello there'))
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('  n/a   Grounding\n        Not evaluated: not requested.')
    expect(r.stdout).toContain("Grade 5 of 5, on 1 of the 5 lines (1 of 1 line passed).\nIt meets the bar of 4.2.")
    expect(r.stdout).toContain("Four of the five lines read your customers' calls; add --evidence workspace to\ngrade them.")
    expect(r.stdout).toContain('It does not predict replies.')
    fits80(r.stdout)
  })

  it('a null score is "Not graded", never 0, and a line that abstained is not a fail', async () => {
    const abstain = { id: 'cta_clarity', pass: null, applicable: false, reason: 'x', not_applicable_reason: 'corpus_empty' }
    const io = await signedIn({
      gradeResult: {
        ok: true, outcome: 'graded', run_id: GRADE_RUN, evidence: { requested: 'workspace', used: false, reason: 'corpus_empty' },
        grade: { score: null, passed: 0, total: 0, bar: 4.2, passes_bar: null, judge: { model: 'm', judge_version: 'v', role: 'final' }, lines: [abstain], not_applicable_reason: 'corpus_empty' },
        disclosures: { single_run: true, not_reply_prediction: true, repeat_spread: null },
      },
    })
    const r = await cli(io, 'grade', write(io, 'd.txt', 'Hello there'), '--evidence', 'workspace')
    expect(r.code).toBe(0)
    expect(r.stdout.startsWith('Not graded.\nNo line could be evaluated: no calls are synced yet.')).toBe(true)
    expect(r.stdout).not.toMatch(/Grade 0|of 5: 0/)
    expect(r.stdout).not.toContain('fail')
    expect(r.stdout).toContain('Not checked against your calls: no calls are synced yet.')
    expect(flat(r.stdout)).toContain('does not predict replies')
    fits80(r.stdout)
  })

  it('--json prints {ok, file, result} with the grade as the API returned it', async () => {
    const io = await signedIn()
    const r = await cli(io, 'grade', write(io, 'd.txt', 'Hello there'), '--json')
    expect(r.code).toBe(0)
    expect(r.json).toMatchObject({ ok: true, result: { outcome: 'graded', run_id: GRADE_RUN, grade: { score: 5, total: 1, passes_bar: true } } })
    expect(r.json.file).toMatch(/d\.txt$/)
  })

  it('reads standard input with -, and refuses what the server would: nothing is sent', async () => {
    const io = await signedIn()
    io.stdinText = 'Piped message'
    expect((await cli(io, 'grade', '-')).code).toBe(0)
    expect(sentBody('/api/platform/v1/messages/optimize').message).toBe('Piped message')
    const before = server!.log.length
    io.stdinText = '  \n'
    const empty = await cli(io, 'grade', '-')
    expect(empty).toMatchObject({ code: 2, stderr: 'Error: Stdin is empty.\n' })
    expect((await cli(io, 'grade', 'a.txt', 'b.txt')).code).toBe(2)
    expect((await cli(io, 'grade', 'nope.txt')).stderr).toBe("Error: Can't find nope.txt.\n")
    // A grade writes no versions and asks no questions: these flags do not exist on it.
    for (const flag of ['--tries', '--on-unsupported']) expect((await cli(io, 'grade', 'x.txt', flag)).code).toBe(2)
    expect(server!.log.length).toBe(before)
  })

  it('with no file: a person at a terminal pastes it; an agent or a pipe is told how to give it', async () => {
    const io = await signedIn()
    io.answers = ['Pasted message']
    expect((await cli(io, 'grade')).code).toBe(0)
    expect(sentBody('/api/platform/v1/messages/optimize').message).toBe('Pasted message')
    const agent = fakeIo({ ...io.env, CLAUDECODE: '1' }, io.homedir)
    const r = await cli(agent, 'grade')
    expect(r).toMatchObject({ code: 2 })
    expect(r.stderr).toContain('Give a file to grade, or pipe the message on stdin.')
  })

  it('a read-only key is told what it cannot do; the server refusal is exit 4', async () => {
    server = await startMockServer()
    const io = fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_KEY: READONLY_KEY })
    const r = await cli(io, 'grade', write(io, 'd.txt', 'Hello'))
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('This credential cannot grade.')
    expect(r.stderr).not.toContain('cannot optimize')
  })
})

describe('prompt', () => {
  const PROMPT = 'Write a first-touch email to a Head of Platform. Name what they shipped, then ask for 15 minutes.'

  it('starts an improve run, waits, prints the revised prompt on stdout and the report with the run id on stderr', async () => {
    const io = await signedIn({ promptPolls: 2 })
    const file = write(io, 'prompt.md', PROMPT)
    const r = await cli(io, 'prompt', file)
    expect(r.code).toBe(0)
    expect(sentBody('/api/platform/v1/messages/optimize_prompt')).toEqual({ prompt: PROMPT })
    expect(requests(`/optimize_prompt/${PROMPT_RUN}`)).toHaveLength(3)
    expect(r.stdout).toBe('Write a first-touch email to a Head of Platform. Name what they shipped, then ask for 15 minutes.\n')
    const err = flat(r.stderr)
    expect(err).toContain(`run ${PROMPT_RUN}`)
    expect(r.stderr).toContain(`If you stop before it ends, read it later:\n  amdahl prompt --run ${PROMPT_RUN}`)
    // Not a reportable lift: the original's mean alone, and that a revision was kept. No before and after.
    expect(err).toContain('Amdahl kept a revised prompt. Your original averages 2.6 of 5, over 2 emails, 0 passing the bar of 4.2 on the emails held out of the revising.')
    expect(err).not.toContain('Amdahl revised your prompt.')
    expect(err).not.toContain('3.4')
    expect(r.stderr).toContain('Helix, original, held out: 2.6 of 5 (2 of 5 lines)')
    expect(r.stderr).toContain('Helix, revised, held out\n')
    // No lift unless it is reportable, and the reason is said.
    expect(err).toContain('No lift is reported: fewer than 3 held-out emails on a side')
    expect(err).not.toMatch(/Lift on the held-out/)
    expect(err).toContain('1 email trained the revision. Their scores are not lift')
    expect(err).toContain('It does not predict replies.')
    expect(r.stderr).toContain(`\nRun: ${PROMPT_RUN}\n`)
    fits80(r.stderr)
  })

  it('--mode grade prints the prompt grade on stdout, and a lift is shown only when it is reportable', async () => {
    const io = await signedIn()
    const grade = await cli(io, 'prompt', write(io, 'p.md', PROMPT), '--mode', 'grade')
    expect(grade.code).toBe(0)
    expect(sentBody('/api/platform/v1/messages/optimize_prompt')).toEqual({ prompt: PROMPT, mode: 'grade' })
    expect(grade.stdout).toContain('Prompt grade: 3.4 of 5, over 4 emails, 1 passing the bar of 4.2.')
    expect(grade.stdout).toContain('Lines, over the emails: Clear ask 2 of 2, Grounding not evaluated.')
    expect(flat(grade.stdout)).toContain('The score rests on 1 of the 2 lines; the others were not evaluated.')
    expect(grade.stdout).toContain('Emails it wrote:')
    expect(grade.stdout).not.toMatch(/lift/i)
    fits80(grade.stdout)

    const io2 = await signedIn({
      promptResult: () => ({
        outcome: 'improved', prompt: 'Better prompt', lift: 0.8, lift_reportable: true,
        grade: { original: { mean: 2.6, n: 3, emails_passing_bar: 0, bar: 4.2, lines: {} }, revised: { mean: 3.4, n: 3, emails_passing_bar: 1, bar: 4.2, lines: {} } },
        emails: [{ label: 'A', variant: 'original', split: 'held_out', email: 'Old.', grade: { score: 2.6, passed: 2, total: 5 } }, { label: 'A', variant: 'revised', split: 'held_out', email: 'New.', grade: { score: 3.4, passed: 3, total: 5 } }], judges: { final: { model: 'm' } },
      }),
    })
    const lift = await cli(io2, 'prompt', write(io2, 'p.md', PROMPT))
    expect(lift.stderr).toContain('Lift on the held-out recipients: +0.8 points.')
    expect(flat(lift.stderr)).toContain('Amdahl revised your prompt. On the emails held out of the revising it averages 3.4 of 5, over 3 emails, 1 passing the bar of 4.2; yours averaged 2.6 of 5, over 3 emails, 0 passing the bar of 4.2.')
    expect(lift.stderr).toContain('A, revised, held out: 3.4 of 5 (3 of 5 lines)')
    expect(lift.stdout).toBe('Better prompt\n')
  })

  it('an unchanged run keeps the prompt; a null mean is "not graded", never 0', async () => {
    const io = await signedIn({
      promptResult: () => ({ outcome: 'unchanged', lift: null, lift_reportable: false, lift_not_reportable_reason: 'no_revision', grade: { original: { mean: null, n: 0, emails_passing_bar: 0, bar: 4.2, lines: {} }, revised: null }, emails: [] }),
    })
    const r = await cli(io, 'prompt', write(io, 'p.md', PROMPT))
    expect(r.code).toBe(0)
    expect(flat(r.stdout)).toContain('No revision wrote better email on the held-out recipients, so your prompt stays as it is. Its emails could not be graded.')
    expect(flat(r.stdout)).toContain('No lift is reported: no revision was kept.')
    expect(r.stdout).not.toMatch(/\b0 of 5/)
  })

  it('sends the recipients, context and channel it was given, and refuses what the server refuses before any request', async () => {
    const io = await signedIn()
    const recipients = write(io, 'r.json', JSON.stringify([{ recipient: { company: 'Helix' } }, { recipient: { name: 'Jordan Lee', company: 'Corvid' }, label: 'Jordan' }]))
    const context = write(io, 'c.json', JSON.stringify({ facts: ['We automate provisioning.'] }))
    const r = await cli(io, 'prompt', write(io, 'p.md', PROMPT), '--recipients', recipients, '--context', context, '--channel', 'email')
    expect(r.code).toBe(0)
    expect(sentBody('/api/platform/v1/messages/optimize_prompt')).toMatchObject({
      channel: 'email', context: { facts: ['We automate provisioning.'] },
      recipients: [{ recipient: { company: 'Helix' } }, { recipient: { name: 'Jordan Lee', company: 'Corvid' }, label: 'Jordan' }],
    })
    expect(flat(r.stderr)).toContain('2 recipients: Helix; Jordan')

    const before = server!.log.length
    const one = write(io, 'one.json', JSON.stringify([{ recipient: { company: 'Helix' } }]))
    const tooFew = await cli(io, 'prompt', write(io, 'p2.md', PROMPT), '--recipients', one)
    expect(tooFew.code).toBe(2)
    expect(tooFew.stderr).toContain('Improving a prompt needs at least 2 recipients')
    expect((await cli(io, 'prompt', write(io, 'p3.md', PROMPT), '--recipients', one, '--mode', 'grade')).code).toBe(0)
    const seven = write(io, 'seven.json', JSON.stringify(Array.from({ length: 7 }, () => ({ recipient: { company: 'X' } }))))
    expect((await cli(io, 'prompt', write(io, 'p4.md', PROMPT), '--recipients', seven)).stderr).toContain('needs 1 to 6 recipients, not 7')
    expect((await cli(io, 'prompt', write(io, 'p5.md', PROMPT), '--recipients', write(io, 'bad.json', '{}'))).code).toBe(2)
    expect((await cli(io, 'prompt', write(io, 'p6.md', PROMPT), '--recipients', write(io, 'bad2.json', '[{"label":"x"},{"label":"y"}]'))).stderr).toContain('item 1 needs a "recipient" object')
    expect((await cli(io, 'prompt', write(io, 'big.md', 'x'.repeat(20_001)))).stderr).toContain('at most 20000 characters')
    expect((await cli(io, 'prompt', write(io, 'p7.md', PROMPT), '--mode', 'tune')).code).toBe(2)
    expect((await cli(io, 'prompt', write(io, 'e.md', ' \n'))).stderr).toContain('is empty')
    // Every refusal above came before any request: only the accepted grade run reached the server.
    expect(server!.log.slice(before).map((l) => `${l.method} ${l.path.replace(PROMPT_RUN, ':id')}`)).toEqual(['POST /api/platform/v1/messages/optimize_prompt', 'GET /api/platform/v1/messages/optimize_prompt/:id', 'GET /api/platform/v1/messages/optimize_prompt/:id'])
  })

  it('--no-wait starts it and prints how to read it; --run <id> reads it later; a run that is still going says so', async () => {
    const io = await signedIn({ promptPolls: 1 })
    const started = await cli(io, 'prompt', write(io, 'p.md', PROMPT), '--no-wait')
    expect(started.code).toBe(0)
    expect(requests(`/optimize_prompt/${PROMPT_RUN}`)).toHaveLength(0)
    expect(started.stderr).toContain(`Read it later:\n  amdahl prompt --run ${PROMPT_RUN}`)
    const going = await cli(io, 'prompt', '--run', PROMPT_RUN, '--no-wait')
    expect(going.code).toBe(1)
    expect(going.stderr).toContain(`The run is still going (running).\nRead it later:\n  amdahl prompt --run ${PROMPT_RUN}`)
    const done = await cli(io, 'prompt', '--run', PROMPT_RUN)
    expect(done.code).toBe(0)
    expect(done.stdout).toContain('Write a first-touch email')
    const missing = await cli(io, 'prompt', '--run', UNKNOWN_RUN)
    expect(missing.code).toBe(1)
    expect((await cli(io, 'prompt', '--run', PROMPT_RUN, '--mode', 'grade')).code).toBe(2)
    expect((await cli(io, 'prompt', 'p.md', '--run', PROMPT_RUN)).code).toBe(2)
  })

  it('a run that failed exits 1 and says so; --json prints {ok, file, started, result}', async () => {
    const io = await signedIn({ promptResult: () => ({ error: { code: 'optimizer_error', message: 'The run finished, but its result could not be read. It is not billed.' } }) })
    const r = await cli(io, 'prompt', write(io, 'p.md', PROMPT))
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('The prompt run failed: The run finished, but its result could not be read. It is not billed.')
    const ok = await signedIn()
    const json = await cli(ok, 'prompt', write(ok, 'p.md', PROMPT), '--json')
    expect(json.code).toBe(0)
    expect(json.json).toMatchObject({ ok: true, started: { run_id: PROMPT_RUN, mode: 'improve', recipients: { sampled: true } }, result: { status: 'complete', outcome: 'improved' } })
  })

  it('reads the prompt from stdin with -, and at a terminal with no file it asks for a paste', async () => {
    const io = await signedIn()
    io.stdinText = PROMPT
    expect((await cli(io, 'prompt', '-', '--no-wait')).code).toBe(0)
    expect(sentBody('/api/platform/v1/messages/optimize_prompt').prompt).toBe(PROMPT)
    io.answers = [PROMPT + ' Paste']
    expect((await cli(io, 'prompt', '--no-wait')).code).toBe(0)
    expect(sentBody('/api/platform/v1/messages/optimize_prompt').prompt).toBe(PROMPT + ' Paste')
  })
})

describe('a key that cannot do it', () => {
  it('a read-only key is told what it cannot do, for each command that needs messages:execute', async () => {
    server = await startMockServer()
    const io = fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_KEY: READONLY_KEY })
    const p = await cli(io, 'prompt', write(io, 'p.md', 'Write an email to anyone.'))
    expect(p).toMatchObject({ code: 4 })
    expect(p.stderr).toContain('This credential cannot grade or improve a prompt. Use a Customer agent key')
    const r = await cli(io, 'run', KNOWN_RUN)
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('This credential cannot read a run.')
    const f = await cli(io, 'feedback', KNOWN_RUN, '--evidence', 'inferred', '--outcome', 'used')
    expect(f.stderr).toContain('This credential cannot record feedback.')
  })
})

describe('runs and run', () => {
  it('lists the runs this computer made, newest first, and says the list is from this computer', async () => {
    const io = await signedIn({ optimizeResult: { ok: true, message: 'better', run_id: KNOWN_RUN } })
    expect((await cli(io, 'runs')).stdout).toContain('No runs yet from this computer.')
    expect((await cli(io, 'optimize', write(io, 'a.txt', 'Hi'), '--channel', 'linkedin')).code).toBe(0)
    expect((await cli(io, 'grade', write(io, 'b.txt', 'Hi'))).code).toBe(0)
    expect((await cli(io, 'prompt', write(io, 'p.md', 'Write an email.'), '--no-wait')).code).toBe(0)
    const r = await cli(io, 'runs')
    expect(r.code).toBe(0)
    const rows = r.stdout.split('\n').filter((l) => /^(opt_|[0-9a-f]{8}-)/.test(l))
    expect(rows.map((l) => l.replace(/\d{4}-\d\d-\d\d \d\d:\d\d/, 'WHEN'))).toEqual([`${PROMPT_RUN}  WHEN  prompt`, `${GRADE_RUN}  WHEN  grade`, `${KNOWN_RUN}  WHEN  optimize linkedin`])
    expect(flat(r.stdout)).toContain('Runs made from this computer. A run made in the console or an AI client is not listed here')
    expect(r.stdout).toContain('Open one: amdahl run <run-id>')
    fits80(r.stdout)
    const limited = await cli(io, 'runs', '--limit', '1')
    expect(limited.stdout).toContain('And 2 older runs (all of them: add --limit 3).')
    expect((await cli(io, 'runs', '--limit', '0')).code).toBe(2)
    expect((await cli(io, 'runs', 'extra')).code).toBe(2)
    const json = await cli(io, 'runs', '--json')
    expect(json.json).toMatchObject({ ok: true, source: 'this_computer', total: 3, runs: [{ run_id: PROMPT_RUN, kind: 'prompt' }, { run_id: GRADE_RUN, kind: 'grade' }, { run_id: KNOWN_RUN, kind: 'optimize', channel: 'linkedin' }] })
  })

  it('keeps ids and times only: never a message, a draft or a prompt; the file is owner-only', async () => {
    const io = await signedIn()
    await cli(io, 'grade', write(io, 'secret.txt', 'SECRET DRAFT TEXT'))
    const path = join(io.homedir, 'config', 'amdahl', 'runs.json')
    expect(existsSync(path)).toBe(true)
    const text = readFileSync(path, 'utf8')
    expect(text).not.toContain('SECRET')
    expect(Object.keys(JSON.parse(text).runs[0]).sort()).toEqual(['api_url', 'created_at', 'kind', 'profile', 'run_id', 'workspace'])
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('keeps the last 50 runs only', async () => {
    const io = await signedIn()
    const path = join(io.homedir, 'config', 'amdahl', 'runs.json')
    const seeded = Array.from({ length: 60 }, (_, i) => ({ run_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, created_at: '2026-11-01T00:00:00.000Z', kind: 'optimize', api_url: server!.url, profile: 'default' }))
    await cli(io, 'grade', write(io, 'b.txt', 'Hi'))
    const profile = JSON.parse(readFileSync(path, 'utf8')).runs[0].profile
    writeFileSync(path, JSON.stringify({ version: 1, runs: seeded.map((r) => ({ ...r, profile })) }))
    expect((await cli(io, 'grade', write(io, 'c.txt', 'Hi'))).code).toBe(0)
    const kept = JSON.parse(readFileSync(path, 'utf8')).runs
    expect(kept).toHaveLength(50)
    expect(kept.at(-1).run_id).toBe(GRADE_RUN)
    expect(kept[0].run_id).toBe('00000000-0000-4000-8000-000000000011')
  })

  it('a key and a sign-in keep separate lists, and another host has none', async () => {
    const io = await signedIn()
    await cli(io, 'grade', write(io, 'b.txt', 'Hi'))
    expect((await cli(io, 'runs', '--json')).json.total).toBe(1)
    const key = fakeIo({ AMDAHL_API_URL: server!.url, AMDAHL_KEY: API_KEY }, io.homedir)
    expect((await cli(key, 'runs', '--json')).json.total).toBe(0)
    const other = fakeIo({ AMDAHL_API_URL: 'http://127.0.0.1:9' }, io.homedir)
    expect((await cli(other, 'runs', '--json')).json.total).toBe(0)
  })

  it('run <id> shows the draft, then the message, then what was left out, in 80 columns', async () => {
    const io = await signedIn()
    const r = await cli(io, 'run', KNOWN_RUN)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(
      [
        `Run ${KNOWN_RUN}, made 2026-11-12 08:00 UTC`,
        '',
        'Your draft:',
        '  Hi Dana, quick note about pricing.',
        '',
        "Amdahl's message:",
        '  Hi Dana, Helix cut provisioning tickets by 70%. Worth 15 minutes?',
        '',
        'Left out:',
        '  - a second proof point: The context held one.',
        '',
        'You sent 1 fact, 1 rule.',
        '',
      ].join('\n')
    )
    const json = await cli(io, 'run', KNOWN_RUN, '--json')
    expect(json.json).toMatchObject({ ok: true, run_id: KNOWN_RUN, draft: 'Hi Dana, quick note about pricing.', message: expect.stringContaining('Helix') })
  })

  it('a grade run has no message and says so; a run you do not have is a not-found that points at prompt runs', async () => {
    const io = await signedIn()
    await cli(io, 'grade', write(io, 'b.txt', 'My draft'))
    const grade = await cli(io, 'run', GRADE_RUN)
    expect(grade.stdout).toContain('  My draft')
    // Staging stores a grade's draft back as its message: the same text is no rewrite, and is said so.
    expect(grade.stdout).toContain("Amdahl's message:\n  The same as your draft: Amdahl changed nothing (a grade writes no message).")
    // A run with no message at all says so too.
    expect(runLines({ run_id: GRADE_RUN, draft: 'My draft', message: null, created_at: '2026-11-12T08:00:00Z' }, true).join('\n')).toContain('Amdahl wrote no message for this run (a grade writes no message).')
    const missing = await cli(io, 'run', UNKNOWN_RUN)
    expect(missing.code).toBe(1)
    expect(missing.stderr).toBe(`Error: No run ${UNKNOWN_RUN} from you in this workspace.\nOnly the person who made a run can open it. amdahl runs lists the ones this computer made.\n`)
    const promptRun = await cli(io, 'run', PROMPT_RUN)
    expect(promptRun).toMatchObject({ code: 2, stderr: `Error: ${PROMPT_RUN} is a prompt run.\nRead it with: amdahl prompt --run ${PROMPT_RUN}\n` })
    expect((await cli(io, 'run', 'nope')).code).toBe(2)
    expect((await cli(io, 'run')).code).toBe(2)
    expect((await cli(io, 'run', KNOWN_RUN, GRADE_RUN)).code).toBe(2)
  })
})

describe('data', () => {
  it('says what the workspace holds and what it can be filtered by, readable at 80 columns, with unknown never 0', async () => {
    const io = await signedIn()
    const r = await cli(io, 'data')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(
      [
        'What this workspace holds:',
        '  Conversations       12,431 rows, 2025-01-03 to 2026-11-10 by timestamp',
        '  CRM deals           214 rows, 2025-02-01 to 2026-10-30 by close_date',
        '  Deal qualification  unknown (could not be read)',
        '',
        'Conversations: 3 fields to filter on (interactions)',
        '  company_name, interaction_type, timestamp',
        '',
        'CRM deals: 3 fields to filter on (deals)',
        '  deal_name, deal_amount, close_date',
        '',
        'Deal qualification: 2 fields to filter on (deal_qualification)',
        '  company_id, computed_at',
        '',
        "One surface's fields, with type and meaning: amdahl data --surface deals",
        '',
      ].join('\n')
    )
    expect(r.stdout).not.toMatch(/Deal qualification {2}0 rows/)
    fits80(r.stdout)
  })

  it('--surface lists one surface with each field type, meaning and values; an unknown surface is a usage error', async () => {
    const io = await signedIn()
    const r = await cli(io, 'data', '--surface', 'interactions')
    expect(r.code).toBe(0)
    expect(requests('/search/fields').at(-1)?.path).toBe('/api/platform/v1/search/fields')
    expect(server!.log.filter((l) => l.path.endsWith('/search/fields')).length).toBe(1)
    expect(r.stdout).toContain('  interaction_type (STRING)\n      What kind of conversation it was.\n      Values: CALL, EMAIL, MEETING')
    expect(r.stdout).not.toContain('deal_name')
    expect(r.stdout).not.toContain('CRM deals ')
    fits80(r.stdout)
    const bad = await cli(io, 'data', '--surface', 'calls')
    expect(bad.code).toBe(2)
    expect(bad.stderr).toBe('Error: --surface must be one of: interactions, deals, deal_qualification.\n')
  })

  it('says nothing has synced when every count is 0, and --json prints both reads; a read-only key can read it', async () => {
    const io = await signedIn({ overview: { surfaces: [{ surface: 'interactions', row_count: 0, earliest_at: null, latest_at: null, time_field: 'timestamp' }] } })
    const r = await cli(io, 'data')
    expect(r.stdout).toContain('  Conversations  0 rows')
    expect(r.stdout).toContain('Nothing has synced yet.\nConnect your CRM or call recorder: amdahl connect')
    const json = await cli(io, 'data', '--json')
    expect(json.json).toMatchObject({ ok: true, overview: { surfaces: [{ surface: 'interactions' }] }, fields: { surfaces: expect.any(Array) } })
    const key = fakeIo({ AMDAHL_API_URL: server!.url, AMDAHL_KEY: READONLY_KEY })
    expect((await cli(key, 'data')).code).toBe(0)
    expect((await cli(io, 'data', 'x')).code).toBe(2)
  })
})

describe('recipes and search --recipe', () => {
  it('lists the console recipes by category, with what each needs, in 80 columns', async () => {
    const io = await signedIn()
    const r = await cli(io, 'recipes')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('Accounts\n  account-brief          Account brief\n    What they told us, who we know, open deals and who is missing\n    Reads your CRM and calls. Needs --account <Account>.')
    expect(r.stdout).toContain('Expansion\n  expansion-signals')
    expect(r.stdout).not.toContain('Outbound')
    for (const recipe of RECIPES) expect(r.stdout).toContain(recipe.id)
    expect(r.stdout).toContain('amdahl search --recipe account-brief --account "Acme"')
    fits80(r.stdout)
    const json = await cli(io, 'recipes', '--json')
    expect(json.json.recipes).toHaveLength(12)
    expect(json.json.recipes[0]).toMatchObject({ id: 'account-brief', question: expect.stringContaining('{account}'), fill_ins: [{ flag: '--account', label: 'Account', example: 'Acme' }] })
    expect((await cli(io, 'recipes', 'x')).code).toBe(2)
  })

  it('pins the console library: the 12 search recipes, their fill-ins and questions', () => {
    // Copied from amdahl-frontend apps/universal-ui/lib/prompt-library.ts (dd187f42); see src/recipes-data.ts.
    expect(RECIPES.map((r) => r.id)).toEqual(['account-brief', 'call-prep', 'qbr-prep', 'expansion-signals', 'churn-risk', 'whitespace', 'asked-for-never-sold', 'stalled-deals', 'why-deals-die', 'competitors', 'positioning-vs-buyers', 'objection-handling'])
    expect(RECIPES.flatMap((r) => r.fills.map((f) => `${r.id}:${f.key}`))).toEqual(['account-brief:account', 'call-prep:account', 'qbr-prep:account', 'whitespace:products', 'positioning-vs-buyers:messages', 'objection-handling:objection'])
    expect(RECIPES.find((r) => r.id === 'stalled-deals')?.question).toBe('Which open deals have had no conversation with the buyer in 30 days or are past their close date, and what did the buyer say last?')
    expect(RECIPES.find((r) => r.id === 'objection-handling')?.question).toBe('How do buyers raise {objection}, how do executives put it differently from managers, and which of our answers came before deals moved forward?')
    expect(RECIPES.find((r) => r.id === 'whitespace')?.fills[0]).toEqual({ key: 'products', label: 'Your products', example: 'Analytics, Forecasting, Extra seats' })
  })

  it('runs a recipe as a search with its question filled in, and every recipe runs', async () => {
    const io = await signedIn()
    const r = await cli(io, 'search', '--recipe', 'account-brief', '--account', '  Acme   Corp ')
    expect(r.code).toBe(0)
    expect(sentBody('/api/platform/v1/search/query')).toEqual({
      query: 'Brief me on Acme Corp: why they talk to us in their own words, who we have spoken with there by seniority and when each last spoke, their open deals, who we have never reached, and the three things to raise next.',
      answer: true,
    })
    expect(r.stderr).toContain('Account brief: Brief me on Acme Corp:')
    expect(r.stdout).toContain('Buyers raised pricing and annual billing.')
    fits80(r.stderr)
    const fills: Record<string, string> = { account: 'Acme', products: 'Analytics', messages: 'Ship in days.', objection: 'price' }
    for (const recipe of RECIPES) {
      const flags = recipe.fills.flatMap((f) => [`--${f.key}`, fills[f.key]!])
      expect((await cli(io, 'search', '--recipe', recipe.id, ...flags)).code).toBe(0)
      expect(sentBody('/api/platform/v1/search/query').query).not.toMatch(/[{}]/)
    }
    const research = await cli(io, 'search', '--recipe', 'churn-risk', '--research')
    expect(research.code).toBe(0)
    expect(sentBody('/api/platform/v1/search/query')).toMatchObject({ route: 'research' })
  })

  it('refuses a missing, stray or unknown fill-in, a question beside a recipe, and an over-long fill-in is cut and said', async () => {
    const io = await signedIn()
    const before = server!.log.length
    const missing = await cli(io, 'search', '--recipe', 'account-brief')
    expect(missing.code).toBe(2)
    expect(missing.stderr).toBe('Error: Account brief needs --account <Account>.\nFor example: amdahl search --recipe account-brief --account "Acme"\n')
    expect((await cli(io, 'search', '--recipe', 'account-brief', '--account', '   ')).code).toBe(2)
    const stray = await cli(io, 'search', '--recipe', 'account-brief', '--account', 'A', '--products', 'x')
    expect(stray.stderr).toContain('account-brief has no --products.\nIt takes --account <Account>.')
    expect((await cli(io, 'search', '--recipe', 'churn-risk', '--account', 'A')).stderr).toContain('It takes no fill-in: just --recipe.')
    expect((await cli(io, 'search', '--account', 'A', 'a question')).stderr).toContain('--account goes with --recipe <id>.')
    expect((await cli(io, 'search', '--recipe', 'nope')).stderr).toContain('No recipe called "nope".\namdahl recipes lists them: account-brief,')
    expect((await cli(io, 'search', '--recipe', 'churn-risk', 'my own question')).stderr).toContain('Give a question or --recipe, not both.')
    // Nothing was searched (the library read is the only request a usage error may make).
    expect(server!.log.slice(before).filter((l) => l.path.endsWith('/search/query'))).toEqual([])
    const long = await cli(io, 'search', '--recipe', 'account-brief', '--account', 'x'.repeat(400))
    expect(long.stderr).toContain('Used the first 300 characters of --account.')
    expect(sentBody('/api/platform/v1/search/query').query).toContain(`Brief me on ${'x'.repeat(300)}:`)
  })

  it('--json of a recipe search is the same server answer as a search', async () => {
    const io = await signedIn()
    const json = await cli(io, 'search', '--recipe', 'stalled-deals', '--json')
    expect(json.json).toMatchObject({ ok: true, mode_ran: 'semantic' })
    expect(json.stderr).toBe('')
  })
})

describe('search --research-id and the id printed when research starts', () => {
  const RID = '66666666-6666-4666-8666-666666666666'

  it('reads a job later with a key that can read it, and prints it as --research does', async () => {
    const io = await withKey({ researchPolls: 1 })
    const r = await cli(io, 'search', '--research-id', RID)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('Deals with a pricing objection closed less often.\n\nAsk next:\n- Which competitor came up most?\n')
    expect(requests(`/research/${RID}`).length).toBeGreaterThan(1)
    const json = await cli(io, 'search', '--research-id', RID, '--json')
    expect(json.json).toMatchObject({ ok: true, research: { research_id: RID, status: 'complete' } })
  })

  it('a sign-in cannot read research: it says so and names the key; bad ids and combinations send nothing', async () => {
    const io = await signedIn()
    const refused = await cli(io, 'search', '--research-id', RID)
    expect(refused.code).toBe(4)
    expect(refused.stderr).toBe(`Error: This credential can't read research ${RID}.\nResearch needs a Customer agent key: amdahl keys create --name research --preset agent\n`)
    const before = server!.log.length
    expect((await cli(io, 'search', '--research-id', 'nope')).stderr).toContain('"nope" is not a research id.')
    expect((await cli(io, 'search', 'a question', '--research-id', RID)).code).toBe(2)
    expect((await cli(io, 'search', '--research-id', RID, '--research')).code).toBe(2)
    expect((await cli(io, 'search', '--research-id', RID, '--recipe', 'churn-risk')).code).toBe(2)
    expect(server!.log.length).toBe(before)
  })

  it('a job that is still running when the wait ends says how to read it again', async () => {
    const io = await withKey({ researchPolls: 1_000_000 })
    let now = 0
    io.now = () => (now += 10 * 60_000)
    const r = await cli(io, 'search', '--research-id', RID)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain(`The research is still running.\nResearch id: ${RID}\nRead it later:\n  amdahl search --research-id ${RID}`)
  })
})

describe('sent and feedback ask at a terminal', () => {
  it('sent asks where it went out, who it went to and whether it changed: three questions, with defaults', async () => {
    const io = await signedIn()
    io.answers = ['10', 'dana@example.com', '']
    const r = await cli(io, 'sent', KNOWN_RUN)
    expect(r.code).toBe(0)
    expect(io.prompts).toHaveLength(3)
    expect(io.prompts[0]).toContain('Where did it go out? [lemlist | Instantly')
    expect(io.prompts[0]).toContain('Smartlead')
    expect(sentBody('/api/platform/v1/messages/report_send').items[0]).toMatchObject({ run_id: KNOWN_RUN, provider: 'smartlead', channel: 'email', sent_as: 'returned', recipient: 'dana@example.com' })
    expect(r.stderr).toContain('Reporting: smartlead, email, sent as returned.')
    expect(r.stdout).toBe('Reported the send.\n')
  })

  it('a pasted edit is sent as edited, with its text; Enter on the default provider picks the first', async () => {
    const io = await signedIn()
    io.answers = ['', 'dana@example.com', 'Hi Dana, my own words']
    expect((await cli(io, 'sent', KNOWN_RUN)).code).toBe(0)
    expect(sentBody('/api/platform/v1/messages/report_send').items[0]).toMatchObject({ provider: 'lemlist', sent_as: 'edited', sent_text: 'Hi Dana, my own words' })
  })

  it('sent: Enter at the "changed it?" question (the real paste reader on a fake terminal) takes the default and moves on; it does not hang', async () => {
    const io = await signedIn()
    const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; return this } })
    const output = new Writable({ write: (_c, _e, done) => done() })
    io.readPaste = (question, options) => {
      io.prompts.push(question)
      setTimeout(() => input.write('\r'), 20)
      return readPaste(input, output, question, options)
    }
    io.answers = ['', 'dana@example.com']
    const r = await Promise.race([cli(io, 'sent', KNOWN_RUN), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('sent hung at the changed-it question')), 2000))])
    expect(r.code).toBe(0)
    expect(sentBody('/api/platform/v1/messages/report_send').items[0]).toMatchObject({ sent_as: 'returned' })
    expect(r.stderr).toContain('sent as returned.')
  })

  it('asks only for what the command line left out, and takes the channel from the run, the recipient or the provider', async () => {
    const io = await signedIn({ optimizeResult: { ok: true, message: 'better', run_id: KNOWN_RUN } })
    await cli(io, 'optimize', write(io, 'a.txt', 'Hi'), '--channel', 'linkedin')
    io.answers = ['8', '']
    const r = await cli(io, 'sent', KNOWN_RUN, '--recipient', 'https://www.linkedin.com/in/dana-x')
    expect(r.code).toBe(0)
    expect(io.prompts).toHaveLength(2)
    expect(sentBody('/api/platform/v1/messages/report_send').items[0]).toMatchObject({ provider: 'heyreach', channel: 'linkedin_message', sent_as: 'returned' })
    // Nothing missing: nothing asked.
    io.answers = []
    io.prompts.length = 0
    expect((await cli(io, 'sent', KNOWN_RUN, '--provider', 'other', '--channel', 'email', '--sent-as', 'returned', '--provider-send-id', 'x1')).code).toBe(0)
    expect(io.prompts).toEqual([])
    // With --sent-text given, the one question is whether it was changed.
    io.answers = ['2']
    const text = write(io, 'sent.txt', 'As sent')
    expect((await cli(io, 'sent', KNOWN_RUN, '--provider', 'other', '--provider-send-id', 'x2', '--sent-text', text)).code).toBe(0)
    expect(io.prompts[0]).toContain('Was it sent as Amdahl returned it?')
    expect(sentBody('/api/platform/v1/messages/report_send').items[0]).toMatchObject({ sent_as: 'edited', sent_text: 'As sent' })
  })

  it('checks what was given before asking, so a typo costs no answers; Ctrl+C stops with nothing sent', async () => {
    const io = await signedIn()
    io.answers = ['1', 'a@b.co', '']
    const bad = await cli(io, 'sent', KNOWN_RUN, '--sent-at', 'yesterday')
    expect(bad.code).toBe(2)
    expect(io.prompts).toEqual([])
    expect(requests('/report_send')).toHaveLength(0)
    io.answers = [null]
    const stopped = await cli(io, 'sent', KNOWN_RUN)
    expect(stopped.code).toBe(130)
    expect(requests('/report_send')).toHaveLength(0)
    expect((await cli(io, 'sent', 'not-an-id')).code).toBe(2)
  })

  it('with --json, in an agent, in CI or with AMDAHL_NO_PROMPT=1, nothing is asked and a missing flag is the usage error it was', async () => {
    const io = await signedIn()
    const expected = 'Error: Say where it went out with --provider:'
    const json = await cli(io, 'sent', KNOWN_RUN, '--json')
    expect(json.code).toBe(2)
    expect(json.json).toMatchObject({ ok: false, error: { code: 'usage' } })
    for (const env of [{ CLAUDECODE: '1' }, { CURSOR_AGENT: '1' }, { CI: 'true' }, { AMDAHL_NO_PROMPT: '1' }]) {
      const quiet = fakeIo({ ...io.env, ...env }, io.homedir)
      const r = await cli(quiet, 'sent', KNOWN_RUN)
      expect(r.code).toBe(2)
      expect(r.stderr).toContain(expected)
      expect(quiet.prompts).toEqual([])
      const f = await cli(quiet, 'feedback', KNOWN_RUN)
      expect(f.code).toBe(2)
      expect(f.stderr).toContain('Say how you know with --evidence')
      expect(quiet.prompts).toEqual([])
    }
    io.stdinIsTTY = false
    expect((await cli(io, 'sent', KNOWN_RUN)).code).toBe(2)
    expect(io.prompts).toEqual([])
  })

  it('feedback asks how you know, then what happened: two questions, with defaults, and only for what is missing', async () => {
    const io = await signedIn()
    io.answers = ['', '2']
    const r = await cli(io, 'feedback', KNOWN_RUN)
    expect(r.code).toBe(0)
    expect(io.prompts).toHaveLength(2)
    expect(sentBody(`/api/platform/v1/messages/optimize/runs/${KNOWN_RUN}/feedback`)).toEqual({ evidence: 'did_it_myself', outcome: 'used_with_edits' })
    io.prompts.length = 0
    io.answers = ['2']
    expect((await cli(io, 'feedback', KNOWN_RUN, '--outcome', 'used')).code).toBe(0)
    expect(io.prompts).toHaveLength(1)
    expect(sentBody(`/api/platform/v1/messages/optimize/runs/${KNOWN_RUN}/feedback`)).toEqual({ evidence: 'reported_to_me', outcome: 'used' })
    io.prompts.length = 0
    io.answers = []
    expect((await cli(io, 'feedback', KNOWN_RUN, '--evidence', 'inferred', '--comment', 'ok')).code).toBe(0)
    expect(io.prompts).toEqual([])
  })
})

describe('asking needs a terminal on both sides, and never --json', () => {
  it('sent and feedback with stdout piped (amdahl sent <id> | tee) ask nothing and give the usage error', async () => {
    const io = await signedIn()
    io.stdoutIsTTY = false
    io.answers = ['1', 'a@b.co', '']
    const sent = await cli(io, 'sent', KNOWN_RUN)
    expect(sent.code).toBe(2)
    expect(sent.stderr).toContain('Say where it went out with --provider:')
    const feedback = await cli(io, 'feedback', KNOWN_RUN)
    expect(feedback.code).toBe(2)
    expect(feedback.stderr).toContain('Say how you know with --evidence')
    expect(io.prompts).toEqual([])
    expect(requests('/report_send')).toHaveLength(0)
  })

  it('grade and prompt with no file never ask under --json or with stdout piped: the usage error, and no request', async () => {
    const io = await signedIn()
    io.answers = ['A pasted message']
    const before = server!.log.length
    for (const argv of [['grade', '--json'], ['prompt', '--json']]) {
      const r = await cli(io, ...argv)
      expect(r.code).toBe(2)
      expect(r.json).toMatchObject({ ok: false, error: { code: 'usage' } })
    }
    io.stdoutIsTTY = false
    for (const command of ['grade', 'prompt']) {
      const r = await cli(io, command)
      expect(r.code).toBe(2)
      expect(r.stderr).toContain(command === 'grade' ? 'Give a file to grade, or pipe the message on stdin.' : 'Give a file with the prompt, or pipe the prompt on stdin.')
    }
    expect(io.prompts).toEqual([])
    expect(server!.log.length).toBe(before)
  })
})

describe('limits checked before a request', () => {
  it('grade refuses a message over the 10,000 characters the server takes, and takes exactly 10,000', async () => {
    const io = await signedIn()
    const before = server!.log.length
    const over = await cli(io, 'grade', write(io, 'big.txt', 'x'.repeat(10_001)))
    expect(over.code).toBe(2)
    expect(over.stderr).toMatch(/^Error: A message is at most 10000 characters; .*big\.txt has 10001\.\n$/)
    expect(server!.log.length).toBe(before)
    expect((await cli(io, 'grade', write(io, 'ok.txt', 'x'.repeat(10_000)))).code).toBe(0)
  })

  it('the strict mock refuses an optimize_prompt body the server refuses: triggers, an over-long key, a bad sender', () => {
    expect(promptProblems({ prompt: 'p', context: { facts: ['f'] } })).toEqual([])
    expect(promptProblems({ prompt: 'p', context: { triggers: [] } })[0]).toContain("Unrecognized key(s) in object: 'triggers'")
    expect(promptProblems({ prompt: 'p', context: { facts: Array.from({ length: 11 }, () => 'f') } })[0]).toContain('at most 10 element(s)')
    expect(promptProblems({ prompt: 'p', idempotency_key: 'k'.repeat(201) })[0]).toContain('idempotency_key')
    expect(promptProblems({ prompt: 'p', idempotency_key: 'k'.repeat(200) })).toEqual([])
    expect(promptProblems({ prompt: 'p', sender: {} })[0]).toContain('name an email or a name')
    expect(promptProblems({ prompt: 'p', sender: { email: 'not-an-email' } })[0]).toContain('$.sender.email')
    expect(promptProblems({ prompt: 'p', sender: { name: 'Dana', extra: 1 } })[0]).toContain("'extra'")
    expect(promptProblems({ prompt: 'p', sender: { email: 'dana@example.com' } })).toEqual([])
  })

  it('keeps 50 runs, as the README and the PR say', () => {
    expect(MAX_KEPT).toBe(50)
  })
})

describe('review fixes from the QA round', () => {
  const PROMPT = 'Write a first-touch email to a Head of Platform. Name what they shipped, then ask for 15 minutes.'

  it('a better revision the sidecar did not keep (unchanged, reportable positive lift, a note) says so and prints the note, not "no revision wrote better email"', async () => {
    // The sidecar's own text (amdahl-pipelines v3/prompt_opt/service/prompt_job.py): 1 reads "1 unfilled placeholder", 2 or more "N unfilled placeholders".
    const says = 'The revised prompt wrote 1 unfilled placeholder into its held-out emails, so it is not returned, whatever its grade. Each email\'s placeholders list them.'
    const io = await signedIn({
      promptResult: () => ({
        prompt_mode: 'improve', outcome: 'unchanged', lift: 0.4, lift_reportable: true,
        grade: { original: { mean: 2.6, n: 3, emails_passing_bar: 0, bar: 4.2, lines: {} }, revised: { mean: 3, n: 3, emails_passing_bar: 0, bar: 4.2, lines: {} } },
        emails: [], notes: [{ code: 'revision_left_placeholders', says }], judges: { final: { model: 'm' } },
      }),
    })
    const r = await cli(io, 'prompt', write(io, 'p.md', PROMPT))
    expect(r.code).toBe(0)
    const out = flat(r.stdout)
    expect(out).toContain('A revision scored higher on the held-out emails, but Amdahl did not keep it, so your prompt stays as it is. Your prompt averages 2.6 of 5, over 3 emails, 0 passing the bar of 4.2.')
    expect(out).toContain("The revision averaged 3 of 5, 0.4 points higher, not kept.")
    expect(out).toContain(says)
    expect(out).not.toContain('No revision wrote better email')
    expect(out).not.toContain('averages 3 of 5')
    expect(r.stderr).not.toContain('Better')
    fits80(r.stdout)
  })

  it('the sidecar note for 2 or more placeholders reads "N unfilled placeholders" and prints as it came', async () => {
    const says = "The revised prompt wrote 3 unfilled placeholders into its held-out emails, so it is not returned, whatever its grade. Each email's placeholders list them."
    const io = await signedIn({
      promptResult: () => ({ outcome: 'unchanged', lift: 0.4, lift_reportable: true, grade: { original: { mean: 2.6, n: 3, emails_passing_bar: 0, bar: 4.2, lines: {} }, revised: { mean: 3, n: 3, emails_passing_bar: 0, bar: 4.2, lines: {} } }, emails: [], notes: [{ code: 'revision_left_placeholders', says }] }),
    })
    const r = await cli(io, 'prompt', write(io, 'p.md', PROMPT))
    expect(flat(r.stdout)).toContain(says)
    fits80(r.stdout)
  })

  it('a note is printed for any outcome', async () => {
    const io = await signedIn({
      promptResult: () => ({ outcome: 'unchanged', lift: null, lift_reportable: false, lift_not_reportable_reason: 'no_revision', grade: { original: { mean: 3, n: 2, emails_passing_bar: 0, bar: 4.2, lines: {} }, revised: null }, emails: [], notes: [{ says: 'Only two recipients were found.' }] }),
    })
    expect(flat((await cli(io, 'prompt', write(io, 'p.md', PROMPT))).stdout)).toContain('Only two recipients were found.')
  })

  it('sent: an email-shaped recipient means email, before the run\'s channel and the provider; a LinkedIn profile means linkedin', async () => {
    const io = await signedIn({ optimizeResult: { ok: true, message: 'better', run_id: KNOWN_RUN } })
    await cli(io, 'optimize', write(io, 'a.txt', 'Hi'), '--channel', 'linkedin')
    // The run was a LinkedIn message; the person answers lemlist and gives an email address: it went out as email.
    io.answers = ['', 'dana@acme.com', '']
    const r = await cli(io, 'sent', KNOWN_RUN)
    expect(r.code).toBe(0)
    expect(sentBody('/api/platform/v1/messages/report_send').items[0]).toMatchObject({ provider: 'lemlist', channel: 'email', recipient: 'dana@acme.com' })
    expect(r.stderr).toContain('Reporting: lemlist, email, sent as returned.')
    // The reverse: an email run, a LinkedIn profile as the recipient: linkedin_message.
    const io2 = await signedIn({ optimizeResult: { ok: true, message: 'better', run_id: KNOWN_RUN } })
    await cli(io2, 'optimize', write(io2, 'a.txt', 'Hi'), '--channel', 'email')
    io2.answers = ['', '']
    const r2 = await cli(io2, 'sent', KNOWN_RUN, '--recipient', 'https://www.linkedin.com/in/dana-x')
    expect(r2.code).toBe(0)
    expect(sentBody('/api/platform/v1/messages/report_send').items[0]).toMatchObject({ channel: 'linkedin_message' })
    // No recipient shape to go by: the run's channel when the provider can send it, else the provider's (HeyReach sends LinkedIn only).
    io2.answers = ['8', '']
    expect((await cli(io2, 'sent', KNOWN_RUN, '--provider-send-id', 'x9')).code).toBe(0)
    expect(sentBody('/api/platform/v1/messages/report_send').items[0]).toMatchObject({ provider: 'heyreach', channel: 'linkedin_message' })
  })

  it('sent with only --channel missing asks what was sent at a terminal, and is the usage error where nothing can be asked', async () => {
    const io = await signedIn()
    io.answers = ['2']
    const r = await cli(io, 'sent', KNOWN_RUN, '--provider', 'other', '--sent-as', 'returned', '--provider-send-id', 'x1')
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual(['What was sent? [Email | LinkedIn message | LinkedIn invite | LinkedIn InMail]'])
    expect(sentBody('/api/platform/v1/messages/report_send').items[0]).toMatchObject({ provider: 'other', channel: 'linkedin_message' })
    // Where it cannot ask (a script, --json, CI): the usage error, and nothing asked.
    io.prompts.length = 0
    io.env.AMDAHL_NO_PROMPT = '1'
    const script = await cli(io, 'sent', KNOWN_RUN, '--provider', 'other', '--sent-as', 'returned', '--provider-send-id', 'x1')
    expect(script.code).toBe(2)
    expect(script.stderr).toContain('Say what was sent with --channel:')
    expect(io.prompts).toEqual([])
    const help = await cli(io, 'sent', '--help')
    expect(flat(help.stdout)).toContain('Only when none of these says (a tool that sends both, a send id and no recipient) it asks what was sent.')
  })

  it('prompt --run --no-wait reads at once, without wait_ms; waiting reads send it', async () => {
    const io = await signedIn({ promptPolls: 0 })
    await cli(io, 'prompt', write(io, 'p.md', PROMPT), '--no-wait')
    const reads = () => server!.log.filter((l) => l.method === 'GET' && l.path.includes('/optimize_prompt/'))
    expect(reads()).toHaveLength(0)
    expect((await cli(io, 'prompt', '--run', PROMPT_RUN, '--no-wait')).code).toBe(0)
    expect(reads()).toHaveLength(1)
    expect(reads()[0]?.query).toBe('')
    expect((await cli(io, 'prompt', '--run', PROMPT_RUN)).code).toBe(0)
    expect(reads().at(-1)?.query).toBe('?wait_ms=30000')
  })
})

describe('0.5.0: cold QA findings and the empty-search reason', () => {
  const FRESH = { message: 'No matches. Latest conversation 2026-11-01; last sync 2026-11-02.' }
  const q = (io: FakeIo, ...args: string[]) => cli(io, 'search', ...args)

  // 1. A search cut by its deadline is not "no matches".
  it('a search cut by the deadline (or a failed read) says it ran out of time, suggests --research and exits 1, never "No matches"', async () => {
    const note = 'This part of the search took too long and was cut short. Narrow the ask, or open a Chat for a guided investigation that can run longer.'
    const cutLane = { success: true, mode_ran: 'fuzzy', results: [], data_freshness: FRESH, detail: { internal: { status: 'failed', rows: [], cut_by: 'deadline', note } } }
    const cutGroup = { success: true, mode_ran: 'fuzzy', results: [], data_freshness: FRESH, detail: { groups: [{ internal: { status: 'failed', cut_by: 'deadline' } }] } }
    const readFailed = { success: true, mode_ran: 'semantic', results: [], data_freshness: FRESH, corpus: { empty_reason: 'read_failed' } }
    for (const searchResult of [cutLane, cutGroup, readFailed]) {
      const io = await signedIn({ searchResult })
      const r = await q(io, 'open deals with a pricing objection')
      expect(r.code).toBe(1)
      expect(r.stdout).toBe('')
      expect(flat(r.stderr)).toContain('The search ran out of time before it found anything. Run the same command with --research: it can run longer. Research needs a Customer agent key:')
      expect(r.stderr).not.toContain('No matches')
      const json = await q(io, 'open deals', '--json')
      expect(json.code).toBe(1)
      expect(json.json).toMatchObject({ ok: false, mode_ran: expect.any(String) })
      await server!.close()
      server = null
    }
  })

  it('rows that came back before a deadline cut are shown, with a note, and exit 0; an honest empty is not a time-out', async () => {
    const io = await signedIn({ searchResult: { success: true, results: [{ id: 'r1', title: 'Discovery call', text: 'Pricing.' }], detail: { groups: [{ internal: { cut_by: 'deadline' } }] } } })
    const r = await q(io, 'pricing')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('1. Discovery call')
    expect(flat(r.stderr)).toContain('Part of the search ran out of time, so these rows may be incomplete.')
    server!.options.searchResult = { success: true, results: [], data_freshness: FRESH, corpus: { empty_reason: 'no_match' } }
    const empty = await q(io, 'nothing here')
    expect(empty.code).toBe(0)
    expect(empty.stderr).not.toContain('ran out of time')
  })

  // The queued note: Agu's `amdahl search "why did we lose the automat deal last time, in their own words"`.
  const AUTOMAT = {
    success: true,
    mode_ran: 'fuzzy',
    results: [],
    answer: { status: 'skipped', text: null, reason: 'no_rows' },
    corpus: { store: 'warehouse', grain: 'row', empty_reason: 'unsupported' },
    detail: { internal: { status: 'unsupported', rows: [], row_count: 0, explanation: 'Which account do you mean? Please clarify the account name: "automat" matched no company exactly.', note: null } },
  }

  it("an unsupported search says the server's reason in plain words, and a why question gets one next step", async () => {
    const io = await signedIn({ searchResult: AUTOMAT })
    const r = await q(io, 'why did we lose the automat deal last time, in their own words')
    expect(r.code).toBe(0)
    expect(r.stdout).not.toBe('No matches.\n')
    expect(flat(r.stdout)).toContain('Which account do you mean? Please clarify the account name: "automat" matched no company exactly.')
    expect(flat(r.stdout)).toContain('Next: add --research, which can answer a why or compare question (it needs a Customer agent key), or name the company exactly as your CRM spells it.')
    fits80(r.stdout)
    // A question that is not a why or compare question gets the reason and no next step.
    const plain = await q(io, 'list the automat deals')
    expect(flat(plain.stdout)).toContain('Which account do you mean?')
    expect(plain.stdout).not.toContain('Next:')
    // --json is the server's answer, as it was.
    expect((await q(io, 'why did we lose', '--json')).json).toMatchObject({ ok: true, mode_ran: 'fuzzy', corpus: { empty_reason: 'unsupported' } })
  })

  it("a long server explanation is cut at a word, not in the middle of one", async () => {
    const explanation = `I cannot answer this with the available schema. ${'There is no company named automat resolvable to a single deal. '.repeat(8)}`
    const io = await signedIn({ searchResult: { ...AUTOMAT, detail: { internal: { status: 'unsupported', explanation } } } })
    const out = flat((await q(io, 'list the automat deals')).stdout)
    expect(out).toContain('...')
    // The text before the ellipsis ends on a whole word of the explanation.
    const words = new Set(explanation.split(/[\s.]+/))
    expect(words.has(out.split('...')[0]!.trim().split(' ').at(-1)!.replace(/\.$/, ''))).toBe(true)
    expect(cutAtWord('alpha beta gamma delta', 14)).toBe('alpha beta...')
  })

  it('with no sentence from the server, the reason code is said in words; with neither, it is "No matches."', async () => {
    const io = await signedIn({ searchResult: { success: true, results: [], corpus: { empty_reason: 'unsupported' } } })
    expect((await q(io, 'compare Acme and Globex')).stdout).toContain("Amdahl couldn't turn that question into a search it can run.")
    expect((await q(io, 'compare Acme and Globex')).stdout).toContain('Next: add --research')
    server!.options.searchResult = { success: true, results: [], corpus: { empty_reason: 'not_synced' } }
    expect((await q(io, 'x')).stdout).toBe("Your data hasn't synced yet, so there was nothing to search.\n")
    server!.options.searchResult = { success: true, results: [] }
    expect((await q(io, 'x')).stdout).toBe('No matches.\n')
  })

  // 2 and 3. The grade headline carries its coverage; "evidence was off" in words.
  it('the grade headline says how many lines it rests on, in the singular for one; a full grade has no coverage note', async () => {
    const line = (id: string, pass: boolean) => ({ id, pass, applicable: true, reason: 'r' })
    const full = ['relevant_positioning', 'grounding', 'verified_specifics', 'differentiation', 'cta_clarity'].map((id, i) => line(id, i < 4))
    const io = await signedIn({
      gradeResult: { ok: true, outcome: 'graded', run_id: GRADE_RUN, evidence: { requested: 'workspace', used: true }, grade: { score: 4.2, passed: 4, total: 5, bar: 4.2, passes_bar: true, judge: { model: 'm', judge_version: 'v', role: 'final' }, lines: full }, disclosures: { single_run: true, not_reply_prediction: true, repeat_spread: null } },
    })
    const r = await cli(io, 'grade', write(io, 'd.txt', 'Hello there'), '--evidence', 'workspace')
    expect(r.stdout.startsWith('Grade 4.2 of 5: 4 of 5 lines passed.\n')).toBe(true)
    expect(r.stdout).not.toContain('on 4 of the 5')
    const one = await signedIn()
    const partial = await cli(one, 'grade', write(one, 'e.txt', 'Hello there'))
    expect(partial.stdout.startsWith('Grade 5 of 5, on 1 of the 5 lines (1 of 1 line passed).\n')).toBe(true)
  })

  it('a line not evaluated because evidence was off says so, in either spelling of the reason', async () => {
    const off = (reason: string) => ({ id: 'grounding', pass: null, applicable: false, reason, not_applicable_reason: reason })
    for (const reason of ['no_retrieval_configured', 'no retrieval configured']) {
      const io = await signedIn({
        gradeResult: { ok: true, outcome: 'graded', run_id: GRADE_RUN, evidence: { requested: 'off', used: false }, grade: { score: 5, passed: 1, total: 1, bar: 4.2, passes_bar: true, judge: { model: 'm', judge_version: 'v', role: 'final' }, lines: [{ id: 'cta_clarity', pass: true, applicable: true, reason: 'ok' }, off(reason)] }, disclosures: { single_run: true, not_reply_prediction: true, repeat_spread: null } },
      })
      const r = await cli(io, 'grade', write(io, 'd.txt', 'Hello there'))
      expect(r.stdout).toContain('Not evaluated: evidence was off (add --evidence workspace).')
      expect(r.stdout).not.toContain('retrieval')
      await server!.close()
      server = null
    }
  })

  // 4. The prompt lift.
  it('a revision that was not kept shows its mean and the gap, rounded, not a bare -1.3333', async () => {
    const io = await signedIn({
      promptResult: () => ({
        outcome: 'unchanged', lift: -1.3333333, lift_reportable: true,
        grade: { original: { mean: 5, n: 3, emails_passing_bar: 3, bar: 4.2, lines: {} }, revised: { mean: 3.6666667, n: 3, emails_passing_bar: 1, bar: 4.2, lines: {} } },
        emails: [], notes: [], judges: { final: { model: 'm' } },
      }),
    })
    const r = await cli(io, 'prompt', write(io, 'p.md', 'Write a first-touch email to a Head of Platform. Name what they shipped, then ask for 15 minutes.'))
    const out = flat(r.stdout)
    expect(out).toContain('The revision averaged 3.7 of 5, 1.3 points lower, not kept.')
    expect(out).not.toContain('1.3333')
    expect(out).not.toContain('3.6666')
    fits80(r.stdout)
    // A kept revision's lift is rounded and in points.
    server!.options.promptResult = () => ({ outcome: 'improved', prompt: 'Better', lift: 1.2666667, lift_reportable: true, grade: { original: { mean: 2.6, n: 3, emails_passing_bar: 0, bar: 4.2, lines: {} }, revised: { mean: 3.8666667, n: 3, emails_passing_bar: 1, bar: 4.2, lines: {} } }, emails: [], judges: { final: { model: 'm' } } })
    const kept = await cli(io, 'prompt', write(io, 'p2.md', 'Write a first-touch email to a Head of Platform. Name what they shipped, then ask for 15 minutes.'))
    expect(kept.stderr).toContain('Lift on the held-out recipients: +1.3 points.')
    expect(flat(kept.stderr)).toContain('it averages 3.9 of 5')
  })

  // 5 and 6. `run` on a grade run, and the prompt-runs pointer.
  it('run on a grade run shows the grade when the API returns one, else says it is not stored', async () => {
    const io = await signedIn()
    await cli(io, 'grade', write(io, 'd.txt', 'Hello there'))
    const r = await cli(io, 'run', GRADE_RUN)
    expect(r.code).toBe(0)
    expect(flat(r.stdout)).toContain('A run does not keep its grade, so it cannot be shown again. Grade the draft again: amdahl grade <file>.')
    // A run that carries its grade shows it.
    const lines = runLines({ run_id: GRADE_RUN, draft: 'Hi', message: 'Hi', grade: { score: 4, passed: 4, total: 5, bar: 4.2, passes_bar: false, lines: [{ id: 'cta_clarity', pass: true, applicable: true, reason: 'ok' }] } }).join('\n')
    expect(lines).toContain('Grade 4 of 5')
    expect(lines).not.toContain('does not keep its grade')
    // A rewrite has no grade to show and says nothing of one.
    expect(runLines({ run_id: KNOWN_RUN, draft: 'a', message: 'b' }).join('\n')).not.toContain('grade')
  })

  it('runs points prompt runs at prompt --run, which reads them', async () => {
    const io = await signedIn()
    await cli(io, 'prompt', write(io, 'p.md', 'Write an email.'), '--no-wait')
    const r = await cli(io, 'runs')
    expect(r.stdout).toContain('Open one: amdahl run <run-id>\nPrompt runs: amdahl prompt --run <run-id>')
    fits80(r.stdout)
  })

  // 7. data at a narrow width.
  it('data wraps to a narrow terminal, and a field shows its first sentence only, whole words', async () => {
    const long = 'The account the conversation was with, as the CRM spells it. It also carries a second sentence that goes on at some length about how names are matched and normalised across sources.'
    const io = await signedIn({
      fields: { surfaces: [{ surface: 'interactions', fields: [{ name: 'company_name', type: 'STRING', description: long, operators: ['eq'], sample_values: ['Acme Corporation', 'Globex Industries', 'Initech Software', 'Umbrella Holdings'] }] }] },
    })
    io.columns = () => 60
    const r = await cli(io, 'data', '--surface', 'interactions')
    expect(r.code).toBe(0)
    expect(r.stdout.split('\n').filter((l) => [...l].length > 60)).toEqual([])
    expect(flat(r.stdout)).toContain('The account the conversation was with, as the CRM spells it.')
    expect(r.stdout).not.toContain('second sentence')
    // A sentence longer than the room is cut at a word with an ellipsis, never in the middle of one.
    expect(firstSentence('Alpha beta gamma delta epsilon zeta eta theta', 22)).toBe('Alpha beta gamma...')
    expect(firstSentence('One sentence. Two sentence.', 100)).toBe('One sentence.')
    // A narrower terminal still gets every line inside it, headers included.
    io.columns = () => 50
    expect((await cli(io, 'data')).stdout.split('\n').filter((l) => [...l].length > 50)).toEqual([])
    // A wide terminal still wraps at 80, never wider.
    io.columns = () => 200
    expect((await cli(io, 'data')).stdout.split('\n').filter((l) => [...l].length > 80)).toEqual([])
  })

  // 8. The sent recipient question.
  it('sent: a recipient that is not an email or a LinkedIn URL is asked for once more, then refused', async () => {
    const io = await signedIn()
    io.answers = ['', 'priya', 'priya@acme.com', '']
    const r = await cli(io, 'sent', KNOWN_RUN)
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('"priya" is not an email address or a LinkedIn profile URL.')
    expect(sentBody('/api/platform/v1/messages/report_send').items[0]).toMatchObject({ recipient: 'priya@acme.com' })
    const again = await signedIn()
    again.answers = ['', 'priya', 'priya again']
    const refused = await cli(again, 'sent', KNOWN_RUN)
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain('A recipient is an email address or a LinkedIn profile URL.')
    expect(requests('/messages/report_send')).toHaveLength(0)
    // A LinkedIn URL is a recipient.
    const li = await signedIn()
    li.answers = ['', 'https://www.linkedin.com/in/priya-s', '']
    expect((await cli(li, 'sent', KNOWN_RUN)).code).toBe(0)
  })

  // 9. An unknown research id.
  it('an unknown research id says so in words, not the server\'s research:// address', async () => {
    const io = await withKey({ researchUnknown: true })
    const r = await cli(io, 'search', '--research-id', '66666666-6666-4666-8666-666666666666')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('No research job with that id in this workspace.')
    expect(r.stderr).not.toContain('research://')
  })

  // The nits from Dom's second pass.
  it('recipes: the id column is as wide as the longest id plus two, so no id runs into its title', async () => {
    const io = await signedIn()
    const out = (await cli(io, 'recipes')).stdout
    const longest = Math.max(...RECIPES.map((r) => r.id.length))
    for (const r of RECIPES) expect(out).toContain(`  ${r.id.padEnd(longest + 2)}${r.title}\n`)
    expect(out).toContain(`  positioning-vs-buyers  Positioning vs buyer words\n`)
  })

  it('recipes, runs and data with an argument say where the argument goes', async () => {
    const io = await signedIn()
    const r = await cli(io, 'recipes', 'extra')
    expect(r).toMatchObject({ code: 2, stderr: 'Error: Unexpected argument: extra\nTo run one: amdahl search --recipe <id>\n' })
    expect((await cli(io, 'runs', 'x')).stderr).toContain('To open one: amdahl run <run-id>')
    expect((await cli(io, 'data', 'deals')).stderr).toContain('A surface goes after --surface: amdahl data --surface deals')
    // Another command with no arguments still says something useful.
    expect((await cli(io, 'whoami', 'x')).stderr).toContain('amdahl whoami --help shows what it takes.')
  })

  it('sent with a prompt run id says a prompt run cannot be reported as sent, not "not a run id"', async () => {
    const io = await signedIn()
    const commands = [
      ['sent', PROMPT_RUN, '--provider', 'other', '--channel', 'email', '--sent-as', 'returned', '--provider-send-id', 'x'],
      ['feedback', PROMPT_RUN, '--evidence', 'did_it_myself', '--outcome', 'used'],
    ]
    for (const args of commands) {
      const r = await cli(io, ...(args as [string, ...string[]]))
      expect(r.code).toBe(2)
      expect(r.stderr).toContain(`${PROMPT_RUN} is a prompt run: a prompt run can't be reported as sent or given feedback.`)
      expect(r.stderr).not.toContain('is not a run id')
    }
    expect(requests('/messages/report_send')).toHaveLength(0)
  })

  it('grade and prompt with no file and nothing piped (a script) say what to give, not "Stdin is empty"', async () => {
    const io = await signedIn()
    io.stdinIsTTY = false
    io.stdinText = ''
    const g = await cli(io, 'grade')
    expect(g).toMatchObject({ code: 2 })
    expect(g.stderr).toContain('Give a file to grade, or pipe the message in.')
    expect(g.stderr).not.toContain('Stdin is empty')
    expect((await cli(io, 'prompt')).stderr).toContain('Give a file with the prompt, or pipe the prompt in.')
    // An explicit "-" with nothing piped is still an empty stdin.
    expect((await cli(io, 'grade', '-')).stderr).toContain('Stdin is empty.')
  })

  it('the sent menu shows tool names, and a tool and a channel that cannot go together are refused before anything is sent', async () => {
    const io = await signedIn()
    io.answers = ['', 'dana@example.com', '']
    await cli(io, 'sent', KNOWN_RUN)
    const menu = io.prompts[0]!
    for (const name of ['Instantly', 'Reply.io', 'La Growth Machine', 'LinkedIn (sent by hand)', 'Other (any sender not listed)', 'HeyReach']) expect(menu).toContain(name)
    for (const id of ['reply_io', 'lgm', 'linkedin_manual']) expect(menu).not.toContain(id)
    // instantly with a LinkedIn profile: refused, with nothing sent.
    const bad = await signedIn()
    bad.answers = ['2', 'https://www.linkedin.com/in/priya-s', '']
    const r = await cli(bad, 'sent', KNOWN_RUN)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Instantly sends email only, and this is a LinkedIn message.')
    expect(requests('/messages/report_send')).toHaveLength(0)
    // The same with flags: a LinkedIn-only tool with an email, and an email-only tool with a LinkedIn channel.
    const flags = await signedIn()
    const args = (provider: string, channel: string) => ['sent', KNOWN_RUN, '--provider', provider, '--channel', channel, '--sent-as', 'returned', '--provider-send-id', 'x1']
    expect((await cli(flags, ...args('heyreach', 'email'))).stderr).toContain('HeyReach sends LinkedIn only, and this is an email.')
    expect((await cli(flags, ...args('instantly', 'linkedin_message'))).code).toBe(2)
    expect((await cli(flags, ...args('lemlist', 'linkedin'))).code).toBe(0)
    expect((await cli(flags, ...args('other', 'linkedin'))).code).toBe(0)
    // Tools that run LinkedIn steps or tasks as well as email take both; only the clear mismatches are refused.
    for (const both of ['apollo', 'outreach', 'salesloft', 'hubspot', 'salesforce', 'reply_io', 'lgm', 'smartlead', 'woodpecker']) {
      expect((await cli(flags, ...args(both, 'linkedin_message'))).code).toBe(0)
      expect((await cli(flags, ...args(both, 'email'))).code).toBe(0)
    }
    for (const emailOnly of ['instantly', 'gmail']) expect((await cli(flags, ...args(emailOnly, 'linkedin_inmail'))).code).toBe(2)
    // Smartlead and Woodpecker run LinkedIn steps too.
    for (const both of ['smartlead', 'woodpecker']) expect((await cli(flags, ...args(both, 'linkedin_message'))).code).toBe(0)
    expect((await cli(flags, ...args('linkedin_manual', 'email'))).code).toBe(2)
    expect((await cli(flags, ...args('heyreach', 'linkedin'))).code).toBe(0)
  })

  it('the grade says "and your evidence" only when evidence was used', async () => {
    const io = await signedIn()
    const none = await cli(io, 'grade', write(io, 'd.txt', 'Hello there'))
    expect(flat(none.stdout)).toContain('It measures the message against the rubric. It does not predict replies.')
    expect(none.stdout).not.toContain('your evidence')
    const used = await signedIn({
      gradeResult: { ok: true, outcome: 'graded', run_id: GRADE_RUN, evidence: { requested: 'workspace', used: true }, grade: { score: 5, passed: 1, total: 1, bar: 4.2, passes_bar: true, judge: { model: 'm', judge_version: 'v', role: 'final' }, lines: [{ id: 'cta_clarity', pass: true, applicable: true, reason: 'ok' }] }, disclosures: { single_run: true, not_reply_prediction: true, repeat_spread: null } },
    })
    expect(flat((await cli(used, 'grade', write(used, 'd.txt', 'Hello there'), '--evidence', 'workspace')).stdout)).toContain('against the rubric and your evidence. It does not predict replies.')
  })

  it('--help puts feedback\'s terminal note after its description, and says nothing is asked with --json, in an agent or in CI', async () => {
    const help = (await cli(fakeIo({}), '--help')).stdout
    const block = help.slice(help.indexOf('  feedback <run-id>'), help.indexOf('  sent <run-id>'))
    expect(block.indexOf('What happened to a message')).toBeLessThan(block.indexOf('At a terminal'))
    expect(flat(block)).toContain('with --json, in an agent or in CI, nothing is asked')
  })

  // Dom's review of #44.
  const ZYX = {
    success: true,
    mode_ran: 'fuzzy',
    results: [],
    answer: { status: 'skipped', text: null, reason: 'no_rows' },
    corpus: { store: 'warehouse', grain: 'row', empty_reason: 'no_match' },
    data_freshness: { message: 'Last sync 2026-11-12; 214 deals read.' },
    detail: {
      message: 'No deals are named Zyxqorbandle Pastry Holdings.',
      internal: { status: 'empty', rows: [], row_count: 0, explanation: 'Looks up deals whose name exactly matches the given company name.', note: 'internal hint: widen the filter' },
    },
  }

  it('a search with no matches says so (detail.message and the freshness line), not the query plan, and never the internal note', async () => {
    const io = await signedIn({ searchResult: ZYX })
    const r = await q(io, 'Which CRM deals are named Zyxqorbandle Pastry Holdings?')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('No deals are named Zyxqorbandle Pastry Holdings.\nLast sync 2026-11-12; 214 deals read.\n')
    expect(r.stdout).not.toContain('Looks up deals')
    expect(r.stdout).not.toContain('internal hint')
    // No detail.message: the freshness line alone; neither: "No matches."
    server!.options.searchResult = { ...ZYX, detail: { internal: ZYX.detail.internal } }
    expect((await q(io, 'x')).stdout).toBe('Last sync 2026-11-12; 214 deals read.\n')
    server!.options.searchResult = { ...ZYX, data_freshness: undefined, detail: { internal: ZYX.detail.internal } }
    expect((await q(io, 'x')).stdout).toBe('No matches.\n')
    // An unsupported or failed search is explained by its explanation, still never by the note.
    server!.options.searchResult = { ...AUTOMAT, detail: { internal: { status: 'failed', explanation: 'The search could not read the deals table.', note: 'internal hint' } } }
    const failed = (await q(io, 'x')).stdout
    expect(failed).toContain('The search could not read the deals table.')
    expect(failed).not.toContain('internal hint')
  })

  it('sent: Smartlead and Woodpecker take LinkedIn reports; a tool that sends both is asked which when nothing says', async () => {
    const io = await signedIn()
    for (const provider of ['smartlead', 'woodpecker']) {
      const r = await cli(io, 'sent', KNOWN_RUN, '--provider', provider, '--channel', 'linkedin_message', '--sent-as', 'returned', '--provider-send-id', 'x1')
      expect(r.code).toBe(0)
      expect(sentBody('/api/platform/v1/messages/report_send').items[0]).toMatchObject({ provider, channel: 'linkedin_message' })
    }
    // At a terminal, with a send id only (no recipient, no remembered run): Woodpecker sends both, so the channel is asked for (the
    // third and last question), not recorded as email and not an error after the other answers.
    io.answers = ['13', '', '3']
    const unsure = await cli(io, 'sent', KNOWN_RUN, '--provider-send-id', 'x2')
    expect(unsure.code).toBe(0)
    expect(io.prompts.at(-1)).toBe('What was sent? [Email | LinkedIn message | LinkedIn invite | LinkedIn InMail]')
    expect(sentBody('/api/platform/v1/messages/report_send').items[0]).toMatchObject({ provider: 'woodpecker', channel: 'linkedin_invite' })
    // A tool that sends one kind needs no word on it.
    io.answers = ['2', '']
    expect((await cli(io, 'sent', KNOWN_RUN, '--provider-send-id', 'x3')).code).toBe(0)
    expect(sentBody('/api/platform/v1/messages/report_send').items[0]).toMatchObject({ provider: 'instantly', channel: 'email' })
    // Where nothing can be asked it is still the usage error.
    const quiet = await signedIn()
    quiet.env.AMDAHL_NO_PROMPT = '1'
    expect((await cli(quiet, 'sent', KNOWN_RUN, '--provider', 'woodpecker', '--sent-as', 'returned', '--provider-send-id', 'x4')).code).toBe(2)
  })

  it('a sentence is never ended at e.g., i.e., vs. or etc., nor inside an open bracket', () => {
    expect(firstSentence('Human-readable deal name from the CRM (e.g. "Acme - Expansion"). Used in the UI.', 200)).toBe('Human-readable deal name from the CRM (e.g. "Acme - Expansion").')
    expect(firstSentence('The stage, i.e. where the deal is. Second.', 200)).toBe('The stage, i.e. where the deal is.')
    expect(firstSentence('Open vs. closed deals. Second.', 200)).toBe('Open vs. closed deals.')
    expect(firstSentence('Owners, teams, etc. who hold it. Second.', 200)).toBe('Owners, teams, etc. who hold it.')
    expect(firstSentence('A value (see the list. It has more) and more. Second.', 200)).toBe('A value (see the list. It has more) and more.')
    // Too long to fit: cut back to before the open bracket, at a word.
    expect(firstSentence('Human-readable deal name from the CRM (e.g. "Acme - Expansion" or "Globex - Renewal 2026").', 50)).toBe('Human-readable deal name from the CRM...')
    // A long sentence is cut at its last clause when there is one past halfway, not mid-thought.
    expect(firstSentence('Raw CRM pipeline stage id for the deal (e.g. "closedwon"); many tenants carry opaque numeric ids that the console maps to labels for display.', 100)).toBe('Raw CRM pipeline stage id for the deal (e.g. "closedwon")...')
    // A closed bracket inside an open one does not hide it: cut back to the first bracket still open.
    expect(firstSentence('Resolved stage label for the deal (e.g. "Discovery", "Research", "Closed Won (Signed)", "Closed Lost") from the CRM.', 70)).toBe('Resolved stage label for the deal...')
    // No abbreviation, no bracket: as before.
    expect(firstSentence('One sentence. Two sentence.', 100)).toBe('One sentence.')
  })

  it('an unchanged optimize run says nothing of a grade; a run this computer made as a grade does', async () => {
    const same = { run_id: KNOWN_RUN, draft: 'Hi Dana.', message: 'Hi Dana.', created_at: '2026-11-12T08:00:00Z' }
    const rewrite = runLines(same).join('\n')
    expect(rewrite).toContain('The same as your draft: Amdahl changed nothing.')
    expect(rewrite).not.toContain('grade')
    const grade = runLines(same, true).join('\n')
    expect(grade).toContain('The same as your draft: Amdahl changed nothing (a grade writes no message).')
    expect(grade).toContain('A run does not keep its grade')
    // End to end: an optimize run opened with `run` says nothing of a grade.
    const io = await signedIn({ optimizeResult: { ok: true, message: 'Hi Dana, quick note about pricing.', run_id: KNOWN_RUN } })
    await cli(io, 'optimize', write(io, 'a.txt', 'Hi Dana, quick note about pricing.'))
    server!.options.optimizeResult = undefined
    const r = await cli(io, 'run', KNOWN_RUN)
    expect(r.stdout).not.toContain('does not keep its grade')
  })

  it('a search that is cut even with --research says so, and points at --research-id when a job started', () => {
    const id = '66666666-6666-4666-8666-666666666666'
    const none = outOfTimeLines(0, true).join(' ')
    expect(none).toContain('The search ran out of time before it found anything, even with --research. Try again, or narrow the question.')
    expect(none).not.toContain('Run the same command with --research')
    expect(outOfTimeLines(0, true, id).join(' ')).toContain(`read it later with amdahl search --research-id ${id}`)
    expect(outOfTimeLines(2, true).join(' ')).toContain('so these rows may be incomplete, even with --research')
    // Without research asked, it still suggests --research.
    expect(outOfTimeLines(0).join(' ')).toContain('Run the same command with --research')
  })

  it('width is read from COLUMNS first, then stdout, then stderr', () => {
    expect(outputColumns({ COLUMNS: '60' }, 120, 100)).toBe(60)
    expect(outputColumns({}, 100, 80)).toBe(100)
    expect(outputColumns({}, undefined, 72)).toBe(72)
    expect(outputColumns({ COLUMNS: 'wide' }, 90)).toBe(90)
    expect(outputColumns({ COLUMNS: '0' }, undefined)).toBeUndefined()
    expect(outputColumns({}, undefined, undefined)).toBeUndefined()
  })

  // 11. Keys keep their own runs.
  it("a key's runs are listed under its own key prefix, apart from another key's and from a sign-in's", async () => {
    const io = await withKey()
    expect((await cli(io, 'grade', write(io, 'd.txt', 'Hello there'))).code).toBe(0)
    const path = join(io.homedir, 'config', 'amdahl', 'runs.json')
    const kept = JSON.parse(readFileSync(path, 'utf8')).runs
    expect(kept[0].key).toBe(API_KEY.slice(0, 14))
    expect(JSON.stringify(kept)).not.toContain(API_KEY)
    // Another key's run, on the same host, is not in this key's list.
    writeFileSync(path, JSON.stringify({ version: 1, runs: [...kept, { run_id: KNOWN_RUN, created_at: '2026-11-01T00:00:00.000Z', kind: 'optimize', api_url: server!.url, key: 'amdhl_otherkey' }] }))
    const mine = await cli(io, 'runs', '--json')
    expect(mine.json).toMatchObject({ key: API_KEY.slice(0, 14), total: 1, runs: [{ run_id: GRADE_RUN }] })
    expect((await cli(io, 'runs')).stdout).toContain(`Your latest runs made with the key ${API_KEY.slice(0, 14)}..., newest first`)
    // A sign-in on the same computer sees neither.
    const signed = fakeIo({ AMDAHL_API_URL: server!.url }, io.homedir)
    expect((await cli(signed, 'runs', '--json')).json.total).toBe(0)
  })
})

describe('0.5.1: "For you" and the library from the server', () => {
  const FOR_YOU = [
    { recipe_id: 'why-deals-die', kind: 'try', reason: '1 deal lost in the last 90 days', fills: {} },
    { recipe_id: 'account-brief', kind: 'try', reason: 'Acme has a call tomorrow', fills: { account: 'Acme "Corp"' } },
  ]
  const suggestionRequests = () => requests('/search/suggestions')
  const titleOf = (id: string) => String(SUGGESTED_LIBRARY.find((r) => r.id === id)!.title)

  it('shows "For you" above the library, each row with its reason and the command that runs it, and offers no hide', async () => {
    const io = await signedIn({ suggestions: { for_you: FOR_YOU } })
    const r = await cli(io, 'recipes')
    expect(r.code).toBe(0)
    const head = r.stdout.slice(0, r.stdout.indexOf('\nAccounts\n'))
    expect(head).toContain(`For you\n  why-deals-die          ${titleOf('why-deals-die')}\n    1 deal lost in the last 90 days.\n    Run: amdahl search --recipe why-deals-die\n`)
    expect(head).toContain(`  account-brief          ${titleOf('account-brief')}\n    Acme has a call tomorrow.\n    Run: amdahl search --recipe account-brief --account 'Acme "Corp"'\n`)
    expect(r.stdout.indexOf('For you')).toBeLessThan(r.stdout.indexOf('\nAccounts\n'))
    expect(r.stdout).not.toMatch(/hide|dismiss/i)
    fits80(r.stdout)
    // The library is the server's: at-risk-deals and champions-quiet are in it, and were not in the bundled copy.
    expect(r.stdout).toContain('at-risk-deals')
    expect(r.stdout).toContain('champions-quiet')
  })

  it('shows at most 4 rows, skips a suggestion whose recipe is not in the library, and says nothing when there are none', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ recipe_id: SUGGESTED_LIBRARY[i]!.id, kind: 'try', reason: `reason ${i}`, fills: {} }))
    const io = await signedIn({ suggestions: { for_you: [{ recipe_id: 'not-in-library', kind: 'try', reason: 'x', fills: {} }, ...many] } })
    const r = await cli(io, 'recipes')
    expect(r.stdout.match(/\n {4}reason \d\./g)).toHaveLength(4)
    expect(r.stdout).not.toContain('not-in-library')
    server!.options.suggestions = { for_you: [] }
    const none = await cli(io, 'recipes')
    expect(none.stdout).not.toContain('For you')
    expect(none.stdout).toContain('Accounts')
  })

  it('--json carries for_you and where the library came from', async () => {
    const io = await signedIn({ suggestions: { for_you: FOR_YOU } })
    const json = (await cli(io, 'recipes', '--json')).json
    expect(json).toMatchObject({ ok: true, source: 'server', generated_at: '2026-11-13T22:40:02.728Z' })
    expect(json.for_you).toHaveLength(2)
    expect(json.for_you[0]).toMatchObject({ recipe_id: 'why-deals-die', title: titleOf('why-deals-die'), reason: '1 deal lost in the last 90 days', command: 'amdahl search --recipe why-deals-die' })
    expect(json.recipes).toHaveLength(14)
  })

  it('a workspace with nothing to suggest from says so with the server\'s message, and still lists the library', async () => {
    const io = await signedIn({ suggestions: { for_you: [], setup_needed: { reason: 'no_sources_connected', message: 'Connect your CRM to get recipes made for you.' } } })
    const r = await cli(io, 'recipes')
    expect(r.stdout).toContain('Connect your CRM to get recipes made for you.')
    expect(r.stdout).not.toContain('For you')
    expect(r.stdout).toContain('Accounts')
  })

  it('a server without the route (404), or no sign-in, falls back to the bundled list: no For you, no error', async () => {
    const io = await signedIn()
    const r = await cli(io, 'recipes')
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
    expect(r.stdout).not.toContain('For you')
    expect(r.stdout).not.toContain('at-risk-deals')
    expect(suggestionRequests()).toHaveLength(1)
    expect((await cli(io, 'recipes', '--json')).json).toMatchObject({ ok: true, source: 'bundled', for_you: [] })
    // Not signed in: no request at all, the same list.
    const out = fakeIo({ AMDAHL_API_URL: server!.url })
    const before = server!.log.length
    const anon = await cli(out, 'recipes')
    expect(anon.code).toBe(0)
    expect(anon.stdout).toContain('account-brief')
    expect(server!.log.length).toBe(before)
  })

  it('search --recipe sends recipe_id when the library came from the server, and not when it did not', async () => {
    const io = await signedIn({ suggestions: { for_you: [] } })
    expect((await cli(io, 'search', '--recipe', 'why-deals-die')).code).toBe(0)
    expect(sentBody('/api/platform/v1/search/query')).toMatchObject({ recipe_id: 'why-deals-die', answer: true })
    expect(sentBody('/api/platform/v1/search/query').query).toBe(SUGGESTED_LIBRARY.find((r) => r.id === 'why-deals-die')!.search && (SUGGESTED_LIBRARY.find((r) => r.id === 'why-deals-die')!.search as { question: string }).question)
    // A recipe only the server has runs too.
    expect((await cli(io, 'search', '--recipe', 'at-risk-deals')).code).toBe(0)
    expect(sentBody('/api/platform/v1/search/query')).toMatchObject({ recipe_id: 'at-risk-deals' })
    // A question of one's own carries no recipe_id.
    await cli(io, 'search', 'what is new')
    expect(sentBody('/api/platform/v1/search/query').recipe_id).toBeUndefined()
    // The server has no route: the bundled recipe runs without recipe_id (the server would refuse it), and at-risk-deals is unknown.
    const old = await signedIn()
    expect((await cli(old, 'search', '--recipe', 'why-deals-die')).code).toBe(0)
    expect(sentBody('/api/platform/v1/search/query').recipe_id).toBeUndefined()
    expect((await cli(old, 'search', '--recipe', 'at-risk-deals')).stderr).toContain('No recipe called "at-risk-deals".')
  })

  it('a Run: line has every fill-in the recipe needs, the server\'s value where it sent one and the example where it did not', async () => {
    const io = await signedIn({
      suggestions: {
        for_you: [
          { recipe_id: 'call-prep', kind: 'try', reason: 'Acme has a call tomorrow', fills: { account: 'Acme' } },
          { recipe_id: 'whitespace', kind: 'try', reason: 'Which accounts have room to grow?', fills: {} },
          // A key the recipe does not have is not passed on.
          { recipe_id: 'objection-handling', kind: 'try', reason: 'Price came up', fills: { account: 'Acme', objection: 'Too expensive' } },
        ],
      },
    })
    const r = await cli(io, 'recipes')
    expect(r.stdout).toContain("Run: amdahl search --recipe call-prep --account 'Acme'\n")
    expect(r.stdout).toContain("Run: amdahl search --recipe whitespace --products 'Analytics, Forecasting, Extra seats'\n    Swap in your own --products.\n")
    expect(r.stdout).toContain("Run: amdahl search --recipe objection-handling --objection 'Too expensive'\n")
    // A reason that is a question keeps its question mark, with no full stop after it.
    expect(r.stdout).toContain('    Which accounts have room to grow?\n')
    expect(r.stdout).not.toContain('?.')
    // Every Run: line is a command that runs: none stops at "needs --...".
    for (const row of (await cli(io, 'recipes', '--json')).json.for_you as { command: string }[]) {
      const words = execFileSync('sh', ['-c', `printf '%s\\n' ${row.command.replace('amdahl ', '')}`], { encoding: 'utf8' }).trimEnd().split('\n')
      const ran = await cli(io, ...words)
      expect(ran.stderr).not.toContain('needs --')
      expect(ran.code).toBe(0)
    }
    const json = (await cli(io, 'recipes', '--json')).json
    expect(json.for_you[2].fills).toEqual({ objection: 'Too expensive' })
    expect(json.for_you[1]).toMatchObject({ fills: {}, command: "amdahl search --recipe whitespace --products 'Analytics, Forecasting, Extra seats'" })
  })

  it('a CRM account name cannot run anything when the Run: line is pasted into a shell', async () => {
    const name = 'Ca$h `whoami` "x" \'y\'\n$(id)\tz'
    const io = await signedIn({ suggestions: { for_you: [{ recipe_id: 'account-brief', kind: 'try', reason: 'Call tomorrow', fills: { account: name } }] } })
    const r = await cli(io, 'recipes')
    const json = (await cli(io, 'recipes', '--json')).json
    const command = String(json.for_you[0].command)
    // One line, the name in single quotes with each ' as '\'' and its whitespace collapsed.
    expect(command).toBe("amdahl search --recipe account-brief --account 'Ca$h `whoami` \"x\" '\\''y'\\'' $(id) z'")
    expect(r.stdout).toContain(`Run: ${command}`.split('\n')[0]!.slice(0, 40))
    // In a real shell the words come out as one argument, and nothing is run.
    const printed = execFileSync('sh', ['-c', `printf '%s\n' ${command.replace('amdahl ', '')}`], { encoding: 'utf8' })
    expect(printed).toBe(`search\n--recipe\naccount-brief\n--account\nCa$h \`whoami\` "x" 'y' $(id) z\n`)
  })

  it('says the server\'s connect-your-data message even when it also sent rows', async () => {
    const io = await signedIn({
      suggestions: {
        for_you: [{ recipe_id: 'churn-risk', kind: 'setup', reason: 'Needs your CRM and calls', fills: {} }],
        setup_needed: { reason: 'no_sources_connected', message: 'Connect your CRM to get recipes made for you.' },
      },
    })
    const r = await cli(io, 'recipes')
    expect(r.stdout).toContain('Connect your CRM to get recipes made for you.')
    expect(r.stdout).toContain('For you\n  churn-risk')
    expect(r.stdout.indexOf('Connect your CRM')).toBeLessThan(r.stdout.indexOf('For you'))
    expect((await cli(io, 'recipes', '--json')).json.setup_needed).toEqual({ message: 'Connect your CRM to get recipes made for you.' })
  })

  it('wraps a long server title under itself', async () => {
    const library = SUGGESTED_LIBRARY.map((r) => (r.id === 'why-deals-die' ? { ...r, title: 'Why we lose deals to the competitors our buyers name most often in their own words on calls' } : r))
    const io = await signedIn({ suggestions: { for_you: [{ recipe_id: 'why-deals-die', kind: 'try', reason: 'x', fills: {} }], library } })
    const r = await cli(io, 'recipes')
    fits80(r.stdout)
    expect(r.stdout).toContain('  why-deals-die          Why we lose deals to the competitors our buyers name\n                         most often in their own words on calls\n')
  })

  it('a server that never answers costs a few seconds, not minutes, and the bundled list is used with no error', async () => {
    const io = await signedIn({ suggestionsHang: true })
    io.env.AMDAHL_LIBRARY_TIMEOUT_MS = '150'
    const started = Date.now()
    const r = await cli(io, 'recipes')
    expect(Date.now() - started).toBeLessThan(3000)
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
    expect(r.stdout).toContain('account-brief')
    // A search by recipe runs too, from the bundled copy and with no recipe_id.
    expect((await cli(io, 'search', '--recipe', 'why-deals-die')).code).toBe(0)
    expect(sentBody('/api/platform/v1/search/query').recipe_id).toBeUndefined()
  })

  it('a dead sign-in says so on recipes (it is cleared), still lists the bundled recipes, and stops search --recipe', async () => {
    const io = await signedIn({ expiresIn: 30, refresh: 'invalid_grant', suggestions: { for_you: [] } })
    const r = await cli(io, 'recipes')
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('Your sign-in has expired.')
    expect(r.stderr).toContain('amdahl login')
    expect(r.stdout).toContain('account-brief')
    const again = await cli(io, 'search', '--recipe', 'why-deals-die')
    expect(again.code).toBe(3)
  })

  it('--region (an option this version lacks) with --recipe says to update amdahl, not just "Unknown option"', async () => {
    const io = await signedIn({ suggestions: { for_you: [] } })
    const r = await cli(io, 'search', '--recipe', 'whitespace', '--region', 'EMEA')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Unknown option --region.')
    expect(r.stderr).toContain('npm install -g amdahl@latest')
    // Without --recipe it is just unknown.
    expect((await cli(io, 'search', 'what is new', '--region', 'EMEA')).stderr).not.toContain('npm install')
    expect(requests('/search/query')).toHaveLength(0)
  })

  it('a recipe with a fill-in this version does not know says to update, and searches nothing', async () => {
    const library = [...SUGGESTED_LIBRARY, { id: 'competitor-brief', title: 'Competitor brief', blurb: 'b', category: 'pipeline', needs: 'crm', search: { question: 'Brief me on {competitor}.', fills: [{ key: 'competitor', label: 'Competitor', example: 'Rival' }] } }]
    const io = await signedIn({ suggestions: { for_you: [], library } })
    const r = await cli(io, 'search', '--recipe', 'competitor-brief')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('takes a fill-in this version of amdahl does not know')
    expect(requests('/search/query')).toHaveLength(0)
  })
})
