// 0.4.9 (to become 0.5.0 after QA): the commands that bring the CLI level with the
// MCP and the console: grade, prompt, runs and run, data, recipes and
// search --recipe, search --research-id, and the questions sent and feedback
// ask at a terminal. All against the strict mock server.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runLines } from '../src/commands/runs'
import { MAX_KEPT } from '../src/history'
import { RECIPES } from '../src/recipes-data'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { promptProblems } from './helpers/strict'
import { API_KEY, GRADE_RUN, KNOWN_RUN, PROMPT_RUN, READONLY_KEY, UNKNOWN_RUN, startMockServer, type MockServer } from './helpers/mock-server'

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
    expect(r.stdout).toContain("Grade 5 of 5: 1 of 1 lines passed.\nIt meets the bar of 4.2.\nIt rests on 1 of the 5 lines; the others were not evaluated.")
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
    expect(r.stdout).toContain('does not predict replies')
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
    expect(r.stderr).toContain('This credential cannot optimize.')
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
    expect(lift.stderr).toContain('Lift on the held-out recipients: +0.8.')
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
    expect(runLines({ run_id: GRADE_RUN, draft: 'My draft', message: null, created_at: '2026-11-12T08:00:00Z' }).join('\n')).toContain('Amdahl wrote no message for this run (a grade writes none).')
    const missing = await cli(io, 'run', UNKNOWN_RUN)
    expect(missing.code).toBe(1)
    expect(missing.stderr).toBe(`Error: No run ${UNKNOWN_RUN} from you in this workspace.\nOnly the person who made a run can open it. A prompt run? amdahl prompt --run ${UNKNOWN_RUN}\n`)
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
    expect(r.stdout).toContain('Accounts\n  account-brief         Account brief\n    What they told us, who we know, open deals and who is missing\n    Reads your CRM and calls. Needs --account <Account>.')
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
    expect(server!.log.length).toBe(before)
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
    expect(io.prompts[0]).toContain('Where did it go out? [lemlist | instantly')
    expect(io.prompts[0]).toContain('smartlead')
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
