// The copy fixes from the Nov 17 new-user QA of 0.5.1 (CLI report N2-N6, N8-N10,
// N12, N13, N15, N16). Each test failed on main before the change.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gradeLines } from '../src/commands/grade'
import { presetName } from '../src/commands/keys'
import { recipientsNeeded } from '../src/commands/prompt'
import { setupLines } from '../src/commands/search'
import { toCliError } from '../src/context'
import { CliError, EXIT } from '../src/errors'
import { inMinutes, readableDay } from '../src/text'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { API_KEY, startMockServer, type MockServer } from './helpers/mock-server'

let server: MockServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

async function signedIn(options: Parameters<typeof startMockServer>[0] = {}): Promise<FakeIo> {
  server = await startMockServer(options)
  const io = fakeIo({ AMDAHL_API_URL: server.url })
  expect((await cli(io, 'login', '--json')).code).toBe(0)
  io.opened.length = 0
  return io
}

const flat = (text: string) => text.replace(/\s*\n\s*/g, ' ')
const write = (io: FakeIo, name: string, text: string) => {
  const path = join(io.cwd, name)
  writeFileSync(path, text)
  return path
}

describe('dates and preset names a person reads (N2)', () => {
  it('a reset day reads as a day, in UTC, and a near deadline as minutes from now', () => {
    expect(readableDay('2026-12-01T00:00:00.000Z')).toBe('Dec 1, 2026')
    expect(readableDay('not a date')).toBe('')
    const now = Date.parse('2026-11-17T16:33:51Z')
    expect(inMinutes('2026-11-17T16:43:51.16553+00:00', now)).toMatch(/^in 10 minutes \(\d{1,2}:\d\d [AP]M\)$/)
    expect(inMinutes('soon', now)).toBe('at soon')
  })

  it('a bundle reads as the --preset that makes it; a bundle with no preset reads as its words', () => {
    expect(presetName('mcp_customer_agent')).toBe('agent')
    expect(presetName('mcp_read_only')).toBe('read-only')
    expect(presetName('mcp_optimize')).toBe('optimize')
    expect(presetName(null)).toBe('')
  })

  it('status prints the reset as a day, not a timestamp', async () => {
    const io = await signedIn()
    const r = await cli(io, 'status')
    expect(r.stdout + r.stderr).toContain('resets Dec 1, 2026')
    expect(r.stdout + r.stderr).not.toContain('2026-12-01T00:00:00Z')
  })
})

describe('status on a new workspace (N3)', () => {
  it('shows the free credit left, and "none yet" for connections', async () => {
    const io = await signedIn({ noConnections: true, freeUsage: { granted_micros: 100_000_000, used_micros: 680_000, remaining_micros: 99_320_000, state: 'active' } })
    const out = (await cli(io, 'status')).stdout
    expect(out).toContain('Free usage: $99.32 of $100 left')
    expect(out).toContain('Connections: none yet\n  Connect your CRM or call recorder: amdahl connect')
    expect(out).not.toContain('0 of 0 healthy')
  })
})

describe('data on an empty workspace (N4)', () => {
  it('skips the field names when nothing has synced, and points at --surface', async () => {
    const io = await signedIn({ overview: { surfaces: [{ surface: 'interactions', row_count: 0, earliest_at: null, latest_at: null, time_field: 'timestamp' }] } })
    const r = await cli(io, 'data')
    expect(r.stdout).toContain('Nothing has synced yet.')
    expect(r.stdout).toContain('The fields a search can filter on: amdahl data --surface deals')
    expect(r.stdout).not.toContain("One surface's fields")
  })
})

describe('runs when this sign-in has none (N5)', () => {
  it('signed out says so and counts the runs kept; another key counts the sign-in\'s runs', async () => {
    const io = await signedIn()
    expect((await cli(io, 'grade', write(io, 'b.txt', 'Hi'))).code).toBe(0)
    const key = fakeIo({ AMDAHL_API_URL: server!.url, AMDAHL_KEY: API_KEY }, io.homedir)
    const withKey = flat((await cli(key, 'runs')).stdout)
    expect(withKey).toContain('1 run from this computer was made in another workspace or with another key.')
    expect((await cli(io, 'logout')).code).toBe(0)
    const out = flat((await cli(io, 'runs')).stdout)
    expect(out).toContain('Not signed in, so no runs are listed. This computer keeps 1 run from an earlier sign-in.')
    expect(out).toContain('amdahl login')
    expect(out).not.toContain('No runs yet')
  })
})

describe('a connection that drops after the request was sent (N6)', () => {
  const failed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code }) })

  it('a reset or closed socket says the connection dropped, and that a rerun is free', () => {
    const err = toCliError(failed('UND_ERR_SOCKET'))
    expect(err.message).toBe('The connection dropped while Amdahl was working, before its answer came back.')
    expect(err.hint).toContain('Run the same command again')
    expect(err.exit).toBe(EXIT.network)
    expect(err.code).toBe('network_error')
  })

  it('a refused or unknown host still says it could not reach the API', () => {
    expect(toCliError(failed('ECONNREFUSED')).message).toContain('Could not reach the Amdahl API')
    expect(toCliError(failed('ENOTFOUND')).message).toContain('Could not reach the Amdahl API')
    expect(toCliError(new TypeError('fetch failed')).message).toContain('Could not reach the Amdahl API')
  })
})

describe('prompt on a workspace with no customer speech (N8)', () => {
  const refusal = 'No account in this workspace has customer speech to sample recipients from. Send recipients. Nothing was run.'

  it('names the --recipients flag instead of "Send recipients"', async () => {
    const io = await signedIn({ promptRefusal: refusal })
    const r = await cli(io, 'prompt', write(io, 'p.md', 'Write an email.'), '--mode', 'grade', '--no-wait')
    expect(r.code).not.toBe(0)
    expect(r.stderr).not.toContain('Send recipients')
    expect(flat(r.stderr)).toContain('Add --recipients recipients.json: 1 to 6 people')
  })

  it('leaves other errors alone', () => {
    const other = new CliError('x', 'Something else.', EXIT.general)
    expect(recipientsNeeded(other, false)).toBe(other)
    const sent = new CliError('x', refusal, EXIT.general)
    expect(recipientsNeeded(sent, true)).toBe(sent)
  })
})

describe('prompt report wording (N9)', () => {
  it('a grade run puts the coverage in the headline, says "1 line", and drops "original"', async () => {
    const io = await signedIn({
      promptResult: () => ({
        outcome: 'graded',
        grade: { original: { mean: 5, n: 2, emails_passing_bar: 2, bar: 4.2, lines: { cta_clarity: { passed: 2, total: 2, rate: 1 }, grounding: { passed: 0, total: 0, rate: null } } }, revised: null },
        emails: [{ label: 'Helix', variant: 'original', split: 'graded', email: 'Hi.', grade: { score: 5, passed: 1, total: 1 } }],
        judges: { final: { model: 'm' } },
      }),
    })
    const r = await cli(io, 'prompt', write(io, 'p.md', 'Write an email.'), '--mode', 'grade')
    const out = flat(r.stdout)
    expect(out).toContain('Prompt grade: 5 of 5, over 2 emails, 2 passing the bar of 4.2, on 1 of the 2 lines.')
    expect(r.stdout).toContain('Helix, graded: 5 of 5 (1 of 1 line)')
    expect(r.stdout).not.toContain('original')
  })
})

describe('grade on fewer than half the lines (N10)', () => {
  const thin = (reason: string) => ({
    grade: {
      score: 5, passed: 1, total: 1, bar: 4.2, passes_bar: true,
      lines: [
        { id: 'cta_clarity', pass: true, applicable: true, reason: 'One ask.' },
        ...['relevant_positioning', 'grounding', 'verified_specifics', 'differentiation'].map((id) => ({ id, pass: null, applicable: false, not_applicable_reason: reason })),
      ],
    },
    evidence: { requested: 'workspace', used: false, reason },
  })

  it('does not say "meets the bar", and with no calls synced says to connect', () => {
    const text = gradeLines(thin('corpus_empty')).join('\n')
    expect(text).toContain('Grade 5 of 5, on 1 of the 5 lines (1 of 1 line passed).')
    expect(flat(text)).toContain('Only 1 of the 5 lines could be checked, so this is not a verdict on the draft.')
    expect(flat(text)).toContain('Connect your calls or CRM to grade the other 4: amdahl connect')
    expect(text).not.toContain('meets the bar')
  })

  it('with evidence not asked for, no connect line (the tip names --evidence workspace)', () => {
    const text = gradeLines(thin('not requested')).join('\n')
    expect(text).not.toContain('meets the bar')
    expect(text).not.toContain('amdahl connect')
  })
})

describe('search on an empty workspace (N12, N13)', () => {
  it('says connect once when the server message already does', () => {
    expect(setupLines('Nothing is connected. Connect it at https://console.example/x.')).toEqual(['Nothing is connected. Connect it at https://console.example/x.'])
    expect(setupLines('Nothing to search yet.')).toEqual(['Nothing to search yet.', 'Connect your CRM or call recorder: amdahl connect'])
  })

  it('--research with a sign-in says it needs an agent key, even when setup is needed', async () => {
    const io = await signedIn({
      searchResult: {
        success: true, mode_ran: 'fuzzy', results: [],
        notes: ['route:"research" needs a credential that can start one (conversations:write), so this ran search instead.'],
        setup_needed: { reason: 'no_sources_connected', message: 'Nothing is connected. Connect it at https://console.example/x.' },
      },
    })
    const r = await cli(io, 'search', 'Which deals did we lose?', '--research')
    expect(r.code).toBe(0)
    expect(flat(r.stderr)).toMatch(/Customer agent key/)
    expect(r.stdout).toBe('Nothing is connected. Connect it at https://console.example/x.\n')
  })
})

describe('list run columns Amdahl does not read (N16)', () => {
  it('says they are kept in the results, not that they were "not sent"', async () => {
    const io = await signedIn()
    const list = write(io, 'l.csv', 'name,email,message\nAda,ada@example.com,Hi Ada\n')
    const r = await cli(io, 'optimize', '--list', list, '--no-wait')
    expect(r.stderr).toContain('Kept as they are in the results (not sent to Amdahl): name, email.')
    expect(r.stderr).not.toContain('Not sent, and copied')
  })
})
