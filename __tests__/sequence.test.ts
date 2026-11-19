// `amdahl sequence`: improve 2 to 10 emails in order, or write 2 to 6 new ones, each as a follow-up
// to the final emails before it. All through the real entry point, against the strict mock server,
// which answers each request with a message made from that request.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { API_KEY, WHAT_CHANGED, startMockServer, type MockServer } from './helpers/mock-server'

let server: MockServer | null = null
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 18, 12))
})
afterEach(async () => {
  vi.useRealTimers()
  await server?.close()
  server = null
})

const FIRST_NAME = 'Greet the reader with {{first_name}} so the sequencer fills it in.'
const NO_DATE = 'Do not name the date or day of an earlier email: the send dates are not set yet.'
const OPTIMIZE = '/api/platform/v1/messages/optimize'
const DAY = '2026-11-18'

type Answer = Record<string, unknown>

/** What a rewrite of `body` looks like: "Better: " before the text, "!" after a subject. A written email names its place and the touches it had. */
function rewrite(body: Answer, index: number): Answer {
  const message = String(body.message ?? '')
  const context = (body.context ?? {}) as { rules?: string[]; prior_touches?: unknown[] }
  if (!message) {
    const name = /email \d+ of \d+: ([^.]*)\./.exec(context.rules?.[1] ?? '')?.[1]
    return { ok: true, message: `Subject: ${name} for {{company}}\n\nWritten email ${index + 1} after ${context.prior_touches?.length ?? 0} earlier.`, unchanged: false, run_id: `run-${index + 1}` }
  }
  const m = /^Subject: (.*)\n\n([\s\S]*)$/.exec(message)
  return { ok: true, message: m ? `Subject: ${m[1]}!\n\nBetter: ${m[2]}` : `Better: ${message}`, unchanged: false, run_id: `run-${index + 1}` }
}

/** `rewrite`, except for the emails named (from 0): a fixed answer, or one made from the plain rewrite. */
const answers = (over: Record<number, Answer | ((plain: Answer) => Answer)> = {}) => (body: Answer, index: number) => {
  const plain = rewrite(body, index)
  const one = over[index]
  return typeof one === 'function' ? one(plain) : (one ?? plain)
}

async function withKey(options: Parameters<typeof startMockServer>[0] = {}): Promise<FakeIo> {
  await server?.close()
  server = await startMockServer({ optimizeAnswer: answers(), ...options })
  const io = fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_KEY: API_KEY })
  io.stdinIsTTY = false
  return io
}

const write = (io: FakeIo, name: string, text: string) => {
  const path = join(io.cwd, name)
  writeFileSync(path, text)
  return path
}

const bodies = () => (server?.log ?? []).filter((r) => r.path === OPTIMIZE).map((r) => JSON.parse(r.body) as Answer)

const SEQ = [
  'Subject: Ramping SDRs at {{company}}',
  '',
  'Hi {{first_name}}, most teams take 4 months to ramp a new rep.',
  '---',
  'Hi {{first_name}}, bumping this up. Worth a quick call?',
  '---',
  'Subject: Close the loop?',
  '',
  'Hi {{first_name}}, should I stop reaching out?',
].join('\n')

const TOUCH_1 = 'Subject: Ramping SDRs at {{company}}!\n\nBetter: Hi {{first_name}}, most teams take 4 months to ramp a new rep.'
const TOUCH_2 = 'Better: Hi {{first_name}}, bumping this up. Worth a quick call?'

const OUT_3 = [
  'Email 1 of 3',
  'Subject: Ramping SDRs at {{company}}!',
  '',
  'Better: Hi {{first_name}}, most teams take 4 months to ramp a new rep.',
  '',
  'Email 2 of 3',
  'Better: Hi {{first_name}}, bumping this up. Worth a quick call?',
  '',
  'Email 3 of 3',
  'Subject: Close the loop?!',
  '',
  'Better: Hi {{first_name}}, should I stop reaching out?',
  '',
].join('\n')

describe('improving a sequence', () => {
  it('sends each email in order: email 2 is a reply with no subject, and carries the improved email 1', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequence', write(io, 'emails.md', SEQ))
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(OUT_3)
    expect(r.stderr).toBe(`Run: run-1\nRun: run-2\nRun: run-3\nKept your fill-in fields: {{company}}, {{first_name}}.\nSent them? amdahl sent <run id> --provider <provider> --channel <channel> --sent-as returned --provider-send-id <id>\n`)
    expect(bodies()).toEqual([
      { message: 'Subject: Ramping SDRs at {{company}}\n\nHi {{first_name}}, most teams take 4 months to ramp a new rep.', channel: 'email' },
      { message: 'Hi {{first_name}}, bumping this up. Worth a quick call?', channel: 'email', context: { prior_touches: [{ on: DAY, channel: 'email', summary: TOUCH_1 }] } },
      {
        message: 'Subject: Close the loop?\n\nHi {{first_name}}, should I stop reaching out?',
        channel: 'email',
        context: { prior_touches: [{ on: DAY, channel: 'email', summary: TOUCH_1 }, { on: DAY, channel: 'email', summary: TOUCH_2 }] },
      },
    ])
  })

  it('at a terminal: says which email it is on, shows what changed under that email, and ends on how to save a CSV', async () => {
    const io = await withKey({
      optimizeAnswer: answers({
        0: (plain) => ({ ...plain, ...WHAT_CHANGED }),
        1: (plain) => ({ ...plain, unchanged: true, message: 'Hi {{first_name}}, bumping this up. Worth a quick call?' }),
      }),
    })
    io.stdinIsTTY = true
    io.stderrIsTTY = true
    const path = write(io, 'emails.md', SEQ)
    const r = await cli(io, 'sequence', path, '--no-color')
    expect(r.code).toBe(0)
    expect(r.stderr.split('\n')).toEqual([
      'Found 3 emails:',
      '  1. Subject: Ramping SDRs at {{company}}',
      '  2. Hi {{first_name}}, bumping this up. Worth a quick call?',
      '  3. Subject: Close the loop?',
      'About 3 minutes in all.',
      'Amdahl is improving email 1 of 3.',
      'What Amdahl changed:',
      '  - "We are the leading onboarding platform."',
      '    Cut: nothing in your calls backs it.',
      '  + "Helix cut provisioning tickets by 70% in one quarter."',
      '    New: it gives proof from a team like theirs.',
      '    Source: "We cut provisioning tickets by 70% after we moved onto the new',
      '    platform and trained every..." (call) (+1 more)',
      '  - "Quick note about pricing."',
      '  + "Quick note on pricing for Helix."',
      '    Why: Names the company.',
      '  - "Can we talk?"',
      '  + "Worth 15 minutes?"',
      '    Cut: it did not say how long.',
      '    New: it asks for 15 minutes.',
      'Run: run-1',
      'Amdahl is improving email 2 of 3.',
      'Kept your draft: no rewrite beat it.',
      'Run: run-2',
      'Amdahl is improving email 3 of 3.',
      'Run: run-3',
      'Kept your fill-in fields: {{company}}, {{first_name}}.',
      'Sent them? amdahl sent <run id> --provider <provider> --channel <channel> --sent-as returned --provider-send-id <id>',
      `To save them as a CSV: amdahl sequence ${path} --csv`,
      '',
    ])
    expect(bodies()[2]?.context).toEqual({
      prior_touches: [
        { on: DAY, channel: 'email', summary: TOUCH_1 },
        { on: DAY, channel: 'email', summary: 'Hi {{first_name}}, bumping this up. Worth a quick call?' },
      ],
    })
  })

  it('a reply keeps no subject, even when Amdahl writes one', async () => {
    const io = await withKey({ optimizeAnswer: answers({ 1: (plain) => ({ ...plain, message: `Subject: Re: bump\n\n${String(plain.message)}` }) }) })
    const r = await cli(io, 'sequence', write(io, 'emails.md', SEQ), '--json')
    expect(r.json.emails[1]).toMatchObject({ index: 2, subject: null, message: TOUCH_2 })
    expect(bodies()[2]?.context).toMatchObject({ prior_touches: [{ summary: TOUCH_1 }, { summary: TOUCH_2 }] })
  })

  it('a reply does not show the subject it dropped as a change', async () => {
    const changes = [
      { before: null, after: 'Subject: Re: bump', why: 'Added a subject.' },
      { before: 'Hi {{first_name}}, bumping this up.', after: 'Hi {{first_name}}, one more reason to talk.', why: 'A new reason, not a bump.' },
    ]
    const io = await withKey({ optimizeAnswer: answers({ 1: (plain) => ({ ...plain, message: `Subject: Re: bump\n\n${String(plain.message)}`, changes }) }) })
    const r = await cli(io, 'sequence', write(io, 'emails.md', SEQ))
    expect(r.stderr).not.toContain('Subject: Re: bump')
    expect(r.stderr).toContain('  + "Hi {{first_name}}, one more reason to talk."\n    Why: A new reason, not a bump.')
  })

  it('a touch is cut to 500 characters, and an <unverified> marker is not kept', async () => {
    const long = `${'word '.repeat(150)}end`
    const io = await withKey({ optimizeAnswer: answers({ 0: { ok: true, message: `Subject: Hi\n\n<unverified>${long}</unverified>`, run_id: 'run-1' } }) })
    const r = await cli(io, 'sequence', write(io, 'emails.md', SEQ), '--json')
    expect(r.json.emails[0].message).toBe(long)
    const summary = (bodies()[1]?.context as { prior_touches: { summary: string }[] }).prior_touches[0]?.summary ?? ''
    expect(summary).toBe(`Subject: Hi\n\n${long}`.slice(0, 500).trim())
    expect(summary).not.toContain('unverified')
  })

  it('--json prints one document: the emails, the run ids, the fields', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequence', write(io, 'emails.md', SEQ), '--json')
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
    expect(r.json).toEqual({
      ok: true,
      mode: 'improve',
      emails: [
        { index: 1, subject: 'Ramping SDRs at {{company}}!', message: 'Better: Hi {{first_name}}, most teams take 4 months to ramp a new rep.', run_id: 'run-1', result: expect.objectContaining({ ok: true, run_id: 'run-1' }) },
        { index: 2, subject: null, message: TOUCH_2, run_id: 'run-2', result: expect.objectContaining({ run_id: 'run-2' }) },
        { index: 3, subject: 'Close the loop?!', message: 'Better: Hi {{first_name}}, should I stop reaching out?', run_id: 'run-3', result: expect.objectContaining({ run_id: 'run-3' }) },
      ],
      fields: { kept: ['{{company}}', '{{first_name}}'], lost: [] },
    })
  })

  it('names the email that lost a fill-in field', async () => {
    const io = await withKey({ optimizeAnswer: answers({ 1: { ok: true, message: 'Hi there, bumping this up.', run_id: 'run-2' }, 2: (plain) => ({ ...plain, message: 'Subject: Close the loop?\n\nHi, should I stop?' }) }) })
    const r = await cli(io, 'sequence', write(io, 'emails.md', SEQ))
    expect(r.stderr).toBe(`Run: run-1\nRun: run-2\nRun: run-3\nEmail 2 lost {{first_name}}. Add it back before you send.\nEmail 3 lost {{first_name}}. Add it back before you send.\nSent them? amdahl sent <run id> --provider <provider> --channel <channel> --sent-as returned --provider-send-id <id>\n`)
    const again = await withKey({ optimizeAnswer: answers({ 1: { ok: true, message: 'Hi there, bumping this up.', run_id: 'run-2' }, 2: (plain) => ({ ...plain, message: 'Subject: Close the loop?\n\nHi, should I stop?' }) }) })
    const j = await cli(again, 'sequence', write(again, 'emails2.md', SEQ), '--json')
    expect(j.json.fields).toEqual({ kept: ['{{company}}'], lost: [{ email: 2, fields: ['{{first_name}}'] }, { email: 3, fields: ['{{first_name}}'] }] })
  })

  it('an email that needs input keeps the typed text, which the next email then carries', async () => {
    const io = await withKey({ optimizeAnswer: answers({ 1: { ok: true, outcome: 'needs_input', ask: [{ asks: 'What is the price?' }], run_id: 'run-2' } }) })
    const r = await cli(io, 'sequence', write(io, 'emails.md', SEQ))
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('Email 2 of 3\nHi {{first_name}}, bumping this up. Worth a quick call?\n')
    expect(r.stderr).toBe(`Run: run-1\nEmail 2 needs your input: What is the price? Kept your draft.\nRun: run-2\nRun: run-3\nKept your fill-in fields: {{company}}, {{first_name}}.\nSent them? amdahl sent <run id> --provider <provider> --channel <channel> --sent-as returned --provider-send-id <id>\n`)
    expect((bodies()[2]?.context as { prior_touches: { summary: string }[] }).prior_touches[1]?.summary).toBe('Hi {{first_name}}, bumping this up. Worth a quick call?')
  })

  it('a failed email stops the run: the ones before it are printed, the rest are not sent', async () => {
    const five = Array.from({ length: 5 }, (_, k) => `Email ${k + 1} text.`).join('\n---\n')
    const io = await withKey({ optimizeAnswer: answers({ 2: { ok: false, reason: 'optimizer_error', detail: 'The optimizer is down' } }) })
    const r = await cli(io, 'sequence', write(io, 'five.md', five))
    expect(r.code).toBe(1)
    expect(r.stdout).toBe('Email 1 of 5\nBetter: Email 1 text.\n\nEmail 2 of 5\nBetter: Email 2 text.\n')
    expect(r.stderr).toBe(`Run: run-1\nRun: run-2\nEmail 3 was not improved: The optimizer is down. Emails 4 and 5 were not run.\nSent them? amdahl sent <run id> --provider <provider> --channel <channel> --sent-as returned --provider-send-id <id>\n`)
    expect(bodies()).toHaveLength(3)
    const again = await withKey({ optimizeAnswer: answers({ 2: { ok: false, reason: 'optimizer_error', detail: 'The optimizer is down' } }) })
    const j = await cli(again, 'sequence', write(again, 'five2.md', five), '--json')
    expect(j.code).toBe(1)
    expect(j.json).toMatchObject({ ok: false, mode: 'improve', failed: { index: 3, reason: 'optimizer_error', detail: 'The optimizer is down' }, fields: { kept: [], lost: [] } })
    expect(j.json.emails.map((e: { index: number }) => e.index)).toEqual([1, 2])
  })

  it('an error from the server (not a result) stops the run the same way', async () => {
    const io = await withKey({ optimizeAnswer: answers({ 1: { ok: false, reason: 'timeout', detail: 'No answer' } }) })
    const r = await cli(io, 'sequence', write(io, 'two.md', 'First.\n---\nSecond.'))
    expect(r.code).toBe(1)
    expect(r.stderr).toBe(`Run: run-1\nEmail 2 was not improved: No answer.\nSent them? amdahl sent <run id> --provider <provider> --channel <channel> --sent-as returned --provider-send-id <id>\n`)
  })

  it('sends the options and the --context facts with every email, and adds the touches itself', async () => {
    const io = await withKey()
    const ctxFile = write(io, 'context.json', JSON.stringify({ facts: ['We cut ramp time in half.'], rules: ['No exclamation marks.'], voice_examples: ['Hey, quick one.'] }))
    const r = await cli(io, 'sequence', write(io, 'emails.md', SEQ), '--evidence', 'off', '--on-unsupported', 'remove', '--context', ctxFile)
    expect(r.code).toBe(0)
    const own = { facts: ['We cut ramp time in half.'], rules: ['No exclamation marks.'], voice_examples: ['Hey, quick one.'] }
    expect(bodies().map((b) => ({ channel: b.channel, evidence: b.evidence, on_unsupported: b.on_unsupported, context: b.context }))).toEqual([
      { channel: 'email', evidence: 'off', on_unsupported: 'remove', context: own },
      { channel: 'email', evidence: 'off', on_unsupported: 'remove', context: { ...own, prior_touches: [{ on: DAY, channel: 'email', summary: TOUCH_1 }] } },
      { channel: 'email', evidence: 'off', on_unsupported: 'remove', context: { ...own, prior_touches: [{ on: DAY, channel: 'email', summary: TOUCH_1 }, { on: DAY, channel: 'email', summary: TOUCH_2 }] } },
    ])
  })

  it('refuses --channel, and a --context file that has prior_touches, before sending anything', async () => {
    const io = await withKey()
    const path = write(io, 'emails.md', SEQ)
    const a = await cli(io, 'sequence', path, '--channel', 'linkedin')
    expect([a.code, a.stderr]).toEqual([2, 'Error: --channel does not go with sequence: a sequence is email only.\n'])
    const ctx = write(io, 'c.json', JSON.stringify({ facts: ['x'], prior_touches: [] }))
    const b = await cli(io, 'sequence', path, '--context', ctx)
    expect([b.code, b.stderr]).toEqual([2, 'Error: --context cannot have prior_touches: Amdahl sends the emails before each one itself.\n'])
    expect(server?.log.filter((l) => l.path === OPTIMIZE)).toEqual([])
  })

  it('reads a CSV with one column for each email, and runs the first row', async () => {
    const io = await withKey()
    const csv = 'name,step_1_subject,step_1_body,step_2_body,step_3_subject,step_3_body\nDana,Hello {{company}},"Hi {{first_name}},\nfirst.",Second reply.,New angle,Third.\nJo,Other,Other body,Other 2,x,y\n'
    const r = await cli(io, 'sequence', write(io, 'steps.csv', csv))
    expect(r.code).toBe(0)
    expect(bodies().map((b) => b.message)).toEqual(['Subject: Hello {{company}}\n\nHi {{first_name}},\nfirst.', 'Second reply.', 'Subject: New angle\n\nThird.'])
  })

  it('reads stdin with -', async () => {
    const io = await withKey()
    io.stdinText = 'Email 1\nFirst one.\n\nEmail 2\nSecond one.\n'
    const r = await cli(io, 'sequence', '-')
    expect(r.code).toBe(0)
    expect(bodies().map((b) => b.message)).toEqual(['First one.', 'Second one.'])
  })
})

describe('what is refused before anything is sent', () => {
  async function refused(files: Record<string, string>, expected: string, ...args: string[]) {
    const io = await withKey()
    const [name, text] = Object.entries(files)[0] as [string, string]
    const r = await cli(io, 'sequence', write(io, name, text), ...args)
    expect([r.code, r.stdout, r.stderr]).toEqual([2, '', `Error: ${expected}\n`])
    expect(server?.log.filter((l) => l.path === OPTIMIZE)).toEqual([])
  }

  it('fewer than 2 emails', () => refused({ 'one.md': 'Just one email.' }, 'Found 1 email. Put a line of --- between emails.\nFor one email: amdahl optimize <file>'))
  it('more than 10 emails', () => refused({ 'many.md': Array.from({ length: 12 }, (_, k) => `Email number ${k + 1}.`).join('\n---\n') }, 'Amdahl improves up to 10 emails. This file has 12.'))
  it('an empty email, named', () => refused({ 'gap.csv': 'step_1_body,step_2_body,step_3_body\nFirst,,Third\n' }, 'Email 2 is empty.'))
  it('an email over 10,000 characters, named', () => refused({ 'long.md': `Short.\n---\n${'x'.repeat(10_001)}` }, 'Email 2 is over 10,000 characters.'))
  it('a CSV with no step columns', () => refused({ 'leads.csv': 'name,company\nDana,Acme\n' }, 'No email columns in this file. Name one column for each email, like step_1_body and step_2_body.'))
  it('an empty file', async () => {
    const io = await withKey()
    const path = write(io, 'blank.md', '  \n')
    const r = await cli(io, 'sequence', path)
    expect([r.code, r.stderr]).toEqual([2, `Error: ${path} is empty.\n`])
  })
})

describe('--csv', () => {
  const FIELDS = '\uFEFFEmail,Subject,Message\r\n'

  it('saves Email, Subject and Message next to the file, with CRLF, quotes, a guard for a formula and no marker', async () => {
    const io = await withKey({ optimizeAnswer: answers({ 0: { ok: true, message: 'Subject: =Hi, there\n\nLine <unverified>one</unverified>,\n"two"', run_id: 'run-1' }, 1: { ok: true, message: '-5 is a reply', run_id: 'run-2' } }) })
    const path = write(io, 'q4.md', 'First.\n---\nSecond.')
    const r = await cli(io, 'sequence', path, '--csv')
    const file = join(io.cwd, 'q4-amdahl.csv')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(`\nSaved: ${file}\n`)
    expect(readFileSync(file, 'utf8')).toBe(`${FIELDS}1,"'=Hi, there","Line one,\n""two"""\r\n2,,'-5 is a reply`)
  })

  it('--csv <path> names the file; stdin saves sequence-amdahl.csv here', async () => {
    const io = await withKey()
    const target = join(io.cwd, 'out', 'mine.csv')
    const a = await cli(io, 'sequence', write(io, 'q4.md', 'First.\n---\nSecond.'), '--csv', join(io.cwd, 'mine.csv'))
    expect(a.stdout).toContain(`Saved: ${join(io.cwd, 'mine.csv')}\n`)
    expect(existsSync(target)).toBe(false)
    io.stdinText = 'First.\n---\nSecond.'
    const b = await cli(io, 'sequence', '-', '--csv')
    expect(b.stdout).toContain(`Saved: ${join(io.cwd, 'sequence-amdahl.csv')}\n`)
    expect(readFileSync(join(io.cwd, 'sequence-amdahl.csv'), 'utf8')).toBe(`${FIELDS}1,,Better: First.\r\n2,,Better: Second.`)
  })

  it('does not replace a file that is there without --force, and says so before it sends anything', async () => {
    const io = await withKey()
    const path = write(io, 'q4.md', 'First.\n---\nSecond.')
    const existing = write(io, 'q4-amdahl.csv', 'mine')
    const r = await cli(io, 'sequence', path, '--csv')
    expect([r.code, r.stderr]).toEqual([2, `Error: ${existing} already exists.\nMove it, or add --force to replace it.\n`])
    expect(server?.log.filter((l) => l.path === OPTIMIZE)).toEqual([])
    expect(readFileSync(existing, 'utf8')).toBe('mine')
    const forced = await cli(io, 'sequence', path, '--csv', '--force')
    expect(forced.code).toBe(0)
    expect(readFileSync(existing, 'utf8')).toBe(`${FIELDS}1,,Better: First.\r\n2,,Better: Second.`)
  })

  it('--force alone is refused; --json names the file; a run that failed on its first email saves nothing', async () => {
    const io = await withKey({ optimizeAnswer: answers({ 0: { ok: false, reason: 'optimizer_error', detail: 'Down' } }) })
    const path = write(io, 'q4.md', 'First.\n---\nSecond.')
    expect((await cli(io, 'sequence', path, '--force')).stderr).toBe('Error: --force goes with --csv.\n')
    const failed = await cli(io, 'sequence', path, '--csv')
    expect(failed.code).toBe(1)
    expect(existsSync(join(io.cwd, 'q4-amdahl.csv'))).toBe(false)
    const ok = await withKey()
    const j = await cli(ok, 'sequence', write(ok, 'q5.md', 'First.\n---\nSecond.'), '--csv', '--json')
    expect(j.json.file).toBe(join(ok.cwd, 'q5-amdahl.csv'))
    expect(j.stderr).toBe('')
  })
})

const busy = (details: Record<string, unknown> = {}, headers?: Record<string, string>) => ({ status: 429, body: { error: { code: 'rate_limited', message: 'Too many requests.', details } }, ...(headers ? { headers } : {}) })

/** A fake clock for io.sleep: the waits it was asked for, in ms. */
function sleeps(io: FakeIo): number[] {
  const waits: number[] = []
  io.sleep = async (ms: number) => {
    waits.push(ms)
  }
  return waits
}

describe('a run that stops partway with --csv', () => {
  const FIELDS = '\uFEFFEmail,Subject,Message\r\n'
  const THREE = 'First.\n---\nSecond.\n---\nThird.'

  it('saves the emails that came back and says so on stderr', async () => {
    const io = await withKey({ optimizeRefusal: (i) => (i >= 2 ? busy({ retry_after_seconds: 1 }) : undefined) })
    const path = write(io, 'q4.md', THREE)
    const r = await cli(io, 'sequence', path, '--csv')
    const file = join(io.cwd, 'q4-amdahl.csv')
    expect(r.code).toBe(6)
    expect(r.stderr).toContain(`Saved emails 1 to 2 only: ${file}\n`)
    expect(readFileSync(file, 'utf8')).toBe(`${FIELDS}1,,Better: First.\r\n2,,Better: Second.`)
  })

  it('says "email 1 only" for one, and "Nothing was saved" for none', async () => {
    const one = await withKey({ optimizeRefusal: (i) => (i >= 1 ? busy() : undefined) })
    const r = await cli(one, 'sequence', write(one, 'q4.md', THREE), '--csv')
    expect(r.stderr).toContain(`Saved email 1 only: ${join(one.cwd, 'q4-amdahl.csv')}\n`)
    expect(readFileSync(join(one.cwd, 'q4-amdahl.csv'), 'utf8')).toBe(`${FIELDS}1,,Better: First.`)
    const none = await withKey({ optimizeAnswer: answers({ 0: { ok: false, reason: 'optimizer_error', detail: 'Down' } }) })
    const n = await cli(none, 'sequence', write(none, 'q4.md', THREE), '--csv')
    expect(n.code).toBe(1)
    expect(n.stderr).toContain(`Nothing was saved to ${join(none.cwd, 'q4-amdahl.csv')}.\n`)
    expect(existsSync(join(none.cwd, 'q4-amdahl.csv'))).toBe(false)
  })

  it('--json sets file and saved only when a file was written', async () => {
    const part = await withKey({ optimizeRefusal: (i) => (i >= 2 ? busy() : undefined) })
    const a = await cli(part, 'sequence', write(part, 'q4.md', THREE), '--csv', '--json')
    expect([a.json.ok, a.json.file, a.json.saved]).toEqual([false, join(part.cwd, 'q4-amdahl.csv'), 2])
    const none = await withKey({ optimizeAnswer: answers({ 0: { ok: false, reason: 'optimizer_error', detail: 'Down' } }) })
    const b = await cli(none, 'sequence', write(none, 'q4.md', THREE), '--csv', '--json')
    expect('file' in b.json || 'saved' in b.json).toBe(false)
    const ok = await withKey()
    const c = await cli(ok, 'sequence', write(ok, 'q4.md', THREE), '--csv', '--json')
    expect(c.json.saved).toBe(3)
  })

  it('still refuses a file that is there before it sends anything', async () => {
    const io = await withKey()
    write(io, 'q4-amdahl.csv', 'mine')
    const r = await cli(io, 'sequence', write(io, 'q4.md', THREE), '--csv')
    expect(r.code).toBe(2)
    expect(server?.log.filter((l) => l.path === OPTIMIZE)).toEqual([])
  })
})

describe('a rate limited email is tried once more', () => {
  it('waits the server\'s retry_after_seconds, says so at a terminal, then goes on', async () => {
    const io = await withKey({ optimizeRefusal: (i) => (i === 1 ? busy({ retry_after_seconds: 20 }) : undefined) })
    io.stderrIsTTY = true
    const waits = sleeps(io)
    const r = await cli(io, 'sequence', write(io, 'q4.md', 'First.\n---\nSecond.'))
    expect(r.code).toBe(0)
    expect(waits).toEqual([20000])
    expect(r.stderr).toContain('Amdahl is busy. Trying email 2 again in 20 seconds.\n')
    expect(bodies().map((b) => b.message)).toEqual(['First.', 'Second.', 'Second.'])
    expect(r.stdout).toContain('Email 2 of 2\nBetter: Second.')
  })

  it('reads the Retry-After header, caps the wait at 60 seconds, and waits 10 with no number; prints nothing off a terminal', async () => {
    for (const [refusal, wait] of [[busy({}, { 'Retry-After': '7' }), 7000], [busy({ retry_after_seconds: 500 }), 60000], [busy(), 10000]] as const) {
      const io = await withKey({ optimizeRefusal: (i) => (i === 0 ? refusal : undefined) })
      const waits = sleeps(io)
      const r = await cli(io, 'sequence', write(io, 'q4.md', 'First.\n---\nSecond.'))
      expect([r.code, waits, r.stderr.includes('Amdahl is busy')]).toEqual([0, [wait], false])
    }
  })

  it('a second refusal stops the run, and only rate_limited is retried', async () => {
    const io = await withKey({ optimizeRefusal: (i) => (i >= 1 ? busy({ retry_after_seconds: 3 }) : undefined) })
    const waits = sleeps(io)
    const r = await cli(io, 'sequence', write(io, 'q4.md', 'First.\n---\nSecond.'))
    expect([r.code, waits, bodies().length]).toEqual([6, [3000], 3])
    expect(r.stderr).toContain('Email 2 was not improved: Too many requests.')
    const down = await withKey({ optimizeRefusal: (i) => (i === 0 ? { status: 500, body: { error: { code: 'server_error', message: 'Down' } } } : undefined) })
    const more = sleeps(down)
    const d = await cli(down, 'sequence', write(down, 'q4.md', 'First.\n---\nSecond.'))
    expect([d.code, more, bodies().length]).toEqual([8, [], 1])
  })
})

describe('--csv never points at an input', () => {
  it('refuses the input, the plan and the context file, before anything is sent', async () => {
    const io = await withKey()
    const drafts = write(io, 'drafts.csv', 'step_1_body,step_2_body\nFirst,Second\n')
    const plan = write(io, 'plan.csv', 'A\nB\n')
    const context = write(io, 'ctx.csv', '{}')
    for (const args of [
      ['sequence', 'drafts.csv', '--csv', 'drafts.csv', '--force'],
      ['sequence', drafts, '--csv', join(io.cwd, '.', 'drafts.csv'), '--force'],
      ['sequence', '--write', 'A goal.', '--plan', plan, '--csv', plan, '--force'],
      ['sequence', drafts, '--context', context, '--csv', context, '--force'],
    ]) {
      const r = await cli(io, ...args)
      const named = args[args.indexOf('--csv') + 1] === context ? context : args[args.indexOf('--csv') + 1] === plan ? plan : args[1]
      expect([r.code, r.stderr]).toEqual([2, `Error: --csv would replace your input file ${named === args[1] ? args[1] : named}. Name another file, or leave the name out.\n`])
    }
    expect(server?.log.filter((l) => l.path === OPTIMIZE)).toEqual([])
    expect(readFileSync(drafts, 'utf8')).toBe('step_1_body,step_2_body\nFirst,Second\n')
  })

  it('refuses --csv <file.csv> with no input and no --write, with the usage', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequence', '--csv', 'drafts.csv')
    expect([r.code, r.stderr]).toEqual([2, 'Error: --csv drafts.csv says where to save, but there are no emails to improve.\nUsage: amdahl sequence <file> | -   or   amdahl sequence --write "<goal>"\n'])
    expect(server?.log.filter((l) => l.path === OPTIMIZE)).toEqual([])
  })
})

describe('every touch in one run carries the same day', () => {
  it('the run\'s own clock, not the moment each touch is built', async () => {
    const io = await withKey()
    io.now = () => new Date(2026, 10, 20, 12).getTime()
    await cli(io, 'sequence', write(io, 'q4.md', SEQ))
    const days = bodies().flatMap((b) => ((b.context as { prior_touches?: { on: string }[] } | undefined)?.prior_touches ?? []).map((t) => t.on))
    expect(days).toEqual(['2026-11-20', '2026-11-20', '2026-11-20'])
  })
})

describe('writing a sequence', () => {
  it('sends no message: the goal and the plan are the rules, and each email carries the ones written before it', async () => {
    const io = await withKey()
    const goal = 'Follow up with everyone who came to our dinner.'
    const r = await cli(io, 'sequence', '--write', goal, '--emails', '3')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(
      [
        'Email 1 of 3: Thanks',
        'Subject: Thanks for {{company}}',
        '',
        'Written email 1 after 0 earlier.',
        '',
        'Email 2 of 3: Follow-up',
        'Written email 2 after 1 earlier.',
        '',
        'Email 3 of 3: Last try',
        'Written email 3 after 2 earlier.',
        '',
      ].join('\n')
    )
    expect(r.stderr).toBe('Run: run-1\nRun: run-2\nRun: run-3\nSent them? amdahl sent <run id> --provider <provider> --channel <channel> --sent-as returned --provider-send-id <id>\n')
    const rules = (k: number) => [
      `This sequence: ${goal}`,
      `This is email ${k} of 3: ${['Thanks', 'Follow-up', 'Last try'][k - 1]}. Its job: ${['thank them and pick up where you left off', 'a new reason to reply, not a bump', 'close politely and leave a way back in'][k - 1]}.`,
      FIRST_NAME,
      ...(k > 1 ? [`Email ${k} replies in the same thread as email 1, so it has no subject line.`, NO_DATE] : []),
    ]
    const touch = (k: number) => ({ on: DAY, channel: 'email', summary: `${k === 1 ? 'Subject: Thanks for {{company}}\n\n' : ''}Written email ${k} after ${k - 1} earlier.` })
    expect(bodies()).toEqual([
      { message: '', channel: 'email', context: { rules: rules(1) } },
      { message: '', channel: 'email', context: { rules: rules(2), prior_touches: [touch(1)] } },
      { message: '', channel: 'email', context: { rules: rules(3), prior_touches: [touch(1), touch(2)] } },
    ])
  })

  it('the count is 3 as in the console, and the goal picks the first email', async () => {
    const io = await withKey()
    await cli(io, 'sequence', '--write', 'Restart the conversation with deals we lost.')
    expect((bodies().map((b) => (b.context as { rules: string[] }).rules[1]?.split('.')[0]))).toEqual(['This is email 1 of 3: What changed', 'This is email 2 of 3: Follow-up', 'This is email 3 of 3: Last try'])
    const j = await cli(io, 'sequence', '--write', 'Book a meeting.', '--emails', '6', '--json')
    expect(j.json.mode).toBe('write')
    expect(j.json.fields).toEqual({ kept: [], lost: [] })
    expect(j.json.emails).toHaveLength(6)
  })

  it('--plan names the emails and sets the count; --context rules come after the plan rules', async () => {
    const io = await withKey()
    const plan = write(io, 'plan.txt', 'Hello: Say hi\n\nProof: One result from a team like theirs\nBye\n')
    const ctx = write(io, 'c.json', JSON.stringify({ rules: ['No emojis.'], facts: ['We are Acme.'] }))
    const r = await cli(io, 'sequence', '--write', 'Book a meeting.', '--plan', plan, '--context', ctx)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('Email 3 of 3: Bye\n')
    expect(bodies()[1]?.context).toEqual({
      facts: ['We are Acme.'],
      rules: ['This sequence: Book a meeting.', 'This is email 2 of 3: Proof. Its job: one result from a team like theirs.', FIRST_NAME, 'Email 2 replies in the same thread as email 1, so it has no subject line.', NO_DATE, 'No emojis.'],
      prior_touches: [{ on: DAY, channel: 'email', summary: expect.stringContaining('Hello for') }],
    })
  })

  it('refuses a goal over 300 characters, a bad count, a plan of the wrong size, and too many rules, before sending', async () => {
    const io = await withKey()
    const one = write(io, 'one.txt', 'Only one\n')
    const two = write(io, 'two.txt', 'A\nB\n')
    const rules = write(io, 'r.json', JSON.stringify({ rules: Array.from({ length: 19 }, (_, k) => `Rule ${k}`) }))
    const said = async (...args: string[]) => {
      const r = await cli(io, 'sequence', ...args)
      return [r.code, r.stderr.split('\n')[0]]
    }
    expect(await said('--write', 'x'.repeat(301))).toEqual([2, 'Error: The goal is 301 characters. Amdahl takes up to 300.'])
    expect(await said('--write', '  ')).toEqual([2, 'Error: Say what the sequence is for.'])
    expect(await said('--write', 'Goal', '--emails', '7')).toEqual([2, 'Error: --emails must be a whole number from 2 to 6.'])
    expect(await said('--write', 'Goal', '--plan', one)).toEqual([2, `Error: ${one} has 1 line. A plan is 2 to 6 emails, one on each line.`])
    expect(await said('--write', 'Goal', '--plan', two, '--emails', '4')).toEqual([2, `Error: --emails 4 does not match the 2 emails in ${two}.`])
    expect(await said('--write', 'Goal', '--context', rules)).toEqual([2, "Error: --context has 19 rules. With the plan's 5, Amdahl takes at most 20 for an email. Remove 4."])
    expect(await said('--emails', '3')).toEqual([2, 'Error: --emails and --plan go with --write "<goal>".'])
    expect(await said(write(io, 'e.md', SEQ), '--write', 'Goal')).toEqual([2, 'Error: Give the emails to improve, or --write "<goal>", not both.'])
    expect(server?.log.filter((l) => l.path === OPTIMIZE)).toEqual([])
  })

  it('at a terminal: shows the plan and asks; Enter writes it', async () => {
    const io = await withKey()
    io.stdinIsTTY = true
    io.stdoutIsTTY = true
    io.answers = ['', 'n']
    const r = await cli(io, 'sequence', '--write', 'Follow up with everyone who came to our event.', '--emails', '4')
    expect(r.code).toBe(0)
    expect(r.stderr).toBe(
      [
        'The plan, 4 emails:',
        '  1. Thanks: Thank them and pick up where you left off',
        '  2. Follow-up: A new reason to reply, not a bump',
        '  3. Proof: One result from a team like theirs',
        '  4. Last try: Close politely and leave a way back in',
        '',
      ].join('\n') + 'Run: run-1\nRun: run-2\nRun: run-3\nRun: run-4\nSent them? amdahl sent <run id>\nTo save them as a CSV: run the same command with --csv.\n'
    )
    expect(io.prompts).toEqual(['Write these 4 emails? [Y/n]', `Save as ${join(io.cwd, 'sequence-amdahl.csv')}? [Y/n]`])
    expect(bodies()).toHaveLength(4)
  })

  it('at a terminal, No sends nothing and says how to change the plan', async () => {
    const io = await withKey()
    io.stdinIsTTY = true
    io.stdoutIsTTY = true
    io.answers = ['n']
    const r = await cli(io, 'sequence', '--write', 'Book a meeting.')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr.split('\n').slice(-2)).toEqual(['Nothing was written. To change the plan, put one email per line in a file (Name: job) and run: amdahl sequence --write "<goal>" --plan plan.txt', ''])
    expect(bodies()).toEqual([])
  })

  it('an agent, a pipe or --json is not asked', async () => {
    const io = await withKey()
    io.stdinIsTTY = true
    io.stdoutIsTTY = true
    io.env.CLAUDECODE = '1'
    io.answers = ['n']
    expect((await cli(io, 'sequence', '--write', 'Book a meeting.')).code).toBe(0)
    expect(io.prompts).toEqual([])
    expect(bodies()).toHaveLength(3)
  })
})

describe('with no file at a terminal', () => {
  const choice = 'What do you want to do? [Improve emails I have | Write a new sequence with Amdahl]'

  it('asks for a paste of the emails, then improves them', async () => {
    const io = await withKey()
    io.stdinIsTTY = true
    io.answers = ['', 'First one.\n---\nSecond one.']
    const r = await cli(io, 'sequence')
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([choice, 'Paste your emails, with a line of --- between them, then press Enter on an empty line:'])
    expect(r.stdout).toBe('Email 1 of 2\nBetter: First one.\n\nEmail 2 of 2\nBetter: Second one.\n')
    expect(r.stderr).toBe('Run: run-1\nRun: run-2\nSent them? amdahl sent <run id> --provider <provider> --channel <channel> --sent-as returned --provider-send-id <id>\nTo save them as a CSV: amdahl sequence <file> --csv\n')
  })

  it('nothing pasted sends nothing', async () => {
    const io = await withKey()
    io.stdinIsTTY = true
    io.answers = ['1', '']
    const r = await cli(io, 'sequence')
    expect([r.code, r.stderr]).toEqual([0, 'Nothing pasted, so nothing was sent.\n'])
    expect(bodies()).toEqual([])
  })

  it('writing: a starter or your own goal, the count, then the plan question', async () => {
    const io = await withKey()
    io.stdinIsTTY = true
    io.answers = ['2', '2', '', '']
    const r = await cli(io, 'sequence')
    expect(r.code).toBe(0)
    expect(io.prompts[1]).toBe(
      'What is the sequence for? [Cold outbound: New prospects, first touch | Event follow-up: Attendees and booth visitors | Inbound follow-up: Demo requests and form fills | Trial follow-up: Free trial users not paying yet | No-reply follow-up: Opened, never answered | Closed-lost: Reopen deals you lost | Champion job change: A past buyer at a new company | Customer expansion: Upsell existing accounts | Type my own goal]'
    )
    expect(io.prompts.slice(2)).toEqual(['How many emails, 2 to 6? Enter for 3:', 'Write these 3 emails? [Y/n]'])
    expect((bodies()[0]?.context as { rules: string[] }).rules[0]).toBe('This sequence: Follow up with everyone who came to our event and book a meeting to keep the conversation going.')
    expect(r.stderr.split('\n')[0]).toBe('The plan, 3 emails:')
    const own = await withKey()
    own.stdinIsTTY = true
    own.answers = ['2', '9', 'Win back churned trials.', '2', 'n']
    const o = await cli(own, 'sequence')
    expect(o.stderr.split('\n').slice(0, 3)).toEqual(['The plan, 2 emails:', '  1. What changed: Say what is new since you last spoke', '  2. Last try: Close politely and leave a way back in'])
  })

  it('an agent, CI, a pipe, --json or AMDAHL_NO_PROMPT=1 gets the usage and nothing is asked', async () => {
    for (const [env, args, stdin] of [[{ CLAUDECODE: '1' }, [], true], [{ CI: 'true' }, [], true], [{ AMDAHL_NO_PROMPT: '1' }, [], true], [{}, ['--json'], true], [{}, [], false]] as const) {
      const io = await withKey()
      Object.assign(io.env, env)
      io.stdinIsTTY = stdin
      const r = await cli(io, 'sequence', ...args)
      const said = 'Give a file of emails, or a goal to write them from.'
      const hint = 'Usage: amdahl sequence <file> | -   or   amdahl sequence --write "<goal>"'
      expect(r.code).toBe(2)
      if (args.length) expect(r.json).toEqual({ ok: false, error: { code: 'usage', message: said, hint } })
      else expect(r.stderr).toBe(`Error: ${said}\n${hint}\n`)
      expect(io.prompts).toEqual([])
    }
  })
})

describe('what is kept', () => {
  it('a run remembers its ids only: no email text reaches the disk unless --csv', async () => {
    const io = await withKey()
    const path = write(io, 'q4.md', 'Secret first.\n---\nSecret second.')
    await cli(io, 'sequence', path)
    expect((await cli(io, 'runs')).stdout).toMatch(/run-1[\s\S]*run-2|run-2[\s\S]*run-1/)
    const files: string[] = []
    const walk = (dir: string) => readdirSync(dir).forEach((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : files.push(join(dir, n))))
    walk(io.homedir)
    const saved = files.filter((f) => f !== path)
    expect(saved.length).toBeGreaterThan(0)
    for (const f of saved) expect(readFileSync(f, 'utf8')).not.toMatch(/Secret|Better/)
  })

  it('sequence --help says what it does and the file format', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequence', '--help')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('each is written as a follow-up to the improved emails before')
    expect(r.stdout).toContain('Fill-in fields such as {{first_name}} are sent as they are.')
    expect(r.stdout).toContain('https://github.com/amdahlco/amdahl-cookbook, in prompts/agent-platform/\nimprove-a-sequence.md and write-a-sequence.md.')
    expect(r.stdout.split('\n').filter((l) => [...l].length > 80)).toEqual([])
    expect((await cli(io, '--help')).stdout).toContain('amdahl sequence emails.md')
  })
})

describe('the mock server refuses what the real one refuses', () => {
  async function post(body: Answer) {
    server = await startMockServer()
    const res = await fetch(`${server.url}${OPTIMIZE}`, { method: 'POST', headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, errors: ((await res.json()) as { error?: { details?: { errors?: string[] } } }).error?.details?.errors ?? [] }
  }
  const touch = { on: DAY, channel: 'email', summary: 'Sent it.' }

  it('prior_touches: at most 10, each {on, channel?, summary} and nothing else', async () => {
    expect((await post({ message: 'Hi', context: { prior_touches: [touch] } })).status).toBe(200)
    expect((await post({ message: 'Hi', context: { prior_touches: Array(11).fill(touch) } })).errors).toEqual(['$.context.prior_touches: Array must contain at most 10 element(s)'])
    expect((await post({ message: 'Hi', context: { prior_touches: [{ summary: 'x' }] } })).errors).toEqual(['$.context.prior_touches[0].on: must be a day, YYYY-MM-DD'])
    expect((await post({ message: 'Hi', context: { prior_touches: [{ ...touch, on: '18/11/2026' }] } })).errors).toEqual(['$.context.prior_touches[0].on: must be a day, YYYY-MM-DD'])
    expect((await post({ message: 'Hi', context: { prior_touches: [{ ...touch, channel: 'sms' }] } })).errors[0]).toContain('$.context.prior_touches[0].channel: Invalid enum value')
    expect((await post({ message: 'Hi', context: { prior_touches: [{ ...touch, summary: '   ' }] } })).errors).toEqual(['$.context.prior_touches[0].summary: String must contain at least 1 character(s)'])
    expect((await post({ message: 'Hi', context: { prior_touches: [{ ...touch, summary: 'x'.repeat(501) }] } })).errors).toEqual(['$.context.prior_touches[0].summary: String must contain at most 500 character(s)'])
    expect((await post({ message: 'Hi', context: { prior_touches: [{ ...touch, extra: 1 }] } })).errors).toEqual(["$.context.prior_touches[0]: Unrecognized key(s) in object: 'extra'"])
  })

  it('an empty message is accepted with something to write from, and refused with constraints alone', async () => {
    expect((await post({ message: '', context: { rules: ['Be short.'] } })).status).toBe(200)
    expect((await post({ message: '', context: { prior_touches: [touch] } })).status).toBe(200)
    expect((await post({ message: '', context: { max_words: 60 } })).status).toBe(400)
    expect((await post({ message: '' })).status).toBe(400)
  })
})
