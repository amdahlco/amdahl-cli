// `amdahl sequencers campaigns` and `amdahl sequencers push`, against the mock
// server, which holds the server's rules for a key or a sign-in: up to 100
// leads a call, a paused or draft campaign only, and the sequencers:push scope.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { API_KEY, READONLY_KEY, startMockServer, type MockServer } from './helpers/mock-server'

let server: MockServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

const INSTANTLY = { id: '55555555-5555-4555-8555-555555555555', type: 'instantly', name: 'Instantly' }

async function withKey(key = API_KEY, sequencers = [INSTANTLY]): Promise<FakeIo> {
  server = await startMockServer({ sequencers })
  const io = fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_KEY: key })
  io.stdoutIsTTY = true
  return io
}

function leadFile(io: FakeIo, n: number, name = 'leads-other.csv'): string {
  const rows = Array.from({ length: n }, (_, i) => `l${i}@example.com,Ada,Lovelace,Acme,"Subject ${i}","Hi Ada,\nline ${i}"`)
  const path = join(io.cwd, name)
  writeFileSync(path, ['email,first_name,last_name,company,amdahl_subject,amdahl_message', ...rows].join('\n'))
  return path
}

const posts = () => (server?.log ?? []).filter((r) => r.method === 'POST' && r.path.endsWith('/leads'))

describe('amdahl sequencers campaigns', () => {
  it('lists the connected sequencer campaigns with their status', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequencers', 'campaigns')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('camp-paused')
    expect(r.stdout).toContain('Q4 founders')
    expect(r.stdout).toContain('(paused)')
    expect(r.stdout).toContain('(live)')
  })

  it('names the permission and the way to get it when the credential lacks sequencers:push', async () => {
    const io = await withKey(READONLY_KEY)
    const r = await cli(io, 'sequencers', 'campaigns')
    expect(r.code).toBe(4)
    // No preset carries sequencers:push and `keys create` cannot add it, so the sentence names the console option.
    expect(r.stderr).toBe(
      'Error: This credential is missing the sequencers:push permission, so it cannot add leads to a sequencer campaign. Run `amdahl login` again, or use a key created in the console with Add leads to sequencer campaigns turned on.\n'
    )
    expect(r.stderr).not.toContain('keys create')
  })

  it('says the same for the server\'s scope_not_granted refusal, and keeps its code', async () => {
    server = await startMockServer({ sequencers: [INSTANTLY], scopeNotGranted: true })
    const io = fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_KEY: API_KEY })
    const r = await cli(io, 'sequencers', 'campaigns')
    expect(r.code).toBe(4)
    expect(r.stderr).toBe(
      'Error: This credential is missing the sequencers:push permission, so it cannot add leads to a sequencer campaign. Run `amdahl login` again, or use a key created in the console with Add leads to sequencer campaigns turned on.\n'
    )
    const j = await cli(io, 'sequencers', 'campaigns', '--json')
    expect(j.json.error.code).toBe('scope_not_granted')
  })

  it('says when no sequencer is connected', async () => {
    const io = await withKey(API_KEY, [])
    const r = await cli(io, 'sequencers', 'campaigns', '--json')
    expect(r.code).toBe(1)
    expect(r.json.error.code).toBe('no_sequencer')
  })
})

describe('amdahl sequencers push', () => {
  it('shows the campaign, its status and the lead count, and asks before it adds anything', async () => {
    const io = await withKey()
    const file = leadFile(io, 3)
    io.answers.push('y')
    const r = await cli(io, 'sequencers', 'push', file, '--campaign', 'camp-paused')
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual(['Add them? [y/N] '])
    expect(r.stderr).toContain('Add 3 leads to the paused Instantly campaign "Q4 founders" (camp-paused).')
    expect(r.stderr).toContain('First lead: l0@example.com, subject "Subject 0".')
    expect(r.stdout).toContain('Added 3 to "Q4 founders" in Instantly.')
    expect(server?.pushes).toHaveLength(1)
    expect(server?.pushes[0]?.body.leads[0]).toEqual({
      email: 'l0@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
      company: 'Acme',
      amdahl_subject: 'Subject 0',
      amdahl_message: 'Hi Ada,\nline 0',
    })
  })

  it('adds nothing when the person says no', async () => {
    const io = await withKey()
    io.answers.push('n')
    const r = await cli(io, 'sequencers', 'push', leadFile(io, 2), '--campaign', 'camp-paused')
    expect(r.code).toBe(130)
    expect(r.stderr).toContain('Nothing was added.')
    expect(posts()).toHaveLength(0)
  })

  it('adds nothing with no terminal and no --yes, and adds with --yes for a script', async () => {
    const io = await withKey()
    io.stdinIsTTY = false
    const file = leadFile(io, 2)
    const refused = await cli(io, 'sequencers', 'push', file, '--campaign', 'camp-paused', '--json')
    expect(refused.code).toBe(2)
    expect(refused.json.error.message).toContain('needs a yes')
    expect(posts()).toHaveLength(0)

    const r = await cli(io, 'sequencers', 'push', file, '--campaign', 'camp-paused', '--yes', '--json')
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([])
    expect(r.json).toMatchObject({ ok: true, campaign: { id: 'camp-paused', status: 'paused' }, counts: { added: 2, skipped: 0, failed: 0 } })
  })

  it('refuses a live campaign before it sends anything', async () => {
    const io = await withKey()
    const r = await cli(io, 'sequencers', 'push', leadFile(io, 2), '--campaign', 'camp-live', '--yes', '--json')
    expect(r.code).toBe(1)
    expect(r.json.error.code).toBe('campaign_active')
    expect(posts()).toHaveLength(0)
  })

  it('sends more than 100 leads in calls of 100, and the same command again adds nothing twice', async () => {
    const io = await withKey()
    const file = leadFile(io, 150)
    const first = await cli(io, 'sequencers', 'push', file, '--campaign', 'camp-draft', '--yes', '--json')
    expect(first.code).toBe(0)
    expect(server?.pushes.map((p) => p.body.leads.length)).toEqual([100, 50])
    expect(first.json.counts.added).toBe(150)

    const again = await cli(io, 'sequencers', 'push', file, '--campaign', 'camp-draft', '--yes', '--json')
    expect(again.code).toBe(0)
    expect(posts()).toHaveLength(4)
    expect(server?.pushes).toHaveLength(2)
  })

  it('says what an earlier call added when a later call is refused', async () => {
    server = await startMockServer({ sequencers: [INSTANTLY], pushesBeforeLive: 1 })
    const io = fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_KEY: API_KEY })
    const r = await cli(io, 'sequencers', 'push', leadFile(io, 150), '--campaign', 'camp-draft', '--yes', '--json')
    expect(r.code).toBe(1)
    expect(r.json.error.code).toBe('campaign_active')
    expect(r.json.error.message).toContain('Calls 1 to 1 of 2 already added 100')
    expect(r.json.counts).toEqual({ added: 100, skipped: 0, failed: 0 })
    expect(server.pushes).toHaveLength(1)
  })

  it('reads a finished batch with the list it was written from', async () => {
    const io = await withKey()
    const list = join(io.cwd, 'drafts.csv')
    writeFileSync(list, 'email,first_name,message\na@example.com,Ada,Hi Ada\nb@example.com,Bo,Hi Bo\n')
    const batch = await cli(io, 'optimize', '--list', list, '--json')
    expect(batch.code).toBe(0)
    const id = batch.json.batch_id ?? batch.json.batch?.batch_id ?? batch.json.id
    expect(typeof id).toBe('string')

    const r = await cli(io, 'sequencers', 'push', id, '--list', list, '--channel', 'email', '--campaign', 'camp-paused', '--yes', '--json')
    expect(r.code).toBe(0)
    const leads = server?.pushes[0]?.body.leads ?? []
    expect(leads.map((l) => l.email)).toEqual(['a@example.com', 'b@example.com'])
    expect(leads.every((l) => typeof l.amdahl_message === 'string' && l.amdahl_message.length > 0)).toBe(true)
  })

  it('needs --campaign and refuses a file with no amdahl_message column', async () => {
    const io = await withKey()
    const file = join(io.cwd, 'plain.csv')
    writeFileSync(file, 'email,message\na@example.com,Hi\n')
    expect((await cli(io, 'sequencers', 'push', file, '--yes')).code).toBe(2)
    const r = await cli(io, 'sequencers', 'push', file, '--campaign', 'camp-paused', '--yes')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('has no amdahl_message column')
    expect(posts()).toHaveLength(0)
  })
})
