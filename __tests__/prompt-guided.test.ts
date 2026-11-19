// The guided `amdahl prompt` (three questions at a terminal) and a CSV for
// --recipients, driven through the real CLI entry against the strict mock server.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { startMockServer, type MockServer } from './helpers/mock-server'

let server: MockServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

async function signedIn(): Promise<FakeIo> {
  server = await startMockServer()
  const io = fakeIo({ AMDAHL_API_URL: server.url })
  expect((await cli(io, 'login', '--json')).code).toBe(0)
  io.opened.length = 0
  io.stdoutIsTTY = true
  return io
}

const bodies = () => server!.log.filter((l) => l.path === '/api/platform/v1/messages/optimize_prompt' && l.method === 'POST').map((l) => JSON.parse(l.body))
const write = (io: FakeIo, name: string, text: string) => {
  const path = join(io.cwd, name)
  writeFileSync(path, text)
  return path
}
const PROMPT = 'Write a short email to book a call.\nUnder 80 words.'

const NEXT_TIME_TYPED = [
  'Next time, save the prompt as prompt.md and the companies as recipients.csv',
  '(columns company, name, notes), then run:',
  '  amdahl prompt prompt.md --recipients recipients.csv',
]

describe('bare amdahl prompt at a terminal', () => {
  it('asks three steps, sends what was answered, and says how to skip the questions next time', async () => {
    const io = await signedIn()
    io.answers.push('1', PROMPT, '2', 'Helix\nNorthwind | Sam Ito\nKiln | Ana Costa | Hiring 6 reps', '1')
    const r = await cli(io, 'prompt')
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([
      'Where does the prompt come from? [Paste my prompt | New signup: Book a call after signup | Pricing page visit: Catch them comparing | Funding or hiring: Open with the news | Champion moved: Reach them at the new job]',
      'Paste the prompt, then press Enter on an empty line (Ctrl+C to stop):',
      'Which companies should the emails be written for? [Let Amdahl pick up to 6 accounts from your workspace | Type the companies]',
      'Type up to 6 companies, one per line:\n  Company\n  Company | Name\n  Company | Name | what you know about them\nThen press Enter on an empty line:',
      'What should Amdahl do? [Improve it | Grade it]',
    ])
    expect(bodies()).toEqual([
      {
        prompt: PROMPT,
        mode: 'improve',
        recipients: [
          { recipient: { company: 'Helix' }, label: 'Helix' },
          { recipient: { company: 'Northwind', name: 'Sam Ito' }, label: 'Sam Ito, Northwind' },
          { recipient: { company: 'Kiln', name: 'Ana Costa' }, recipient_notes: 'Hiring 6 reps', label: 'Ana Costa, Kiln' },
        ],
      },
    ])
    expect(r.stderr).toContain('Step 1 of 3: your prompt\n')
    expect(r.stderr).toContain('Step 2 of 3: who to test it on\n')
    expect(r.stderr).toContain('Step 3 of 3: what to do with it\n')
    expect(r.stderr.trimEnd().split('\n').slice(-3)).toEqual(NEXT_TIME_TYPED)
  })

  it('a starter is sent as the console has it, and no recipients means Amdahl picks', async () => {
    const io = await signedIn()
    io.answers.push('3', '1', '2')
    const r = await cli(io, 'prompt')
    expect(r.code).toBe(0)
    const [body] = bodies()
    expect(body.prompt).toMatch(/^An agent runs this when a known account visits our pricing page twice in a week\./)
    expect(body.prompt).toContain('- One ask: a 20-minute call.\n- Under 80 words.')
    expect(body).not.toHaveProperty('recipients')
    expect(body.mode).toBe('grade')
    expect(r.stderr).toContain('Pricing page visit:\nAn agent runs this when')
    expect(r.stderr.trimEnd().split('\n').slice(-2)).toEqual(['Next time, save the prompt as prompt.md, then run:', '  amdahl prompt prompt.md --mode grade'])
  })

  it('an empty paste sends nothing and exits 0 with one line', async () => {
    const io = await signedIn()
    io.answers.push('1', '')
    const r = await cli(io, 'prompt')
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('Step 1 of 3: your prompt\nNothing pasted, so nothing was sent.\n')
    expect(bodies()).toEqual([])
  })

  it('Improve with one typed company offers Grade instead of letting the server refuse', async () => {
    const io = await signedIn()
    io.answers.push('1', PROMPT, '2', 'Helix', '1', '1')
    const r = await cli(io, 'prompt')
    expect(r.code).toBe(0)
    expect(io.prompts.at(-1)).toBe('What now? [Grade it instead | Stop, I will add another company]')
    expect(r.stderr).toContain('Improving needs 2 companies or more: Amdahl checks the revised prompt on a company it did not revise on.')
    expect(bodies()).toEqual([{ prompt: PROMPT, mode: 'grade', recipients: [{ recipient: { company: 'Helix' }, label: 'Helix' }] }])
  })

  it('stopping at that offer keeps the company; adding none asks what now again', async () => {
    const io = await signedIn()
    io.answers.push('1', PROMPT, '2', 'Helix', '1', '2', '', '1')
    const r = await cli(io, 'prompt', '--no-wait')
    expect(r.code).toBe(0)
    expect(io.prompts.filter((p) => p.startsWith('What now?'))).toHaveLength(2)
    expect(bodies()).toMatchObject([{ mode: 'grade', recipients: [{ recipient: { company: 'Helix' } }] }])
  })

  it('a company with a comma stays whole, a bar or a tab splits, and a long label is cut to the server cap', async () => {
    const io = await signedIn()
    const long = `${'Long company name '.repeat(14)}Inc`
    io.answers.push('1', PROMPT, '2', `Acme, Inc.\nKiln\tAna Costa\tHiring, fast\n${long} | Sam Ito`, '2')
    const r = await cli(io, 'prompt')
    expect(r.code).toBe(0)
    const recipients = bodies()[0].recipients as { recipient: Record<string, string>; recipient_notes?: string; label: string }[]
    expect(recipients[0]).toEqual({ recipient: { company: 'Acme, Inc.' }, label: 'Acme, Inc.' })
    expect(recipients[1]).toEqual({ recipient: { company: 'Kiln', name: 'Ana Costa' }, recipient_notes: 'Hiring, fast', label: 'Ana Costa, Kiln' })
    expect(recipients[2]?.label.length).toBeLessThanOrEqual(200)
  })

  it('more than 6 typed companies is asked again, with the limit named', async () => {
    const io = await signedIn()
    io.answers.push('1', PROMPT, '2', 'a\nb\nc\nd\ne\nf\ng', 'a\nb', '1')
    const r = await cli(io, 'prompt')
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('That is 7 companies. A run takes at most 6.')
    expect(bodies()[0].recipients).toHaveLength(2)
  })

  it.each<[string, Record<string, string>]>([
    ['Claude Code runs it', { CLAUDECODE: '1' }],
    ['CI is set', { CI: 'true' }],
    ['AMDAHL_NO_PROMPT=1', { AMDAHL_NO_PROMPT: '1' }],
  ])('asks nothing when %s: the usage, exit 2', async (_label, env) => {
    const io = await signedIn()
    Object.assign(io.env, env)
    const r = await cli(io, 'prompt')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Give a file with the prompt, or pipe the prompt on stdin.')
    expect(io.prompts).toEqual([])
    expect(bodies()).toEqual([])
  })

  it('--json asks nothing either', async () => {
    const io = await signedIn()
    const r = await cli(io, 'prompt', '--json')
    expect(r.code).toBe(2)
    expect(io.prompts).toEqual([])
  })
})

describe('--recipients with a CSV', () => {
  it('reads company, name and notes, in any order and the console\'s spellings', async () => {
    const io = await signedIn()
    const csv = write(io, 'people.csv', 'Notes,Company Name,Name\n"Hiring, fast",Helix,Maya Okafor\n,Northwind,\n')
    const r = await cli(io, 'prompt', write(io, 'p.md', PROMPT), '--recipients', csv, '--no-wait')
    expect(r.code).toBe(0)
    expect(bodies()).toEqual([
      {
        prompt: PROMPT,
        recipients: [
          { recipient: { company: 'Helix', name: 'Maya Okafor' }, recipient_notes: 'Hiring, fast', label: 'Maya Okafor, Helix' },
          { recipient: { company: 'Northwind' }, label: 'Northwind' },
        ],
      },
    ])
  })

  it('a CSV with no company column is refused before anything is sent, naming the column', async () => {
    const io = await signedIn()
    const csv = write(io, 'people.csv', 'name,notes\nMaya,hi\n')
    const r = await cli(io, 'prompt', write(io, 'p.md', PROMPT), '--recipients', csv)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain(`--recipients ${csv} needs a "company" column.`)
    expect(bodies()).toEqual([])
  })

  it('keeps the JSON limits: 7 rows are refused off a terminal, and Improve needs 2', async () => {
    const io = await signedIn()
    io.env.AMDAHL_NO_PROMPT = '1'
    const seven = write(io, 'seven.csv', `company\n${'a,b,c,d,e,f,g'.split(',').join('\n')}\n`)
    const big = await cli(io, 'prompt', write(io, 'p.md', PROMPT), '--recipients', seven)
    expect(big.code).toBe(2)
    expect(big.stderr).toContain('--recipients needs 1 to 6 recipients, not 7.')
    const one = write(io, 'one.csv', 'company\nHelix\n')
    const few = await cli(io, 'prompt', write(io, 'p.md', PROMPT), '--recipients', one)
    expect(few.code).toBe(2)
    expect(few.stderr).toContain('Improving a prompt needs at least 2 recipients')
    expect(bodies()).toEqual([])
  })
})
