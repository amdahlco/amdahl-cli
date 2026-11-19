// `amdahl sequence --leads`: a whole sequence for each person in a lead list, through the real entry
// point against the strict mock server. The mock builds each batch item's result from THAT item's own
// body, so a test can tell whether a person's email 2 carried their own email 1 (never another person's).
// The request bodies and the CSV text follow the console's own tests (amdahl-frontend,
// e2e-stub/optimizer-sequence-people.spec.ts, optimizer-sequence-write-people.spec.ts and
// optimizer-sequence-send-to.spec.ts at commit d9a53a2b9).

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { API_KEY, BODY_LIMIT, startMockServer, type MockServer } from './helpers/mock-server'

// No real row makes one item pass the limit (an item is cut to fit, see lead-facts.ts), so one test
// swells a single person's item to prove the guard: the real code builds it, then it is padded.
const oversize: { row: string | null } = { row: null }
vi.mock('../src/sequence-leads', async (original) => {
  const real = await original<typeof import('../src/sequence-leads')>()
  return {
    ...real,
    personItem: (...args: Parameters<typeof real.personItem>) => {
      const item = real.personItem(...args)
      return item.item_id === oversize.row ? { ...item, message: 'x'.repeat(950_000) } : item
    },
  }
})

let server: MockServer | null = null
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 18, 12))
})
afterEach(async () => {
  oversize.row = null
  vi.useRealTimers()
  await server?.close()
  server = null
})

const BATCH = '/api/platform/v1/messages/optimize/batch'
const DAY = '2026-11-18'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RULE = "Write the message from the sender's message in the facts. Keep its substance, order and voice, and improve the wording."

type Item = Record<string, any>
type Result = { status: string; result: Record<string, unknown> }

const LEADS = ['First Name,Last Name,Email,Company,Notes', 'Sam,Lee,sam@example.com,Acme,Posted about onboarding', ',Park,jo@example.com,Northwind,Raised a Series B'].join('\n')
const EMAILS = ['Subject: Ramping at {{company}}', '', 'Hi {{first_name}}, most teams take 4 months.', '---', 'Hi {{first_name}}, bumping this up.'].join('\n')

/** The touches an item carries, as their first lines (the subject says whose email it is). */
const touchLines = (item: Item): string[] => ((item.context?.prior_touches ?? []) as { summary: string }[]).map((t) => t.summary.split('\n')[0] as string)

/** What a rewrite or a written email looks like, made from the item's own body: an improved email is `Better: <its message>`, a written one names the person and the first line of the touch it carried. */
function answer(item: Item): Result {
  const message = String(item.message ?? '')
  if (message) return { status: 'done', result: { ok: true, message: message.startsWith('Subject: ') ? message.replace('\n\n', '!\n\nBetter: ') : `Better: ${message}`, run_id: 'r' } }
  const place = /email (\d+) of (\d+): ([^.]*)\./.exec((item.context?.rules as string[] | undefined)?.[1] ?? '')
  const who = item.recipient?.name ?? 'someone'
  const after = touchLines(item)[0]
  return { status: 'done', result: { ok: true, message: `Subject: ${place?.[3]} ${place?.[1]} for ${who}\n\nWritten for ${who}${after ? ` after: ${after}` : ''}.`, run_id: 'r' } }
}

/** `answer`, except the people named fail at the email given (1 is the first), with this reason. */
const failing = (emails: string[], at: number, reason = 'optimizer_timeout') => (item: Item): Result => {
  const k = touchLines(item).length + 1
  if (emails.includes(item.recipient?.email) && k === at) return { status: 'failed', result: { ok: false, reason, detail: 'It failed.' } }
  return answer(item)
}

async function withKey(options: Parameters<typeof startMockServer>[0] = {}): Promise<FakeIo> {
  await server?.close()
  server = await startMockServer({ batchPolls: 0, batchResults: (item) => answer(item as Item), ...options })
  const io = fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_KEY: API_KEY })
  io.stdinIsTTY = false
  return io
}

/** The same, at a terminal: stdin, stdout and stderr are terminals, so questions are asked. */
async function atTerminal(options: Parameters<typeof startMockServer>[0] = {}): Promise<FakeIo> {
  const io = await withKey(options)
  io.stdinIsTTY = true
  io.stdoutIsTTY = true
  io.stderrIsTTY = true
  return io
}

const file = (io: FakeIo, name: string, text: string) => {
  const path = join(io.cwd, name)
  writeFileSync(path, text)
  return path
}
const read = (io: FakeIo, name: string) => readFileSync(join(io.cwd, name), 'utf8')

/** Every batch the CLI queued, in order, with the key it sent split off (each is a different UUID). */
const batches = (): Item[][] => {
  const keys: string[] = []
  const all = (server?.log ?? []).filter((r) => r.path === BATCH).map((r) => {
    const body = JSON.parse(r.body) as { items: Item[]; idempotency_key: string }
    keys.push(body.idempotency_key)
    expect(Object.keys(body).sort()).toEqual(['idempotency_key', 'items'])
    return body.items
  })
  expect(keys.every((k) => UUID.test(k))).toBe(true)
  expect(new Set(keys).size).toBe(keys.length)
  return all
}
const polls = () => (server?.log ?? []).filter((r) => r.path.startsWith(`${BATCH}es/`) && r.method === 'GET')

const touch = (summary: string) => ({ on: DAY, channel: 'email', summary })
const SAM = { email: 'sam@example.com', name: 'Sam Lee', company: 'Acme', attributes: { Notes: 'Posted about onboarding' } }
const PARK = { email: 'jo@example.com', name: 'Park', company: 'Northwind', attributes: { Notes: 'Raised a Series B' } }

describe('improving a sequence for each person', () => {
  it('sends email 2 as one batch, and each person carries their OWN email 1', async () => {
    const io = await withKey()
    const leads = file(io, 'leads.csv', LEADS)
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', leads)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`Results: ${join(io.cwd, 'leads-amdahl-sequence.csv')}\n`)
    expect(r.stderr).toBe('Email 1 of 2: 2 of 2 people done.\nEmail 2 of 2: 2 of 2 people done.\nWrote 2 emails for 2 of 2 people.\n')
    const [one, two] = batches()
    expect(one).toEqual([
      {
        item_id: 'row-2',
        channel: 'email',
        recipient: SAM,
        context: { rules: [RULE], facts: ['Recipient: Sam Lee at Acme', 'Notes: Posted about onboarding', "The sender's message, word for word:\nSubject: Ramping at Acme\n\nHi Sam, most teams take 4 months."] },
        message: 'Subject: Ramping at Acme\n\nHi Sam, most teams take 4 months.',
      },
      {
        item_id: 'row-3',
        channel: 'email',
        recipient: PARK,
        context: { rules: [RULE], facts: ['Recipient: Park at Northwind', 'Notes: Raised a Series B', "The sender's message, word for word:\nSubject: Ramping at Northwind\n\nHi there, most teams take 4 months."] },
        message: 'Subject: Ramping at Northwind\n\nHi there, most teams take 4 months.',
      },
    ])
    expect(two).toEqual([
      {
        item_id: 'row-2',
        channel: 'email',
        recipient: SAM,
        context: {
          rules: [RULE],
          facts: ['Recipient: Sam Lee at Acme', 'Notes: Posted about onboarding', "The sender's message, word for word:\nHi Sam, bumping this up."],
          prior_touches: [touch('Subject: Ramping at Acme!\n\nBetter: Hi Sam, most teams take 4 months.')],
        },
        message: 'Hi Sam, bumping this up.',
      },
      {
        item_id: 'row-3',
        channel: 'email',
        recipient: PARK,
        context: {
          rules: [RULE],
          facts: ['Recipient: Park at Northwind', 'Notes: Raised a Series B', "The sender's message, word for word:\nHi there, bumping this up."],
          prior_touches: [touch('Subject: Ramping at Northwind!\n\nBetter: Hi there, most teams take 4 months.')],
        },
        message: 'Hi there, bumping this up.',
      },
    ])
    expect(read(io, 'leads-amdahl-sequence.csv')).toBe(
      [
        'First Name,Last Name,Email,Company,Notes,amdahl_subject,amdahl_message,amdahl_message_2,amdahl_status',
        'Sam,Lee,sam@example.com,Acme,Posted about onboarding,Ramping at Acme!,"Better: Hi Sam, most teams take 4 months.","Better: Hi Sam, bumping this up.",written',
        ',Park,jo@example.com,Northwind,Raised a Series B,Ramping at Northwind!,"Better: Hi there, most teams take 4 months.","Better: Hi there, bumping this up.",written',
      ].join('\r\n')
    )
  })

  it('reads each batch with only_finished, and keeps the cursor between reads', async () => {
    const io = await withKey({ batchFinishPerRead: 1 })
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).toBe(0)
    const paths = polls().map((p) => p.path + (p.query ?? ''))
    expect(paths.length).toBeGreaterThanOrEqual(4)
    expect(paths.every((p) => /only_finished=true&limit=100&wait_ms=15000/.test(p))).toBe(true)
    expect(paths.some((p) => p.includes('finished_since=f.1'))).toBe(true)
    expect(batches()).toHaveLength(2)
  })

  it('fills fields from the flags: --match, --fallback, --same and --drop', async () => {
    const io = await withKey()
    const leads = file(io, 'l.csv', 'Name,Email,Org,Notes\nSam,sam@example.com,Acme,Likes ramp\n,jo@example.com,,Hiring')
    const emails = file(io, 'e.md', 'Hi {{first_name}} at {{company}}, {{icebreaker}} Open to a call?\n---\nHi {{first_name}}, bumping this.')
    const r = await cli(io, 'sequence', emails, '--leads', leads, '--match', 'company=Org', '--fallback', 'company=your team', '--fallback', 'first_name=friend', '--drop', 'icebreaker')
    expect(r.code).toBe(0)
    const [one] = batches()
    expect(one?.map((i) => i.message)).toEqual(['Hi Sam at Acme,  Open to a call?', 'Hi friend at your team,  Open to a call?'])
    const same = await cli(io, 'sequence', emails, '--leads', leads, '--force', '--same', 'company=Initech', '--match', 'icebreaker=Notes')
    expect(same.code).toBe(0)
    expect(batches().slice(2)[0]?.map((i) => i.message)).toEqual(['Hi Sam at Initech, Likes ramp Open to a call?', 'Hi there at Initech, Hiring Open to a call?'])
  })

  it('refuses a flag that names a field not in the emails, or a column not in the file, before anything is sent', async () => {
    const io = await withKey()
    const leads = file(io, 'leads.csv', LEADS)
    const emails = file(io, 'emails.md', EMAILS)
    const a = await cli(io, 'sequence', emails, '--leads', leads, '--match', 'city=Notes')
    expect(a.code).toBe(2)
    expect(a.stderr).toBe('Error: --match city: {{city}} is not in your emails.\nThe fields in your emails: {{company}}, {{first_name}}.\n')
    const b = await cli(io, 'sequence', emails, '--leads', leads, '--match', 'company=Org')
    expect(b.code).toBe(2)
    expect(b.stderr).toBe('Error: --match company: leads.csv has no column "Org".\nThe columns: First Name, Last Name, Email, Company, Notes.\n')
    const c = await cli(io, 'sequence', emails, '--leads', leads, '--same', 'company=Acme', '--drop', 'company')
    expect(c.stderr).toBe('Error: {{company}} has --same and --drop. Pick one.\n')
    const d = await cli(io, 'sequence', emails, '--leads', leads, '--match', 'company')
    expect(d.stderr).toBe('Error: --match takes <field>=<column>, like --match first_name="First Name".\n')
    expect(batches()).toEqual([])
    expect(existsSync(join(io.cwd, 'leads-amdahl-sequence.csv'))).toBe(false)
  })

  it('refuses, not at a terminal, a field with no column and no flag: one line for each, with the flag that fixes it', async () => {
    const io = await withKey()
    const emails = file(io, 'emails.md', 'Hi {{first_name}} at {{company}}, {{icebreaker}}\n---\nHi {{first_name}}, a follow-up.')
    const r = await cli(io, 'sequence', emails, '--leads', file(io, 'leads.csv', 'First Name,Email\nSam,sam@example.com'))
    expect(r.code).toBe(2)
    expect(r.stderr).toBe(
      'Error: {{company}} has no column in leads.csv. Add --match company=<column>, --same company="<text>" or --drop company.\n' +
        '{{icebreaker}} has no column in leads.csv. Add --match icebreaker=<column>, --same icebreaker="<text>" or --drop icebreaker.\n'
    )
    expect(batches()).toEqual([])
  })

  it('goes ahead with empty cells and no text for them, and says how many people have it empty', async () => {
    const io = await withKey()
    const emails = file(io, 'emails.md', 'Hi, a note for {{company}}.\n---\nBumping {{company}}.')
    const r = await cli(io, 'sequence', emails, '--leads', file(io, 'leads.csv', 'Email,Company\nsam@example.com,Acme\njo@example.com,'))
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('Email 1 of 2: 2 of 2 people done.\nEmail 2 of 2: 2 of 2 people done.\nWrote 2 emails for 2 of 2 people.\n'.replace(/^/, '{{company}} is empty for 1 of 2 people, so it is left out for them.\n'))
    expect(batches()[0]?.map((i) => i.message)).toEqual(['Hi, a note for Acme.', 'Hi, a note for.'])
  })

  it('refuses a file with no people before anything is sent, with the console\'s sentence', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'drafts.csv', 'Subject,Body\nHi,Some text here'))
    expect(r.code).toBe(2)
    expect(r.stderr).toBe('Error: No people in this file. It needs an email, LinkedIn, or name and company column.\n')
    expect(batches()).toEqual([])
  })

  it('skips empty rows and says how many', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequence', file(io, 'emails.md', 'Hi there.\n---\nBumping.'), '--leads', file(io, 'leads.csv', 'Email,Name\nsam@example.com,Sam\n,\n,\njo@example.com,Jo'))
    expect(r.code).toBe(0)
    expect(r.stderr.startsWith('Skipped 2 empty rows.\n')).toBe(true)
    expect(batches()[0]?.map((i) => i.item_id)).toEqual(['row-2', 'row-5'])
  })
})

describe('the results file', () => {
  it('is not replaced without --force or --resume, and is refused before anything is sent', async () => {
    const io = await withKey()
    const out = join(io.cwd, 'leads-amdahl-sequence.csv')
    writeFileSync(out, 'old')
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).toBe(2)
    expect(r.stderr).toBe(`Error: ${out} already exists.\nAdd --resume to pick up where it stopped, or --force to start again.\n`)
    expect(batches()).toEqual([])
    expect(readFileSync(out, 'utf8')).toBe('old')
    const forced = await cli(io, 'sequence', join(io.cwd, 'emails.md'), '--leads', join(io.cwd, 'leads.csv'), '--force')
    expect(forced.code).toBe(0)
    expect(readFileSync(out, 'utf8')).toMatch(/^First Name,Last Name,Email,Company,Notes,amdahl_subject,/)
  })

  it('guards a formula cell, strips <unverified>, and keeps every original column', async () => {
    const io = await withKey({ batchResults: (item) => (String(item.message).startsWith('Hi') ? { status: 'done', result: { ok: true, message: '-Hi <unverified>Sam</unverified>, a note.' } } : answer(item as Item)) })
    const leads = file(io, 'leads.csv', 'Email,Name,Tag\nsam@example.com,Sam,=SUM(A1)')
    const r = await cli(io, 'sequence', file(io, 'emails.md', 'Hi, a note.\n---\nHi again.'), '--leads', leads)
    expect(r.code).toBe(0)
    expect(read(io, 'leads-amdahl-sequence.csv')).toBe(['Email,Name,Tag,amdahl_subject,amdahl_message,amdahl_message_2,amdahl_status', `sam@example.com,Sam,'=SUM(A1),,"'-Hi Sam, a note.","'-Hi Sam, a note.",written`].join('\r\n'))
  })
})

describe('a person who fails, and a run that stops', () => {
  it('stops that person there: later batches skip them, and the file and summary say where', async () => {
    const io = await withKey({ batchResults: failing(['jo@example.com'], 1) })
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).toBe(1)
    const [one, two] = batches()
    expect(one?.map((i) => i.item_id)).toEqual(['row-2', 'row-3'])
    expect(two?.map((i) => i.item_id)).toEqual(['row-2'])
    expect(r.stderr).toBe(
      'Email 1 of 2: 2 of 2 people done.\nEmail 2 of 2: 1 of 1 person done.\nWrote 2 emails for 1 of 2 people. 1 stopped: 1 at email 1 (took too long).\n' +
        `To write the rest: amdahl sequence ${join(io.cwd, 'emails.md')} --leads ${join(io.cwd, 'leads.csv')} --resume\n`
    )
    expect(read(io, 'leads-amdahl-sequence.csv').split('\r\n')[2]).toBe(',Park,jo@example.com,Northwind,Raised a Series B,,,,email 1 failed')
  })

  it('treats an item the batch never reported as failed', async () => {
    const io = await withKey({ batchResults: (item) => ((item as Item).recipient?.email === 'jo@example.com' ? { status: 'running', result: {} as Record<string, unknown> } : answer(item as Item)) })
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('1 stopped: 1 at email 1 (could not write this one).')
  })

  it('stops the whole run on a refused batch, keeps what finished, and still writes the results file', async () => {
    const io = await withKey({ batchRefuse: { 2: { status: 402, code: 'quota_exceeded', message: 'The monthly limit is reached.' } } })
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/^Email 1 of 2: 2 of 2 people done\.\nWrote 2 emails for 0 of 2 people\. Email 2 was refused: .*monthly limit/)
    const rows = read(io, 'leads-amdahl-sequence.csv').split('\r\n')
    expect(rows[1]).toBe('Sam,Lee,sam@example.com,Acme,Posted about onboarding,Ramping at Acme!,"Better: Hi Sam, most teams take 4 months.",,not written yet')
    expect(batches()).toHaveLength(2)
  })
})

describe('writing a sequence for each person', () => {
  const PLAN = ['Opener: Why now', 'Last try: Close politely'].join('\n')

  it('not at a terminal, writes everyone with no sample: no message, the plan rules, and each person\'s own email 1', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequence', '--write', 'Book a first meeting.', '--plan', file(io, 'plan.txt', PLAN), '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).toBe(0)
    const rules = (k: number) => [
      'This sequence: Book a first meeting.',
      k === 1 ? 'This is email 1 of 2: Opener. Its job: why now.' : 'This is email 2 of 2: Last try. Its job: close politely.',
      ...(k > 1 ? ['Email 2 replies in the same thread as email 1, so it has no subject line.', 'Do not name the date or day of an earlier email: the send dates are not set yet.'] : []),
    ]
    const [one, two] = batches()
    expect(one).toEqual([
      { item_id: 'row-2', channel: 'email', recipient: SAM, context: { rules: rules(1), facts: ['Recipient: Sam Lee at Acme', 'Notes: Posted about onboarding'] } },
      { item_id: 'row-3', channel: 'email', recipient: PARK, context: { rules: rules(1), facts: ['Recipient: Park at Northwind', 'Notes: Raised a Series B'] } },
    ])
    expect(two).toEqual([
      { item_id: 'row-2', channel: 'email', recipient: SAM, context: { rules: rules(2), facts: ['Recipient: Sam Lee at Acme', 'Notes: Posted about onboarding'], prior_touches: [touch('Subject: Opener 1 for Sam Lee\n\nWritten for Sam Lee.')] } },
      { item_id: 'row-3', channel: 'email', recipient: PARK, context: { rules: rules(2), facts: ['Recipient: Park at Northwind', 'Notes: Raised a Series B'], prior_touches: [touch('Subject: Opener 1 for Park\n\nWritten for Park.')] } },
    ])
    expect(read(io, 'leads-amdahl-sequence.csv').split('\r\n')[1]).toBe(
      'Sam,Lee,sam@example.com,Acme,Posted about onboarding,Opener 1 for Sam Lee,Written for Sam Lee.,Written for Sam Lee after: Subject: Opener 1 for Sam Lee.,written'
    )
  })

  it('at a terminal, writes a sample first as batches of one, shows it, and asks before writing for the rest', async () => {
    const io = await atTerminal()
    io.answers = ['', '', '']
    const r = await cli(io, 'sequence', '--write', 'Book a first meeting.', '--emails', '2', '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual(['Write these 2 emails? [Y/n]', 'Write 2 emails for the other person: up to 2 runs. Start? [Y/n]'])
    expect(batches().map((b) => b.map((i) => i.item_id))).toEqual([['row-2'], ['row-2'], ['row-3'], ['row-3']])
    expect(batches()[1]?.[0]?.context?.prior_touches).toEqual([touch('Subject: Opener 1 for Sam Lee\n\nWritten for Sam Lee.')])
    expect(batches()[3]?.[0]?.context?.prior_touches).toEqual([touch('Subject: Opener 1 for Park\n\nWritten for Park.')])
    expect(r.stdout).toBe(
      [
        `Results: ${join(io.cwd, 'leads-amdahl-sequence.csv')}`,
        'Sample for Sam Lee:',
        '',
        'Email 1 of 2: Opener',
        'Subject: Opener 1 for Sam Lee',
        '',
        'Written for Sam Lee.',
        '',
        'Email 2 of 2: Last try',
        'Written for Sam Lee after: Subject: Opener 1 for Sam Lee.',
        '',
      ].join('\n')
    )
  })

  it('stops after the sample when the answer is no: the sample stays in the file, the rest are marked not written', async () => {
    const io = await atTerminal()
    io.answers = ['', 'n']
    const leads = file(io, 'leads.csv', LEADS)
    const r = await cli(io, 'sequence', '--write', 'Book a first meeting.', '--emails', '2', '--leads', leads)
    expect(r.code).toBe(0)
    expect(batches()).toHaveLength(2)
    expect(r.stderr).toContain('Wrote 2 emails for 1 of 2 people. The other 1 were not written.')
    expect(r.stderr).toContain(`To write the rest: amdahl sequence --write 'Book a first meeting.' --leads ${leads} --emails 2 --resume`)
    const rows = read(io, 'leads-amdahl-sequence.csv').split('\r\n')
    expect(rows[1]?.endsWith(',written')).toBe(true)
    expect(rows[2]).toBe(',Park,jo@example.com,Northwind,Raised a Series B,,,,not written yet')
  })
})

describe('at a terminal', () => {
  const FIELDS = ['Subject: Call notes at {{company}}', '', 'Hi {{first_name}},', '', '{{icebreaker}}', '', 'We turn call recordings into talk tracks.', '---', 'Hi {{first_name}}, bumping this up.'].join('\n')

  it('asks about each real problem, then the start question, and rewrites a progress line as people finish', async () => {
    const io = await atTerminal({ batchFinishPerRead: 1 })
    io.answers = ['', '4', '']
    const leads = file(io, 'leads.csv', 'First Name,Email,Company,Notes\nSam,sam@example.com,Acme,Saw your post\n,jo@example.com,Fabrikam,Series B')
    const r = await cli(io, 'sequence', file(io, 'emails.md', FIELDS), '--leads', leads)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([
      'What fills {{first_name}}? [Write instead: there | Column: Email | Column: Company | Column: Notes | Same text for everyone | Leave it out]',
      'What fills {{icebreaker}}? [Column: First Name | Column: Email | Column: Company | Column: Notes | Same text for everyone | Leave it out]',
      'This improves 2 emails for each of 2 people: up to 4 runs. Start? [Y/n]',
    ])
    const line = (text: string) => `\r\u001b[2K${text}`
    expect(r.stderr).toBe(
      [
        '{{first_name}}: empty for 1 of 2 people',
        '{{icebreaker}}: no column in leads.csv',
        '{{company}}: from column "Company".',
        '{{first_name}}: from column "First Name", "there" where it is empty.',
        '{{icebreaker}}: from column "Notes".',
        line('Email 1 of 2: 0 of 2 people done.') + line('Email 1 of 2: 1 of 2 people done, about 4 min left.') + line('Email 1 of 2: 2 of 2 people done.'),
        line('Email 2 of 2: 0 of 2 people done.') + line('Email 2 of 2: 1 of 2 people done, about 4 min left.') + line('Email 2 of 2: 2 of 2 people done.'),
        'Wrote 2 emails for 2 of 2 people.',
        '',
      ].join('\n')
    )
    expect(batches()[0]?.[1]?.message).toBe('Subject: Call notes at Fabrikam\n\nHi there,\n\nSeries B\n\nWe turn call recordings into talk tracks.')
  })

  it('stops at the start question when the answer is no: nothing is sent and no file is written', async () => {
    const io = await atTerminal()
    io.answers = ['n']
    const r = await cli(io, 'sequence', file(io, 'emails.md', 'Hi.\n---\nBumping.'), '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual(['This improves 2 emails for each of 2 people: up to 4 runs. Start? [Y/n]'])
    expect(r.stderr).toBe('Nothing was sent.\n')
    expect(batches()).toEqual([])
    expect(existsSync(join(io.cwd, 'leads-amdahl-sequence.csv'))).toBe(false)
  })
})

describe('--for', () => {
  const THREE = ['Subject: Ramping at {{company}}', '', 'Hi {{first_name}}, most teams take 4 months.', '---', 'Hi {{first_name}}, bumping this up.', '---', 'Subject: Close the loop?', '', 'Hi {{first_name}}, should I stop?'].join('\n')

  it('writes the import file with each email\'s columns, a subject column only for an email with its own subject, and the steps for each email', async () => {
    const io = await withKey()
    const leads = file(io, 'leads.csv', LEADS)
    const r = await cli(io, 'sequence', file(io, 'emails.md', THREE), '--leads', leads, '--for', 'lemlist')
    expect(r.code).toBe(0)
    const results = join(io.cwd, 'leads-amdahl-sequence.csv')
    const imported = join(io.cwd, 'leads-lemlist.csv')
    expect(r.stdout).toBe(`Results: ${results}\nImport file for lemlist: ${imported}\n`)
    expect(read(io, 'leads-lemlist.csv')).toBe(
      [
        'email,firstName,lastName,companyName,amdahl_subject,amdahl_message,amdahl_message_2,amdahl_subject_3,amdahl_message_3,notes',
        'sam@example.com,Sam,Lee,Acme,Ramping at Acme!,"Better: Hi Sam, most teams take 4 months.","Better: Hi Sam, bumping this up.",Close the loop?!,"Better: Hi Sam, should I stop?",Posted about onboarding',
        'jo@example.com,Park,Park,Northwind,Ramping at Northwind!,"Better: Hi there, most teams take 4 months.","Better: Hi there, bumping this up.",Close the loop?!,"Better: Hi there, should I stop?",Raised a Series B',
      ].join('\r\n')
    )
    expect(r.stderr).toBe(
      [
        'Email 1 of 3: 2 of 2 people done.',
        'Email 2 of 3: 2 of 2 people done.',
        'Email 3 of 3: 2 of 2 people done.',
        'Wrote 3 emails for 2 of 2 people.',
        '2 people ready for lemlist.',
        '  1. Import: In your campaign, open Leads list > Import new leads > CSV.',
        '  2. email and the name columns map on their own. amdahl_subject and',
        "     amdahl_message become custom variables. Map amdahl_message_2 and each later",
        "     email's columns the same way.",
        '  3. Paste into your step, one email per step:',
        '     Email 1: Subject {{amdahl_subject}}, Body {{amdahl_message}}',
        '     Email 2: Body {{amdahl_message_2}}',
        '     Email 3: Subject {{amdahl_subject_3}}, Body {{amdahl_message_3}}',
        '',
      ].join('\n')
    )
  })

  it('does not name email 2\'s subject column in the mapping step: a written reply has no subject', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequence', '--write', 'Book a first meeting.', '--emails', '2', '--leads', file(io, 'leads.csv', LEADS), '--for', 'instantly')
    expect(r.code).toBe(0)
    expect(r.stderr.replace(/\n\s+/g, ' ')).toContain("Map amdahl_message_2 and each later email's columns the same way.")
  })

  it('leaves out a person who is missing an email, and counts them', async () => {
    const io = await withKey({ batchResults: failing(['jo@example.com'], 2) })
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS), '--for', 'instantly')
    expect(r.code).toBe(1)
    expect(read(io, 'leads-instantly.csv').split('\r\n')).toHaveLength(2)
    expect(r.stderr).toContain('1 person ready for Instantly. 1 left out: 1 failed.')
  })

  it('refuses a tool that takes LinkedIn only, a tool it does not know, and a list with no email column, before anything is sent', async () => {
    const io = await withKey()
    const emails = file(io, 'emails.md', EMAILS)
    const a = await cli(io, 'sequence', emails, '--leads', file(io, 'leads.csv', LEADS), '--for', 'heyreach')
    expect(a.code).toBe(2)
    expect(a.stderr).toBe('Error: HeyReach takes LinkedIn lists only, and this one is email.\nPick a tool for this channel, or use --for other.\n')
    const b = await cli(io, 'sequence', emails, '--leads', join(io.cwd, 'leads.csv'), '--for', 'mailchimp')
    expect(b.stderr).toContain('Error: --for must be one of: instantly, smartlead')
    const c = await cli(io, 'sequence', file(io, 'e2.md', 'Hi.\n---\nBump.'), '--leads', file(io, 'li.csv', 'LinkedIn,Name\nlinkedin.com/in/sam,Sam'), '--for', 'instantly')
    expect(c.stderr).toBe(`Error: ${join(io.cwd, 'li.csv')} has no email column.\nName the column email, email_address or work_email, so the tool can import it.\n`)
    expect(batches()).toEqual([])
  })

  it('refuses an existing import file without --force, before anything is sent', async () => {
    const io = await withKey()
    writeFileSync(join(io.cwd, 'leads-instantly.csv'), 'old')
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS), '--for', 'instantly')
    expect(r.code).toBe(2)
    expect(r.stderr).toBe(`Error: ${join(io.cwd, 'leads-instantly.csv')} already exists.\nMove it, or add --force to replace it.\n`)
    expect(batches()).toEqual([])
  })

  it('checks every email against the tool\'s limit for a variable', async () => {
    const io = await withKey({ batchResults: (item) => (touchLines(item as Item).length === 1 ? { status: 'done', result: { ok: true, message: 'x'.repeat(2001) } } : answer(item as Item)) })
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS), '--for', 'lemlist')
    expect(r.stderr).toContain("2 messages are over lemlist's 2,000 character limit for a variable.")
  })
})

describe('--json', () => {
  it('prints one document, with the results file it also wrote, and what was left out', async () => {
    const io = await withKey({ batchResults: failing(['jo@example.com'], 2) })
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS), '--json')
    expect(r.code).toBe(1)
    expect(r.stderr).toBe('')
    const out = join(io.cwd, 'leads-amdahl-sequence.csv')
    expect(r.json).toEqual({
      ok: false,
      mode: 'improve',
      people: 2,
      written: 1,
      file: out,
      left_out: { over_cap: 0, empty_rows: 0 },
      duplicates: 0,
      stopped: [{ row: 3, email: 'jo@example.com', at_email: 2, reason: 'took too long' }],
      rows: [
        { row: 2, emails: [{ subject: 'Ramping at Acme!', message: 'Better: Hi Sam, most teams take 4 months.' }, { subject: null, message: 'Better: Hi Sam, bumping this up.' }], status: 'written' },
        { row: 3, emails: [{ subject: 'Ramping at Northwind!', message: 'Better: Hi there, most teams take 4 months.' }, null], status: 'email 2 failed' },
      ],
    })
    expect(read(io, 'leads-amdahl-sequence.csv').split('\r\n')[2]).toBe(',Park,jo@example.com,Northwind,Raised a Series B,Ramping at Northwind!,"Better: Hi there, most teams take 4 months.",,email 2 failed')
  })

  it('adds send_to with --for, and a halted run says where it stopped', async () => {
    const io = await withKey({ batchRefuse: { 2: { status: 402, code: 'quota_exceeded', message: 'The monthly limit is reached.' } } })
    const r = await cli(io, 'sequence', '--write', 'Book a meeting.', '--emails', '2', '--leads', file(io, 'leads.csv', LEADS), '--for', 'smartlead', '--json')
    expect(r.code).not.toBe(0)
    expect(r.json.ok).toBe(false)
    expect(r.json.mode).toBe('write')
    expect(r.json.halted.at_email).toBe(2)
    expect(r.json.halted.reason).toMatch(/monthly limit/)
    expect(r.json.send_to).toEqual({ tool: 'smartlead', channel: 'email', file: null, ready: 0, left_out: { failed: 0, not_written: 2, needs_input: 0, no_contact: 0 }, over_limit: 0 })
  })
})

describe('--resume', () => {
  it('keeps the people who are written, and continues the rest from their first empty email with their own written emails as prior_touches', async () => {
    const io = await withKey({ batchResults: failing(['jo@example.com'], 2) })
    const leads = file(io, 'leads.csv', LEADS)
    const emails = file(io, 'emails.md', EMAILS)
    const first = await cli(io, 'sequence', emails, '--leads', leads)
    expect(first.code).toBe(1)
    expect(first.stderr).toContain(`To write the rest: amdahl sequence ${emails} --leads ${leads} --resume`)
    const before = read(io, 'leads-amdahl-sequence.csv').split('\r\n')
    expect(before[1]).toContain(',written')
    expect(before[2]).toBe(',Park,jo@example.com,Northwind,Raised a Series B,Ramping at Northwind!,"Better: Hi there, most teams take 4 months.",,email 2 failed')

    await server?.close()
    server = await startMockServer({ batchPolls: 0, batchResults: (item) => answer(item as Item) })
    io.env.AMDAHL_API_URL = server.url
    const again = await cli(io, 'sequence', emails, '--leads', leads, '--resume')
    expect(again.code).toBe(0)
    expect(batches()).toEqual([
      [
        {
          item_id: 'row-3',
          channel: 'email',
          recipient: PARK,
          context: {
            rules: [RULE],
            facts: ['Recipient: Park at Northwind', 'Notes: Raised a Series B', "The sender's message, word for word:\nHi there, bumping this up."],
            prior_touches: [touch('Subject: Ramping at Northwind!\n\nBetter: Hi there, most teams take 4 months.')],
          },
          message: 'Hi there, bumping this up.',
        },
      ],
    ])
    expect(again.stderr).toBe('Email 2 of 2: 1 of 1 person done.\nWrote 2 emails for 2 of 2 people.\n')
    const after = read(io, 'leads-amdahl-sequence.csv').split('\r\n')
    expect(after[1]).toBe(before[1])
    expect(after[2]).toBe(',Park,jo@example.com,Northwind,Raised a Series B,Ramping at Northwind!,"Better: Hi there, most teams take 4 months.","Better: Hi there, bumping this up.",written')
  })

  it('sends nothing for a list that is already written, and writes the same file', async () => {
    const io = await withKey()
    const args = ['sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS)]
    await cli(io, ...args)
    const text = read(io, 'leads-amdahl-sequence.csv')
    const sent = batches().length
    const r = await cli(io, ...args, '--resume')
    expect(r.code).toBe(0)
    expect(batches()).toHaveLength(sent)
    expect(r.stderr).toBe('Wrote 2 emails for 2 of 2 people.\n')
    expect(read(io, 'leads-amdahl-sequence.csv')).toBe(text)
  })

  it('picks up a written sequence after the sample: the sample person is kept, and only the rest are written', async () => {
    const io = await atTerminal()
    io.answers = ['', 'n']
    const leads = file(io, 'leads.csv', LEADS)
    const args = ['sequence', '--write', 'Book a first meeting.', '--emails', '2', '--leads', leads]
    await cli(io, ...args)
    expect(batches()).toHaveLength(2)
    io.answers = ['']
    const r = await cli(io, ...args, '--resume')
    expect(r.code).toBe(0)
    expect(io.prompts.slice(-1)).toEqual(['Write these 2 emails? [Y/n]'])
    expect(batches().slice(2).map((b) => b.map((i) => i.item_id))).toEqual([['row-3'], ['row-3']])
    expect(read(io, 'leads-amdahl-sequence.csv').split('\r\n').slice(1).map((l) => l.endsWith(',written'))).toEqual([true, true])
  })

  it('with --json updates the file, so a second resume sends nothing', async () => {
    const io = await withKey({ batchResults: failing(['jo@example.com'], 2) })
    const args = ['sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS)]
    await cli(io, ...args)
    const text = read(io, 'leads-amdahl-sequence.csv')
    await server?.close()
    server = await startMockServer({ batchPolls: 0, batchResults: (item) => answer(item as Item) })
    io.env.AMDAHL_API_URL = server.url
    const r = await cli(io, ...args, '--resume', '--json')
    expect(r.code).toBe(0)
    expect(r.json.written).toBe(2)
    expect(batches().map((b) => b.map((i) => i.item_id))).toEqual([['row-3']])
    expect(r.json.file).toBe(join(io.cwd, 'leads-amdahl-sequence.csv'))
    expect(read(io, 'leads-amdahl-sequence.csv')).not.toBe(text)
    expect(read(io, 'leads-amdahl-sequence.csv').split('\r\n').slice(1).map((l) => l.endsWith(',written'))).toEqual([true, true])
    const sent = batches().length
    const again = await cli(io, ...args, '--resume', '--json')
    expect(again.code).toBe(0)
    expect(batches()).toHaveLength(sent)
  })

  it('refuses a results file that is not this list\'s, and says why, before anything is sent', async () => {
    const io = await withKey()
    const leads = file(io, 'leads.csv', LEADS)
    const emails = file(io, 'emails.md', EMAILS)
    const out = join(io.cwd, 'leads-amdahl-sequence.csv')
    await cli(io, 'sequence', emails, '--leads', leads)
    const sent = batches().length
    const rows = read(io, 'leads-amdahl-sequence.csv').split('\r\n')
    writeFileSync(out, [rows[0], rows[1]].join('\r\n'))
    const a = await cli(io, 'sequence', emails, '--leads', leads, '--resume')
    expect(a.code).toBe(2)
    expect(a.stderr).toBe(`Error: ${out} has 1 people, and ${leads} has 2.\nRun it without --resume to write every email again; add --force to replace the file.\n`)
    writeFileSync(out, [rows[0], rows[2], rows[1]].join('\r\n'))
    const b = await cli(io, 'sequence', emails, '--leads', leads, '--resume')
    expect(b.stderr).toBe(`Error: Row 2 of ${out} is not row 2 of ${leads} (Sam Lee).\nRun it without --resume to write every email again; add --force to replace the file.\n`)
    writeFileSync(out, ['Email,Other', 'a,b'].join('\r\n'))
    const c = await cli(io, 'sequence', emails, '--leads', leads, '--resume')
    expect(c.stderr).toBe(`Error: ${out} does not fit this run: its columns are not ${leads}'s columns followed by 2 emails.\nRun it without --resume to write every email again; add --force to replace the file.\n`)
    expect(batches()).toHaveLength(sent)
  })

  it('refuses --resume when there is no results file, and with --force', async () => {
    const io = await withKey()
    const args = ['sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS)]
    const a = await cli(io, ...args, '--resume')
    expect(a.code).toBe(2)
    expect(a.stderr).toBe(`Error: ${join(io.cwd, 'leads-amdahl-sequence.csv')} does not exist, so there is nothing to pick up.\nRun the command without --resume to write the emails.\n`)
    const b = await cli(io, ...args, '--resume', '--force')
    expect(b.stderr).toBe('Error: --resume and --force do not go together: one picks up the results file, the other replaces it.\n')
    expect(batches()).toEqual([])
  })
})

describe('flags', () => {
  it('refuses the flags that need --leads without it, and the ones that do not go with it', async () => {
    const io = await withKey()
    const emails = file(io, 'emails.md', EMAILS)
    const leads = file(io, 'leads.csv', LEADS)
    const says = async (...args: string[]) => (await cli(io, 'sequence', ...args)).stderr
    expect(await says(emails, '--resume')).toBe('Error: --resume goes with --leads <list.csv>.\n')
    expect(await says(emails, '--for', 'instantly')).toBe('Error: --for goes with --leads <list.csv>.\n')
    expect(await says(emails, '--drop', 'company')).toBe('Error: --drop goes with --leads <list.csv>.\n')
    expect(await says(emails, '--leads', leads, '--csv')).toBe('Error: --csv does not go with --leads: the results are saved next to the list.\n')
    expect(await says(emails, '--leads', leads, '--context', 'ctx.json')).toBe("Error: --context does not go with --leads: each person's row is their context.\n")
    expect(await says('--leads', leads)).toBe('Error: Give a file of emails, or --write "<goal>", with --leads.\n')
    expect(await says('--write', 'A goal.', '--leads', leads, '--drop', 'x')).toBe('Error: --drop goes with emails you improve, not with --write: a written email has no fill-in fields.\n')
    expect(await says(emails, '--leads', join(io.cwd, 'nope.csv'))).toMatch(/nope\.csv/)
    expect(batches()).toEqual([])
  })

  it('leaves amdahl sequence without --leads as it was: --force still goes with --csv', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--force')
    expect(r.code).toBe(2)
    expect(r.stderr).toBe('Error: --force goes with --csv.\n')
  })
})

const posts = () => (server?.log ?? []).filter((r) => r.path === BATCH)
const TWO = 'Hi.\n---\nBump.'
const manyPeople = (people: number, note = 'x', extra: string[] = []) => ['Email,Name,Notes', ...Array.from({ length: people }, (_, i) => `p${i}@example.com,Person ${i},${note}`), ...extra].join('\n')

describe('a step too big for one request', () => {
  const NOTE = 'n'.repeat(1000)

  it('splits each step into requests under the limit, reads them all before the next step, and writes every person', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequence', file(io, 'emails.md', TWO), '--leads', file(io, 'leads.csv', manyPeople(500, NOTE)))
    expect(r.code).toBe(0)
    const sent = posts()
    expect(sent.length).toBeGreaterThanOrEqual(4)
    for (const p of sent) {
      expect(Buffer.byteLength(p.body)).toBeLessThan(BODY_LIMIT)
      expect(Buffer.byteLength(p.body)).toBeLessThanOrEqual(900_000)
      expect((JSON.parse(p.body) as { items: Item[] }).items.length).toBeLessThanOrEqual(500)
    }
    const stepOf = (body: string) => ((JSON.parse(body) as { items: Item[] }).items[0]?.context?.prior_touches ? 2 : 1)
    expect(sent.map((p) => stepOf(p.body))).toEqual([1, 1, 2, 2])
    const firstOfStepTwo = (server?.log ?? []).findIndex((x) => x.path === BATCH && stepOf(x.body) === 2)
    const readBefore = new Set((server?.log ?? []).slice(0, firstOfStepTwo).filter((x) => x.method === 'GET' && x.path.startsWith(`${BATCH}es/`)).map((x) => x.path))
    expect(readBefore.size).toBe(2)
    const ids = batches().flat().map((i) => i.item_id)
    expect(new Set(ids).size).toBe(500)
    const rows = read(io, 'leads-amdahl-sequence.csv').split('\r\n').slice(1)
    expect(rows).toHaveLength(500)
    expect(rows.every((l) => l.endsWith(',written'))).toBe(true)
    expect(r.stderr).toBe('Email 1 of 2: 500 of 500 people done.\nEmail 2 of 2: 500 of 500 people done.\nWrote 2 emails for 500 of 500 people.\n')
  })

  it('splits the same way on --resume', async () => {
    const io = await withKey({ batchRefuse: { 3: { status: 402, code: 'quota_exceeded', message: 'The monthly limit is reached.' } } })
    const args = ['sequence', file(io, 'emails.md', TWO), '--leads', file(io, 'leads.csv', manyPeople(500, NOTE))]
    const first = await cli(io, ...args)
    expect(first.code).not.toBe(0)
    expect(read(io, 'leads-amdahl-sequence.csv').split('\r\n').slice(1).every((l) => l.endsWith(',not written yet'))).toBe(true)
    await server?.close()
    server = await startMockServer({ batchPolls: 0, batchResults: (item) => answer(item as Item) })
    io.env.AMDAHL_API_URL = server.url
    const again = await cli(io, ...args, '--resume')
    expect(again.code).toBe(0)
    expect(posts()).toHaveLength(2)
    for (const p of posts()) expect(Buffer.byteLength(p.body)).toBeLessThanOrEqual(900_000)
    expect(read(io, 'leads-amdahl-sequence.csv').split('\r\n').slice(1).every((l) => l.endsWith(',written'))).toBe(true)
  })

  it('fails the one person whose item alone is over the limit, without sending it, and writes the others', async () => {
    const io = await withKey()
    oversize.row = 'row-3'
    const list = ['Email,Name,Notes', 'a@example.com,Ann,short', 'b@example.com,Bo,short', 'c@example.com,Cy,short'].join('\n')
    const r = await cli(io, 'sequence', file(io, 'emails.md', TWO), '--leads', file(io, 'leads.csv', list))
    expect(r.code).toBe(1)
    expect(batches().flat().map((i) => i.item_id)).toEqual(['row-2', 'row-4', 'row-2', 'row-4'])
    expect(posts().every((p) => Buffer.byteLength(p.body) < BODY_LIMIT)).toBe(true)
    expect(r.stderr).toContain('Wrote 2 emails for 2 of 3 people. 1 stopped: 1 at email 1 (its row and earlier emails are too large to send).')
    const rows = read(io, 'leads-amdahl-sequence.csv').split('\r\n')
    expect(rows[2]?.endsWith(',,,email 1 failed')).toBe(true)
  })
})

describe('a run that stops partway', () => {
  it('prints the results path before the first batch, and has the file with email 1 written when email 2 is refused', async () => {
    const io = await withKey()
    const seen: { stdout: string; file: string | null }[] = []
    await server?.close()
    server = await startMockServer({
      batchPolls: 0,
      batchResults: (item) => answer(item as Item),
      batchRefuse: { 2: { status: 402, code: 'quota_exceeded', message: 'The monthly limit is reached.' } },
      onBatch: () => seen.push({ stdout: io.out.join(''), file: existsSync(join(io.cwd, 'leads-amdahl-sequence.csv')) ? read(io, 'leads-amdahl-sequence.csv') : null }),
    })
    io.env.AMDAHL_API_URL = server.url
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).not.toBe(0)
    const out = join(io.cwd, 'leads-amdahl-sequence.csv')
    expect(seen).toHaveLength(2)
    expect(seen[0]?.stdout).toBe(`Results: ${out}\n`)
    expect(seen[0]?.file?.split('\r\n')[1]).toBe('Sam,Lee,sam@example.com,Acme,Posted about onboarding,,,,not written yet')
    expect(seen[1]?.file?.split('\r\n')[1]).toBe('Sam,Lee,sam@example.com,Acme,Posted about onboarding,Ramping at Acme!,"Better: Hi Sam, most teams take 4 months.",,not written yet')
    expect(r.stdout).toBe(`Results: ${out}\n`)
  })

  it('never leaves a temp file behind', async () => {
    const io = await withKey()
    await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS))
    expect(readdirSync(io.cwd).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('says in the help and the README that Ctrl+C does not stop a batch already sent, and that --resume picks up from the file', async () => {
    const io = await withKey()
    const help = (await cli(io, 'sequence', '--help')).stdout.replace(/\s+/g, ' ')
    expect(help).toContain('Ctrl+C stops this command, not a batch already sent')
    expect(help).toContain('--resume picks up from the results file')
    const readme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8').replace(/\s+/g, ' ')
    expect(readme).toContain('Ctrl+C stops the CLI, not a batch already sent')
  })
})

describe('a refused batch', () => {
  it('on quota_exceeded says how many runs are left and does not offer --resume', async () => {
    const io = await withKey({ batchRefuse: { 2: { status: 429, code: 'quota_exceeded', message: 'The monthly limit is reached.', details: { remaining: 3 } } } })
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('Email 2 was refused: The monthly limit is reached. 3 runs are left.')
    expect(r.stderr).not.toContain('--resume')
    expect(r.stderr).not.toContain('To write the rest')
  })

  it.each([
    ['retry_after_seconds in the body', { details: { retry_after_seconds: 12 } }, 12_000],
    ['the Retry-After header', { retryAfter: 7 }, 7_000],
    ['no number', {}, 10_000],
    ['a number past the cap', { details: { retry_after_seconds: 300 } }, 60_000],
  ])('on rate_limited with %s waits, then sends that batch once more', async (_label, extra, ms) => {
    const io = await withKey({ batchRefuse: { 1: { status: 429, code: 'rate_limited', message: 'Too many batches.', ...extra } } })
    const slept: number[] = []
    io.sleep = async (n: number) => void slept.push(n)
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).toBe(0)
    expect(slept).toEqual([ms])
    expect(posts()).toHaveLength(3)
    expect(r.stderr).toBe('Email 1 of 2: 2 of 2 people done.\nEmail 2 of 2: 2 of 2 people done.\nWrote 2 emails for 2 of 2 people.\n')
  })

  it('on a second rate_limited refusal halts as before', async () => {
    const refuse = { status: 429, code: 'rate_limited', message: 'Too many batches.', details: { retry_after_seconds: 5 } }
    const io = await withKey({ batchRefuse: { 1: refuse, 2: refuse } })
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).not.toBe(0)
    expect(posts()).toHaveLength(2)
    expect(r.stderr).toContain('Email 1 was refused: Too many batches.')
    expect(r.stderr).toContain('--resume')
  })

  it('resends a batch that got no answer with the SAME key, and the server replays the first', async () => {
    const io = await withKey({ batchDrop: [1] })
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).toBe(0)
    const keys = posts().map((p) => (JSON.parse(p.body) as { idempotency_key: string }).idempotency_key)
    expect(keys).toHaveLength(3)
    expect(keys[1]).toBe(keys[0])
    expect(keys[2]).not.toBe(keys[0])
    expect(read(io, 'leads-amdahl-sequence.csv').split('\r\n').slice(1).every((l) => l.endsWith(',written'))).toBe(true)
  })

  it('keeps the error\'s hint when three reads in a row are lost', async () => {
    const io = await withKey({ batchReadRefuse: { status: 401, code: 'unauthenticated', message: 'No.' } })
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('1 batch for email 1 could not be read: ')
    expect(r.stderr).toContain(' Amdahl may still be writing it: run again with --resume later.')
    expect(r.stderr).toContain('Run `amdahl login`, or check AMDAHL_KEY.')
  })
})

describe('a step whose part is lost', () => {
  const NOTE = 'n'.repeat(1000)

  it('still reads the step\'s other parts, saves after each part, and says how many batches could not be read', async () => {
    const io = await withKey({ batchReadRefuse: { status: 500, code: 'server_error', message: 'Down.' }, batchReadRefuseOnly: [1] })
    const r = await cli(io, 'sequence', file(io, 'emails.md', TWO), '--leads', file(io, 'leads.csv', manyPeople(500, NOTE)))
    expect(r.code).not.toBe(0)
    expect(posts()).toHaveLength(2)
    const reads = (server?.log ?? []).filter((x) => x.method === 'GET' && x.path.startsWith(`${BATCH}es/`)).map((x) => x.path.slice(-12))
    expect(new Set(reads)).toEqual(new Set(['000000000001', '000000000002']))
    expect(r.stderr).toContain('1 batch for email 1 could not be read: ')
    expect(r.stderr).toContain('Amdahl may still be writing it: run again with --resume later.')
    const rows = read(io, 'leads-amdahl-sequence.csv').split('\r\n').slice(1)
    const withEmail1 = rows.filter((l) => /Better|Written/.test(l))
    expect(withEmail1.length).toBeGreaterThan(0)
    expect(withEmail1.length).toBeLessThan(500)
    expect(rows.filter((l) => l.includes('email 1 failed'))).toEqual([])
  })
})

describe('what is said about the list', () => {
  it('puts what was left out in --json, and lists every key in --help', async () => {
    const io = await withKey()
    const list = manyPeople(500, 'x', ['p500@example.com,Over,x', 'p501@example.com,Over,x', ',,']).replace('p1@example.com', 'P0@example.com')
    const r = await cli(io, 'sequence', file(io, 'emails.md', TWO), '--leads', file(io, 'leads.csv', list), '--json')
    expect(r.code).toBe(0)
    expect(r.json.left_out).toEqual({ over_cap: 2, empty_rows: 1 })
    expect(r.json.duplicates).toBe(2)
    expect(r.json.file).toBe(join(io.cwd, 'leads-amdahl-sequence.csv'))
    const help = (await cli(io, 'sequence', '--help')).stdout.replace(/\s+/g, ' ')
    for (const key of ['.file', '.left_out', '.duplicates', '.halted', '.send_to']) expect(help).toContain(key)
  })

  it('counts rows that share an email before the start question, and still writes them', async () => {
    const io = await atTerminal()
    io.answers = ['']
    const list = ['Email,Name', 'sam@example.com,Sam', 'SAM@example.com ,Sam again', 'jo@example.com,Jo'].join('\n')
    const r = await cli(io, 'sequence', file(io, 'emails.md', TWO), '--leads', file(io, 'leads.csv', list))
    expect(r.code).toBe(0)
    expect(r.stderr.startsWith('2 rows share an email with another row.\n')).toBe(true)
    expect(batches()[0]).toHaveLength(3)
  })

  it('refuses a --for problem or an existing results file before asking about any field', async () => {
    const io = await atTerminal()
    const emails = file(io, 'emails.md', 'Hi {{first_name}} at {{company}}.\n---\nBump {{first_name}}.')
    const leads = file(io, 'leads.csv', 'Email,Name\nsam@example.com,Sam')
    const a = await cli(io, 'sequence', emails, '--leads', leads, '--for', 'heyreach')
    expect(a.code).toBe(2)
    expect(a.stderr).toContain('HeyReach takes LinkedIn lists only')
    writeFileSync(join(io.cwd, 'leads-amdahl-sequence.csv'), 'old')
    const b = await cli(io, 'sequence', emails, '--leads', leads)
    expect(b.code).toBe(2)
    expect(b.stderr).toContain('leads-amdahl-sequence.csv already exists.')
    const c = await cli(io, 'sequence', emails, '--leads', leads, '--for', 'instantly')
    expect(c.code).toBe(2)
    expect(io.prompts).toEqual([])
    expect(batches()).toEqual([])
  })

  it('keeps no run in the history file: 1,500 writes of it are not made', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequence', file(io, 'emails.md', EMAILS), '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).toBe(0)
    expect(existsSync(join(io.homedir, 'config', 'amdahl', 'runs.json'))).toBe(false)
  })
})

describe('progress', () => {
  it('at a terminal, shows the queue position and the estimate the server sent', async () => {
    const io = await atTerminal({ batchPolls: 2 })
    io.answers = ['']
    const r = await cli(io, 'sequence', file(io, 'emails.md', 'Hi.\n---\nBump.'), '--leads', file(io, 'leads.csv', LEADS))
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('Email 1 of 2: 0 of 2 people done, queued behind 3 items, about 5 min left.')
  })

  it('off a terminal, prints a line about once a minute while a step runs, not only at its end', async () => {
    const io = await withKey({ batchFinishPerRead: 1 })
    let t = 0
    io.now = () => (t += 30_000)
    const list = ['Email,Name', 'a@example.com,A', 'b@example.com,B', 'c@example.com,C', 'd@example.com,D'].join('\n')
    const r = await cli(io, 'sequence', file(io, 'emails.md', 'Hi.\n---\nBump.'), '--leads', file(io, 'leads.csv', list))
    expect(r.code).toBe(0)
    const lines = r.stderr.split('\n').filter((l) => l.startsWith('Email 1 of 2'))
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines.length).toBeLessThan(5)
    expect(lines.at(-1)).toBe('Email 1 of 2: 4 of 4 people done.')
  })
})
