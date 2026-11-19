// `amdahl sequence`: the fixes from the second UX QA pass (B1, S1 to S8, S15, N1 to N10, EPIPE).
// Each test drives the real entry point against the strict mock server, and each failed on the code
// before its fix.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startTicker } from '../src/sequence-ticker'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { API_KEY, startMockServer, type MockServer } from './helpers/mock-server'

let server: MockServer | null = null
afterEach(async () => {
  vi.useRealTimers()
  await server?.close()
  server = null
})

const OPTIMIZE = '/api/platform/v1/messages/optimize'
type Answer = Record<string, unknown>

/** A rewrite puts "Better: " before the text; a written email is "Written <n>" with a subject. */
const answer = (body: Answer, index: number): Answer => {
  const message = String(body.message ?? '')
  if (!message) return { ok: true, message: `Subject: Hello ${index + 1}\n\nWritten ${index + 1}.`, run_id: `run-${index + 1}` }
  const m = /^Subject: (.*)\n\n([\s\S]*)$/.exec(message)
  return { ok: true, message: m ? `Subject: ${m[1]}\n\nBetter: ${m[2]}` : `Better: ${message}`, run_id: `run-${index + 1}` }
}

async function withKey(options: Parameters<typeof startMockServer>[0] = {}): Promise<FakeIo> {
  await server?.close()
  server = await startMockServer({ optimizeAnswer: answer, ...options })
  const io = fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_KEY: API_KEY })
  io.stdinIsTTY = false
  return io
}

const put = (io: FakeIo, name: string, text: string) => {
  const path = join(io.cwd, name)
  writeFileSync(path, text)
  return path
}
const bodies = () => (server?.log ?? []).filter((r) => r.path === OPTIMIZE).map((r) => JSON.parse(r.body) as Answer)
const THREE = 'One.\n---\nTwo.\n---\nThree.'
const rulesOf = (i: number) => ((bodies()[i]?.context as { rules?: string[] } | undefined)?.rules ?? [])
const asTerminal = (io: FakeIo, both = true) => {
  io.stdinIsTTY = true
  io.stderrIsTTY = true
  io.stdoutIsTTY = both
}

describe('B1: a --csv folder that is not there', () => {
  it('is refused before the first email is billed', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequence', put(io, 'x.md', THREE), '--csv', join(io.cwd, 'out', 'acme.csv'))
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('out does not exist, so ')
    expect(bodies()).toEqual([])
  })

  it('a save that still fails prints the emails and the JSON, and is a file error, not a network error', async () => {
    const io = await withKey()
    mkdirSync(join(io.cwd, 'dir.csv'))
    const plain = await cli(io, 'sequence', put(io, 'x.md', THREE), '--csv', join(io.cwd, 'dir.csv'), '--force')
    expect(plain.code).toBe(1)
    expect(plain.stdout).toContain('Email 3 of 3\nBetter: Three.')
    expect(plain.stderr).toContain('Could not save ')
    expect(plain.stderr).not.toContain('Could not reach')
    const json = await cli(io, 'sequence', put(io, 'y.md', THREE), '--csv', join(io.cwd, 'dir.csv'), '--force', '--json')
    expect(json.code).toBe(1)
    expect(json.json.emails).toHaveLength(3)
    expect(json.json.file_error.code).toBe('file_error')
  })
})

describe('S1 and S2: what starts an email', () => {
  it('a body line that starts like a label stays in its email', async () => {
    const io = await withKey()
    await cli(io, 'sequence', put(io, 'x.md', 'Hi.\nStep 1: connect your TMS.\nFollow-up: are you free Tuesday?\n---\nBye.'))
    expect(bodies().map((b) => b.message)).toEqual(['Hi.\nStep 1: connect your TMS.\nFollow-up: are you free Tuesday?', 'Bye.'])
  })

  it('Email 1 - Intro with an en dash, Day 3, Email 2 (2 days later) and Step 2: Break-up email start an email', async () => {
    const io = await withKey()
    await cli(io, 'sequence', put(io, 'x.md', 'Email 1 \u2013 Intro\nA.\nDay 3\nB.\nEmail 4 (2 days later)\nC.\nStep 5: Break-up email\nD.'))
    expect(bodies().map((b) => b.message)).toEqual(['A.', 'B.', 'C.', 'D.'])
  })

  it('names how many it found and the --- separator', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequence', put(io, 'x.md', 'Just one.'))
    expect(r.stderr).toContain('Error: Found 1 email. Put a line of --- between emails.')
  })

  it('at a terminal, lists what it found before sending', async () => {
    const io = await withKey()
    asTerminal(io, false)
    io.answers = ['n']
    const r = await cli(io, 'sequence', put(io, 'x.md', THREE))
    expect(r.stderr.split('\n').slice(0, 4)).toEqual(['Found 3 emails:', '  1. One.', '  2. Two.', '  3. Three.'])
  })
})

describe('S3: saving after the run', () => {
  it('at a terminal, asks to save and writes the CSV on yes', async () => {
    const io = await withKey()
    asTerminal(io)
    io.answers = ['']
    const path = put(io, 'x.md', THREE)
    const r = await cli(io, 'sequence', path)
    const target = join(io.cwd, 'x-amdahl.csv')
    expect(io.prompts).toEqual([`Save as ${target}? [Y/n]`])
    expect(r.stderr).toContain(`Saved: ${target}`)
    expect(readFileSync(target, 'utf8')).toContain('3,,Better: Three.')
  })

  it('writes nothing on no', async () => {
    const io = await withKey()
    asTerminal(io)
    io.answers = ['n']
    await cli(io, 'sequence', put(io, 'x.md', THREE))
    expect(existsSync(join(io.cwd, 'x-amdahl.csv'))).toBe(false)
  })
})

describe('S4: Ctrl+C and --from', () => {
  const interruptAt = (io: FakeIo, index: number) => {
    let hold: (() => void) | null = null
    io.onInterrupt = (h) => {
      hold = h
      return () => {}
    }
    return (body: Answer, i: number) => {
      if (i === index) hold?.()
      return answer(body, i)
    }
  }

  it('saves what came back, prints the run ids, exits 130, and --from picks up from the saved CSV', async () => {
    const io = await withKey()
    await server?.close()
    let fire: (body: Answer, i: number) => Answer = answer
    server = await startMockServer({ optimizeAnswer: (b, i) => fire(b, i) })
    io.env.AMDAHL_API_URL = server.url
    fire = interruptAt(io, 1)
    const path = put(io, 'x.md', THREE)
    const csv = join(io.cwd, 'x-amdahl.csv')
    const r = await cli(io, 'sequence', path, '--csv')
    expect(r.code).toBe(130)
    expect(readFileSync(csv, 'utf8')).toContain('1,,Better: One.')
    expect(r.stderr).toContain('Email 1: run run-1')
    expect(r.stderr).toContain(`--csv ${csv} --from 2`)
    const before = bodies().length
    fire = answer
    const again = await cli(io, 'sequence', path, '--csv', '--from', '2')
    expect(again.code).toBe(0)
    const next = bodies().slice(before)
    expect(next.map((b) => b.message)).toEqual(['Two.', 'Three.'])
    expect((next[0]?.context as { prior_touches: { summary: string }[] }).prior_touches.map((t) => t.summary)).toEqual(['Better: One.'])
    expect(readFileSync(csv, 'utf8')).toContain('3,,Better: Three.')
  })

  it('--from without --csv reads the saved CSV and writes the whole sequence back to it', async () => {
    const io = await withKey()
    await server?.close()
    let fire: (body: Answer, i: number) => Answer = answer
    server = await startMockServer({ optimizeAnswer: (b, i) => fire(b, i) })
    io.env.AMDAHL_API_URL = server.url
    fire = interruptAt(io, 1)
    const path = put(io, 'x.md', THREE)
    const csv = join(io.cwd, 'x-amdahl.csv')
    expect((await cli(io, 'sequence', path, '--csv')).code).toBe(130)
    fire = answer
    const again = await cli(io, 'sequence', path, '--from', '2')
    expect(again.code).toBe(0)
    const saved = readFileSync(csv, 'utf8')
    expect(saved).toContain('1,,Better: One.')
    expect(saved).toContain('3,,Better: Three.')
    expect(again.stdout).toContain(`Saved: ${csv}`)
  })

  it('--from without the saved file names it', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequence', put(io, 'x.md', THREE), '--from', '2')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain(`--from needs ${join(io.cwd, 'x-amdahl.csv')}, the CSV an earlier run saved`)
    expect(bodies()).toEqual([])
  })
})

describe('S5 and S8: the rules of a written sequence', () => {
  it('a template: every email greets with a field; later ones reply in the thread and name no date; no subject after email 1', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequence', '--write', 'Book a meeting.', '--emails', '3', '--csv', '--json')
    expect(rulesOf(0)).toEqual(expect.arrayContaining(['Greet the reader with {{first_name}} so the sequencer fills it in.']))
    expect(rulesOf(0)).toHaveLength(3)
    expect(rulesOf(2).slice(-3)).toEqual(['Greet the reader with {{first_name}} so the sequencer fills it in.', 'Email 3 replies in the same thread as email 1, so it has no subject line.', 'Do not name the date or day of an earlier email: the send dates are not set yet.'])
    expect(r.json.emails.map((e: { subject: string | null }) => e.subject)).toEqual(['Hello 1', null, null])
    expect(readFileSync(join(io.cwd, 'sequence-amdahl.csv'), 'utf8')).toBe('\uFEFFEmail,Subject,Message\r\n1,Hello 1,Written 1.\r\n2,,Written 2.\r\n3,,Written 3.')
  })

  it('improving adds no rule', async () => {
    const io = await withKey()
    await cli(io, 'sequence', put(io, 'x.md', THREE))
    expect(bodies().every((b) => (b.context as { rules?: string[] } | undefined)?.rules === undefined)).toBe(true)
  })
})

describe('S6: the sign-in comes before the question', () => {
  it('signs in, then asks "Write these N emails?"', async () => {
    server = await startMockServer({ optimizeAnswer: answer })
    const io = fakeIo({ AMDAHL_API_URL: server.url })
    asTerminal(io)
    io.answers = ['n']
    const r = await cli(io, 'sequence', '--write', 'Book a meeting.')
    expect(io.opened).toHaveLength(1)
    expect(r.stderr.indexOf('Signed in')).toBeGreaterThan(-1)
    expect(r.stderr.indexOf('Signed in')).toBeLessThan(r.stderr.indexOf('The plan, 3 emails:'))
    expect(r.stderr).toContain('Sign in first, then write your sequence.')
    expect(r.stderr).not.toContain('paste your message')
  })
})

describe('S7: the time', () => {
  it('says the total up front on a terminal and redraws a clock while a request runs', async () => {
    const io = await withKey()
    asTerminal(io, false)
    io.answers = ['n']
    const r = await cli(io, 'sequence', put(io, 'x.md', THREE))
    expect(r.stderr).toContain('About 3 minutes in all.\n')
    const quiet = await withKey()
    const q = await cli(quiet, 'sequence', put(quiet, 'x.md', THREE))
    expect(q.stderr).not.toContain('About')
    expect(q.stderr).not.toContain('\r')
  })

  it('redraws "email 2 of 3, 0:41" each second, and clears the line', () => {
    vi.useFakeTimers()
    const io = fakeIo()
    io.stderrIsTTY = true
    let now = 0
    io.now = () => now
    const stop = startTicker(io, 'email 2 of 3')
    now = 41_000
    vi.advanceTimersByTime(1000)
    expect(io.err.join('')).toBe('\remail 2 of 3, 0:41\u001b[K')
    stop()
    expect(io.err.join('').endsWith('\r\u001b[K')).toBe(true)
    const pipe = fakeIo()
    startTicker(pipe, 'x')()
    vi.advanceTimersByTime(5000)
    expect(pipe.err).toEqual([])
  })
})

describe('S15 and N1: a sequence CSV', () => {
  it('says when the file has more than one row', async () => {
    const io = await withKey()
    const csv = 'name,step_1_body,step_2_body\nA,One,Two\nB,Three,Four\n'
    const r = await cli(io, 'sequence', put(io, 'steps.csv', csv))
    expect(r.stderr).toContain('This file has 2 rows; a sequence reads one. For a sequence per person: amdahl sequence <file> --leads <list.csv>')
  })

  it('reads the CSV the command saved, BOM and all', async () => {
    const io = await withKey()
    await cli(io, 'sequence', put(io, 'x.md', 'Subject: Hi\n\nOne.\n---\nTwo.\n---\nThree.'), '--csv', join(io.cwd, 'saved.csv'))
    const again = await cli(io, 'sequence', join(io.cwd, 'saved.csv'), '--json')
    expect(again.code).toBe(0)
    expect(again.json.emails.map((e: { subject: string | null }) => e.subject)).toEqual(['Hi', null, null])
    expect(bodies().slice(3).map((b) => b.message)).toEqual(['Subject: Hi\n\nBetter: One.', 'Better: Two.', 'Better: Three.'])
  })
})

describe('N2, N3, N4: what is printed around each email', () => {
  it('prints each run id under its email, and one Sent them? line at the end', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequence', put(io, 'x.md', THREE))
    expect(r.stderr).toContain('Run: run-1\nRun: run-2\nRun: run-3\nSent them? amdahl sent <run id>')
  })

  it('keeps the Checked line', async () => {
    const io = await withKey({ optimizeAnswer: (b, i) => ({ ...answer(b, i), evidence: { used: true } }) })
    const r = await cli(io, 'sequence', put(io, 'x.md', THREE))
    expect(r.stderr).toContain('Email 1: Checked the message against your calls.')
  })

  it('on a terminal the blank line comes before "Amdahl is improving email 2 of 3.", not after', async () => {
    const io = await withKey()
    asTerminal(io)
    io.answers = ['n']
    const r = await cli(io, 'sequence', put(io, 'x.md', THREE))
    expect(r.stdout).toBe('Email 1 of 3\nBetter: One.\nEmail 2 of 3\nBetter: Two.\nEmail 3 of 3\nBetter: Three.\n')
    expect(r.stderr).toContain('\n\nAmdahl is improving email 2 of 3.\n')
  })
})

describe('N5: an account refusal before any email', () => {
  it('prints the account error alone', async () => {
    const io = await withKey({ optimizeRefusal: () => ({ status: 401, body: { error: { code: 'unauthenticated', message: 'This key is not valid.' } } }) })
    const r = await cli(io, 'sequence', put(io, 'x.md', THREE))
    expect(r.code).toBe(3)
    expect(r.stderr).toBe("This key isn't valid (revoked or expired).\nRun `amdahl login`, or check AMDAHL_KEY.\n")
  })

  it('a 402 prints the message alone too', async () => {
    const io = await withKey({ optimizeRefusal: () => ({ status: 402, body: { error: { code: 'payment_required', message: 'Your plan has no runs left.' } } }) })
    const r = await cli(io, 'sequence', put(io, 'x.md', THREE))
    expect(r.stderr).toBe('Your plan has no runs left.\n')
  })

  it('a later failure drops the raw reason code', async () => {
    const io = await withKey({ optimizeAnswer: (b, i) => (i === 1 ? { ok: false, reason: 'optimizer_error', detail: 'Down' } : answer(b, i)) })
    const r = await cli(io, 'sequence', put(io, 'x.md', THREE))
    expect(r.stderr).toContain('Email 2 was not improved: Down. Email 3 was not run.')
  })
})

describe('N6, N7, N8, N10', () => {
  it('N6: a --csv name must end in .csv', async () => {
    const io = await withKey()
    const path = put(io, 'x.md', THREE)
    for (const args of [['--csv', 'out.txt'], ['--csv=out.txt']]) {
      const r = await cli(io, 'sequence', path, ...args)
      expect([r.code, r.stderr.split('\n')[0]]).toEqual([2, 'Error: --csv takes a name ending in .csv.'])
    }
    expect(bodies()).toEqual([])
  })

  it('N7: the CSV starts with a UTF-8 byte order mark', async () => {
    const io = await withKey()
    await cli(io, 'sequence', put(io, 'x.md', THREE), '--csv')
    expect(readFileSync(join(io.cwd, 'x-amdahl.csv'))[0]).toBe(0xef)
  })

  it('N8: the guided Write ends with how to run it next time', async () => {
    const io = await withKey()
    asTerminal(io)
    io.answers = ['2', '', '', '', 'n']
    const r = await cli(io, 'sequence')
    expect(r.stderr.trimEnd().split('\n').pop()).toBe('Next time: amdahl sequence --write "<goal>" --csv')
  })

  it('N10: --write --json lists the plan', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequence', '--write', 'Book a meeting.', '--emails', '2', '--json')
    expect(r.json.plan).toEqual([{ name: 'Opener', job: 'Why now, and one easy question' }, { name: 'Last try', job: 'Close politely and leave a way back in' }])
  })
})

describe('EPIPE: a closed pipe', () => {
  it('stops before the next paid email, with no error, though EPIPE lands a tick after the write', async () => {
    const io = await withKey()
    let closed = false
    // Real stdout reports EPIPE on a later tick, not during the write.
    io.stdout = () => void setImmediate(() => (closed = true))
    io.stdoutClosed = () => closed
    const r = await cli(io, 'sequence', put(io, 'x.md', THREE))
    expect(r.code).toBe(0)
    expect(bodies()).toHaveLength(1)
  })
})
