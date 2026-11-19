// "What Amdahl changed" (0.5.4): the server's reason for each sentence it cut,
// added or reworded, on optimize, run, optimize --list and prompt. All through
// the real entry point, against the strict mock server. A server that sends no
// `changes` leaves every output as it was.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseCsv } from '../src/commands/batch'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { API_KEY, KNOWN_RUN, PROMPT_RUN, WHAT_CHANGED, startMockServer, type MockServer } from './helpers/mock-server'

let server: MockServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

async function withKey(options: Parameters<typeof startMockServer>[0] = {}): Promise<FakeIo> {
  server = await startMockServer(options)
  return fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_KEY: API_KEY })
}

const write = (io: FakeIo, name: string, text: string) => {
  const path = join(io.cwd, name)
  writeFileSync(path, text)
  return path
}
const fits80 = (text: string) => expect(text.split('\n').filter((l) => [...l].length > 80)).toEqual([])

const BLOCK = [
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
]

const STEPS = [{ node: 'w3', reason: 'repaired:1,deleted:1' }]
const RESULT = {
  ok: true,
  message: 'Hi Dana, Helix cut tickets by 70%.',
  run_id: 'r1',
  steps: STEPS,
  evidence: { used: true, requested: 'workspace' },
  unsupported_claims: [{ status: 'removed' }, { status: 'removed' }],
  omitted: [{ what: 'a proof point', why: 'The context held one.' }],
}

describe('optimize shows what Amdahl changed', () => {
  it('prints the block after the message on stderr, drops the rewrite line it repeats, and keeps the removed-claims line', async () => {
    const io = await withKey({ optimizeResult: { ...RESULT, ...WHAT_CHANGED } })
    const r = await cli(io, 'optimize', write(io, 'draft.txt', 'Hi Dana.'))
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('Hi Dana, Helix cut tickets by 70%.\n')
    expect(r.stderr.split('\n').slice(0, BLOCK.length + 3)).toEqual([
      ...BLOCK,
      'Checked every claim against your calls.',
      "Removed 2 claims your calls don't back.",
      'Left out 1 thing: The context held one.',
    ])
    expect(r.stderr).toContain('\nRun: r1\n')
    expect(r.stderr).not.toContain('Rewrote')
    fits80(r.stderr.split('\n').slice(0, BLOCK.length).join('\n'))
  })

  it('with no changes from the server, prints exactly what it printed before', async () => {
    const io = await withKey({ optimizeResult: { ...RESULT, omitted: [] } })
    const r = await cli(io, 'optimize', write(io, 'draft.txt', 'Hi Dana.'))
    expect(r.stderr.split('\n').slice(0, 3)).toEqual([
      'Checked every claim against your calls.',
      "Removed 2 claims your calls don't back.",
      'Rewrote 1 sentence and cut 1 that nothing backed.',
    ])
    expect(r.stderr).not.toContain('What Amdahl changed')
  })

  it('prints no block for an empty changes list or an unchanged draft', async () => {
    for (const extra of [{ changes: [] }, { ...WHAT_CHANGED, unchanged: true }]) {
      const io = await withKey({ optimizeResult: { ...RESULT, ...extra } })
      const r = await cli(io, 'optimize', write(io, 'draft.txt', 'Hi Dana.'))
      expect(r.stderr).not.toContain('What Amdahl changed')
    }
  })

  it('says a reason once, after the rows, when every change gives the same one', async () => {
    const why = 'Rewritten to use your context.'
    const changes = [
      { before: 'We are the leading platform.', after: 'We help shippers stop overbilled charges.', why },
      { before: 'Any time this week?', after: null, why },
      { before: null, after: 'Worth 15 minutes on Tuesday?', why },
    ]
    const io = await withKey({ optimizeResult: { ...RESULT, changes } })
    const r = await cli(io, 'optimize', write(io, 'draft.txt', 'Hi Dana.'))
    expect(r.stderr.split('\n').slice(0, 6)).toEqual([
      'What Amdahl changed:',
      '  - "We are the leading platform."',
      '  + "We help shippers stop overbilled charges."',
      '  - "Any time this week?"',
      '  + "Worth 15 minutes on Tuesday?"',
      '  Why, for each change: Rewritten to use your context.',
    ])
  })

  it('--json passes changes and added_claims through as the server sent them', async () => {
    const io = await withKey({ whatChanged: true })
    const r = await cli(io, 'optimize', write(io, 'draft.txt', 'Hi Dana.'), '--json')
    expect(JSON.parse(r.stdout).result).toMatchObject({ changes: WHAT_CHANGED.changes, added_claims: WHAT_CHANGED.added_claims })
  })
})

describe('run reads a stored run', () => {
  it('shows no changes block and its help promises none: the run read (getRun.ts) never returns changes', async () => {
    const io = await withKey({ whatChanged: true })
    const r = await cli(io, 'run', KNOWN_RUN)
    expect(r.code).toBe(0)
    expect(r.stdout).not.toContain('What Amdahl changed')
    expect((await cli(io, 'run', '--help')).stdout).not.toContain('what it changed and why')
  })
})

describe('optimize --list adds an amdahl_changes column', () => {
  it('has one line per change in the results CSV, and no column when no result has changes', async () => {
    const io = await withKey({ whatChanged: true })
    const list = write(io, 'd.csv', 'message\nHi A\nHi B\n')
    expect((await cli(io, 'optimize', '--list', list)).code).toBe(0)
    const { rows } = parseCsv(readFileSync(join(io.cwd, 'd.optimized.csv'), 'utf8'))
    expect(rows[0]).toEqual(['message', 'optimized_message', 'status', 'summary', 'run_id', 'error', 'amdahl_changes'])
    expect(rows[1]?.[6]).toBe(
      [
        'Cut "We are the leading onboarding platform.": nothing in your calls backs it.',
        'Added "Helix cut provisioning tickets by 70% in one quarter.": it gives proof from a team like theirs.',
        'Changed "Quick note about pricing." to "Quick note on pricing for Helix.": Names the company.',
        'Changed "Can we talk?" to "Worth 15 minutes?". Cut: it did not say how long. New: it asks for 15 minutes.',
      ].join('\n')
    )

    const old = await withKey()
    const list2 = write(old, 'd.csv', 'message\nHi A\n')
    await cli(old, 'optimize', '--list', list2)
    expect(parseCsv(readFileSync(join(old.cwd, 'd.optimized.csv'), 'utf8')).rows[0]).toEqual(['message', 'optimized_message', 'status', 'summary', 'run_id', 'error'])
  })
})

describe('prompt shows what changed in the prompt', () => {
  it('prints the block in the report on stderr with the revised prompt on stdout, only for an improved run', async () => {
    const io = await withKey({ whatChanged: true })
    const file = write(io, 'p.md', 'Write an email.')
    const r = await cli(io, 'prompt', file)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('Write a first-touch email to a Head of Platform. Name what they shipped, then ask for 15 minutes.\n')
    expect(r.stderr).toContain(
      [
        'What changed in your prompt:',
        '  - "Write an email."',
        '  + "Write a first-touch email to a Head of Platform."',
        '    Cut: it named no reader.',
        '    New: it says who reads it.',
        '  + "Then ask for 15 minutes."',
        '    New: it ends on one ask.',
      ].join('\n')
    )
    expect(r.stderr).toContain(`Run: ${PROMPT_RUN}`)
    fits80(r.stderr)

    const grade = await cli(io, 'prompt', file, '--mode', 'grade')
    expect(grade.stdout).not.toContain('What changed in your prompt')
    expect(grade.stderr).not.toContain('What changed in your prompt')
  })
})
