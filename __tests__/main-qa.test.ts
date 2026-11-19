// Dom's UX QA of 0.6.0 (2026-11-19), the items that are in main: each is driven through the real CLI
// entry against the strict mock server, and each failed before its fix.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { changeLines } from '../src/changes'
import { outOfTimeLines } from '../src/commands/search'
import { EXIT } from '../src/errors'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { API_KEY, KNOWN_RUN, WHAT_CHANGED, startMockServer, type MockOptions, type MockServer } from './helpers/mock-server'

let server: MockServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

const AGENT_SCOPES = ['data:read', 'connections:read', 'messages:execute', 'conversations:write']
const PROMPT = 'Write a short email to book a call.\nUnder 80 words.'

async function signedIn(options: MockOptions = {}, env: Record<string, string> = {}): Promise<FakeIo> {
  server = await startMockServer(options)
  const io = fakeIo({ AMDAHL_API_URL: server.url, ...env })
  expect((await cli(io, 'login', '--json')).code).toBe(0)
  io.opened.length = 0
  io.stdoutIsTTY = true
  return io
}

async function withKey(options: MockOptions = {}, env: Record<string, string> = {}): Promise<FakeIo> {
  server = await startMockServer({ scopes: AGENT_SCOPES, ...options })
  return fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_KEY: API_KEY, ...env })
}

const write = (io: FakeIo, name: string, text: string) => {
  const path = join(io.cwd, name)
  writeFileSync(path, text)
  return path
}
const promptBodies = () => server!.log.filter((l) => l.path === '/api/platform/v1/messages/optimize_prompt' && l.method === 'POST').map((l) => JSON.parse(l.body))
const flat = (text: string) => text.replace(/\s+/g, ' ')

describe('S13: a timed-out optimize drops its request', () => {
  it('aborts the request when the timer fires, so the process can end', async () => {
    let closed = false
    const io = await withKey({ optimizeHang: { onClose: () => void (closed = true) } }, { AMDAHL_OPTIMIZE_TIMEOUT_MS: '150' })
    const r = await cli(io, 'optimize', write(io, 'd.txt', 'Hi Dana'))
    expect(r.code).toBe(EXIT.network)
    expect(r.stderr).toContain('timed out after')
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2000 })
  })
})

describe('S14: the key line goes only to a credential that cannot research', () => {
  const cut = { success: true, mode_ran: 'semantic', results: [], corpus: { empty_reason: 'read_failed' } }

  it('a Customer agent key is not told it needs one; a sign-in still is', async () => {
    const key = await withKey({ searchResult: cut })
    const r = await cli(key, 'search', 'open deals')
    expect(r.code).toBe(1)
    expect(flat(r.stderr)).toContain('Run the same command with --research: it can run longer.')
    expect(r.stderr).not.toContain('Customer agent key')
    await server!.close()
    const person = await signedIn({ searchResult: cut })
    expect(flat((await cli(person, 'search', 'open deals')).stderr)).toContain('Research needs a Customer agent key')
  })

  it('outOfTimeLines takes whether the credential can research', () => {
    expect(outOfTimeLines(2, false, '', true).join(' ')).not.toContain('Customer agent key')
    expect(outOfTimeLines(2).join(' ')).toContain('Customer agent key')
  })
})

describe('S16 and N14: the recipients file', () => {
  it('S16: Excel blank rows are skipped, not refused', async () => {
    const io = await signedIn()
    const csv = write(io, 'r.csv', 'company,name\nHelix,Ana\n,\n,,\nKiln,Bo\n,\n')
    const r = await cli(io, 'prompt', write(io, 'p.md', PROMPT), '--recipients', csv, '--no-wait')
    expect(r.code).toBe(0)
    expect(promptBodies()[0].recipients).toHaveLength(2)
  })

  it('N14: over 6 at a terminal uses the first 6 and says so; a script is still refused', async () => {
    const io = await signedIn()
    const csv = write(io, 'eight.csv', `company\n${'a,b,c,d,e,f,g,h'.split(',').join('\n')}\n`)
    const r = await cli(io, 'prompt', write(io, 'p.md', PROMPT), '--recipients', csv, '--no-wait')
    expect(r.code).toBe(0)
    expect(r.stderr).toContain('Using the first 6 of 8.')
    expect(promptBodies()[0].recipients.map((x: { recipient: { company: string } }) => x.recipient.company)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    io.env.AMDAHL_NO_PROMPT = '1'
    const script = await cli(io, 'prompt', write(io, 'p2.md', PROMPT), '--recipients', csv, '--no-wait')
    expect(script.code).toBe(2)
    expect(script.stderr).toContain('needs 1 to 6 recipients, not 8')
  })

  it('N14: email and domain columns go into the recipient', async () => {
    const io = await signedIn()
    const csv = write(io, 'e.csv', 'Company,Work Email,Company Domain\nHelix,ana@helix.io,helix.io\nKiln,,kiln.com\n')
    expect((await cli(io, 'prompt', write(io, 'p.md', PROMPT), '--recipients', csv, '--no-wait')).code).toBe(0)
    expect(promptBodies()[0].recipients.map((x: { recipient: unknown }) => x.recipient)).toEqual([
      { company: 'Helix', email: 'ana@helix.io', domain: 'helix.io' },
      { company: 'Kiln', domain: 'kiln.com' },
    ])
  })
})

describe('N9: the sign-in line names the command', () => {
  it('the guided prompt says paste your prompt, not your message', async () => {
    server = await startMockServer()
    const io = fakeIo({ AMDAHL_API_URL: server.url })
    io.stdoutIsTTY = true
    io.answers.push('1', '')
    const r = await cli(io, 'prompt')
    expect(r.stderr).toContain('Sign in first, then paste your prompt.')
    expect(r.stderr).not.toContain('paste your message')
  })
})

describe('the guided prompt', () => {
  it('N11: numbers only the steps it shows', async () => {
    const io = await signedIn()
    io.answers.push('1', PROMPT, '1')
    const r = await cli(io, 'prompt', '--mode', 'grade', '--no-wait')
    expect(r.stderr).toContain('Step 1 of 2: your prompt')
    expect(r.stderr).toContain('Step 2 of 2: who to test it on')
    expect(r.stderr).not.toContain('of 3')
    const csv = write(io, 'r.csv', 'company\nHelix\nKiln\n')
    io.answers.push('1', PROMPT, '1')
    const second = await cli(io, 'prompt', '--recipients', csv, '--no-wait')
    expect(second.stderr).toContain('Step 1 of 2: your prompt')
    expect(second.stderr).toContain('Step 2 of 2: what to do with it')
  })

  it('N12: stopping to add another company asks for it and keeps the first', async () => {
    const io = await signedIn()
    io.answers.push('1', PROMPT, '2', 'Helix', '1', '2', 'Kiln', '1')
    const r = await cli(io, 'prompt', '--no-wait')
    expect(r.code).toBe(0)
    expect(promptBodies()[0]).toMatchObject({ mode: 'improve', recipients: [{ recipient: { company: 'Helix' } }, { recipient: { company: 'Kiln' } }] })
  })

  it('N13: the paste question says how to stop', async () => {
    const io = await signedIn()
    io.answers.push('1', '')
    await cli(io, 'prompt')
    expect(io.prompts).toContain('Paste the prompt, then press Enter on an empty line (Ctrl+C to stop):')
  })
})

describe('search', () => {
  it('N15: a research offer replaces the rephrasing advice', async () => {
    const offer = { reason: 'This asks why. Research can look for the cause.' }
    const base = { success: true, results: [{ id: 'r1', title: 'Call', text: 'Pricing.' }], answer: { status: 'not_enough_data' } }
    const io = await withKey({ searchResult: { ...base, research_offer: offer } })
    expect((await cli(io, 'search', 'why do deals die')).stdout).not.toContain('Try rephrasing')
    await server!.close()
    const plain = await withKey({ searchResult: base })
    expect((await cli(plain, 'search', 'why do deals die')).stdout).toContain('Try rephrasing')
  })

  it('N16: the research wait shows the time passed on a terminal, and nothing off one', async () => {
    const io = await withKey({ researchDelayMs: 120 }, { AMDAHL_TICK_MS: '20' })
    io.stderrIsTTY = true
    const r = await cli(io, 'search', 'why do deals die', '--research')
    expect(r.code).toBe(0)
    expect(r.stderr).toMatch(/\rResearching\.\.\. 0:0\d/)
    const piped = await withKey({ researchDelayMs: 120 }, { AMDAHL_TICK_MS: '20' })
    expect((await cli(piped, 'search', 'why do deals die', '--research')).stderr).not.toContain('\r')
    const json = await withKey({ researchDelayMs: 120 }, { AMDAHL_TICK_MS: '20' })
    json.stderrIsTTY = true
    expect((await cli(json, 'search', 'why do deals die', '--research', '--json')).stderr).not.toContain('\r')
  })
})

describe('N17: recipes while For you is pending', () => {
  const FOR_YOU = [{ recipe_id: 'why-deals-die', kind: 'try', reason: '1 deal lost', fills: {} }]

  it('says it is working, and says so when it gives up', async () => {
    const io = await signedIn({ suggestions: { for_you: FOR_YOU }, suggestionsPendingReads: 99 })
    const r = await cli(io, 'recipes')
    expect(r.stderr).toContain('Working out For you...')
    expect(r.stderr).toContain('For you is not ready yet.')
    await server!.close()
    const ready = await signedIn({ suggestions: { for_you: FOR_YOU }, suggestionsPendingReads: 1 })
    const ok = await cli(ready, 'recipes')
    expect(ok.stderr).toContain('Working out For you...')
    expect(ok.stderr).not.toContain('not ready yet')
    const json = await cli(ready, 'recipes', '--json')
    expect(json.stderr).toBe('')
  })
})

describe('sent and --for: N19, N20', () => {
  it('N19: --provider is lower-cased, and a typo gets the nearest id', async () => {
    const io = await signedIn()
    const args = ['sent', KNOWN_RUN, '--channel', 'email', '--sent-as', 'returned', '--provider-send-id', 'x1']
    expect((await cli(io, ...args, '--provider', 'AMPLEMARKET')).code).toBe(0)
    const typo = await cli(io, ...args, '--provider', 'instntly')
    expect(typo.code).toBe(2)
    expect(typo.stderr).toContain('Did you mean instantly?')
    await server!.close()
    const list = await signedIn()
    const file = write(list, 'l.csv', 'email,message\na@b.com,Hi\n')
    const bad = await cli(list, 'optimize', '--list', file, '--for', 'amplemarkt')
    expect(bad.code).toBe(2)
    expect(bad.stderr).toContain('Did you mean amplemarket?')
  })

  it('N20: the Sent one hint names the --for tool', async () => {
    server = await startMockServer()
    const io = fakeIo({ AMDAHL_API_URL: server.url })
    expect((await cli(io, 'login', '--json')).code).toBe(0)
    io.stdoutIsTTY = false
    const file = write(io, 'l.csv', 'email,message\na@b.com,Hi\n')
    const r = await cli(io, 'optimize', '--list', file, '--for', 'amplemarket')
    expect(r.stderr).toMatch(/Sent one\? amdahl sent \S+ --provider amplemarket --channel/)
    expect(r.stderr).not.toContain('<provider>')
  })
})

describe('N21: the changes block', () => {
  it('fits the terminal width', async () => {
    const io = await signedIn({ whatChanged: true })
    io.columns = () => 50
    const r = await cli(io, 'optimize', write(io, 'd.txt', 'Hi Dana'))
    const lines = r.stderr.split('\n')
    const block = lines.slice(lines.indexOf('What Amdahl changed:'), lines.findIndex((l) => l.startsWith('Run:')))
    expect(block.length).toBeGreaterThan(5)
    expect(Math.max(...block.map((l) => l.length))).toBeLessThanOrEqual(50)
  })

  it('a reworded row with one reason says Was or Now', () => {
    const cutOnly = changeLines({ changes: [{ before: 'Can we talk?', after: 'Worth 15 minutes?', why_cut: 'it did not say how long' }] })
    expect(cutOnly).toContain('    Was: it did not say how long.')
    const addedOnly = changeLines({ changes: [{ before: 'Can we talk?', after: 'Worth 15 minutes?', why_added: 'it asks for a time' }] })
    expect(addedOnly).toContain('    Now: it asks for a time.')
  })

  it('--verbose lists the other sources of a new sentence', async () => {
    const io = await signedIn({ whatChanged: true })
    const file = write(io, 'd.txt', 'Hi Dana')
    expect((await cli(io, 'optimize', file)).stderr).not.toContain('Second source.')
    const r = await cli(io, 'optimize', file, '--verbose')
    expect(r.stderr).toContain('Source: "Second source."')
    expect(WHAT_CHANGED.added_claims[0]!.sources).toHaveLength(2)
  })
})
