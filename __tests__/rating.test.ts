// A thumbs up or down on something Amdahl returned: `amdahl feedback <id> --rating`, and the opt-in
// "Was this useful?" line after optimize and search. Against the mock server, which refuses what the
// real `feedback.record` refuses (strict body, known surfaces, the CLI as the client).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configPath } from '../src/config'
import { VERSION } from '../src/version'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { API_KEY, KNOWN_RUN, SEARCH_QUERY, startMockServer, type MockServer } from './helpers/mock-server'

const RESEARCH_ID = '44444444-4444-4444-8444-444444444444'
const ROUTED_RESEARCH = '66666666-6666-4666-8666-666666666666'
const ROUTED_QUERY = '77777777-7777-4777-8777-777777777777'
let server: MockServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

async function withKey(env: Record<string, string> = {}): Promise<FakeIo> {
  server = await startMockServer({})
  return fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_KEY: API_KEY, ...env })
}

const ratings = () => server!.log.filter((l) => l.path === '/api/platform/v1/feedback').map((l) => JSON.parse(l.body))
const outcomes = () => server!.log.filter((l) => l.path.endsWith('/feedback') && l.path.includes('/messages/optimize/runs/'))

describe('amdahl feedback --rating', () => {
  it('sends a rating as the CLI, for the key owner, with its version, and needs no --evidence', async () => {
    const io = await withKey()
    const r = await cli(io, 'feedback', KNOWN_RUN, '--rating', 'down', '--comment', 'The opener was generic.', '--email-ok')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`Rating saved for ${KNOWN_RUN}. Amdahl may email you about it.\n`)
    expect(ratings()).toEqual([
      {
        answer_id: KNOWN_RUN,
        subject_id: KNOWN_RUN,
        surface: 'optimize',
        rating: 'down',
        client: 'cli',
        client_version: VERSION,
        comment: 'The opener was generic.',
        email_ok: true,
      },
    ])
    expect(outcomes()).toHaveLength(0)
  })

  it('rates a search answer by its query id, and a research answer by its research id', async () => {
    const io = await withKey()
    expect((await cli(io, 'feedback', SEARCH_QUERY, '--rating', 'up', '--surface', 'search')).code).toBe(0)
    expect((await cli(io, 'feedback', RESEARCH_ID, '--rating', 'up', '--surface', 'research', '--json')).json).toMatchObject({ ok: true, surface: 'research', rating: 'up' })
    expect(ratings().map((b) => [b.surface, b.subject_id])).toEqual([
      ['search', SEARCH_QUERY],
      ['research', RESEARCH_ID],
    ])
    expect(ratings()[0]).not.toHaveProperty('comment')
    expect(ratings()[0]).not.toHaveProperty('email_ok')
  })

  it('refuses a bad rating, a bad surface, a message run id that is not one, and the outcome flags beside it (exit 2, nothing sent)', async () => {
    const io = await withKey()
    for (const args of [
      [KNOWN_RUN, '--rating', 'sideways'],
      [KNOWN_RUN, '--rating', 'up', '--surface', 'nowhere'],
      ['not-a-run', '--rating', 'up'],
      ['opt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '--rating', 'up'],
      [KNOWN_RUN, '--rating', 'up', '--outcome', 'used'],
      [KNOWN_RUN, '--rating', 'up', '--evidence', 'inferred'],
      [KNOWN_RUN, '--surface', 'search'],
      [KNOWN_RUN, '--email-ok'],
      ['has space', '--rating', 'up', '--surface', 'other'],
      ['res-1', '--rating', 'up', '--surface', 'research'],
      [KNOWN_RUN, '--rating', 'up', '--email-ok', '--no-email-ok'],
    ]) {
      const r = await cli(io, 'feedback', ...args)
      expect(r.code, args.join(' ')).toBe(2)
    }
    expect(ratings()).toEqual([])
  })

  it('leaves the outcome form as it was: --evidence is still required, and it posts to the run route', async () => {
    const io = await withKey()
    expect((await cli(io, 'feedback', KNOWN_RUN, '--outcome', 'used')).code).toBe(2)
    expect((await cli(io, 'feedback', KNOWN_RUN, '--evidence', 'did_it_myself', '--outcome', 'used')).code).toBe(0)
    expect(outcomes()).toHaveLength(1)
    expect(ratings()).toEqual([])
  })
})

describe('a browser sign-in', () => {
  it('is sent, and the server refusing it (403 credential_not_allowed) becomes the needs-a-key sentence', async () => {
    server = await startMockServer({})
    const io = fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_FEEDBACK_PROMPT: '1' })
    expect((await cli(io, 'login', '--json')).code).toBe(0)
    io.stdoutIsTTY = true
    const r = await cli(io, 'feedback', KNOWN_RUN, '--rating', 'up')
    expect(r.code).toBe(4)
    expect(r.stderr).toContain('A rating needs an API key for now.')
    expect(r.stderr).toContain('amdahl keys create')
    expect(server.log.filter((l) => l.path === '/api/platform/v1/feedback')).toHaveLength(1)
    writeFileSync(join(io.homedir, 'a.md'), 'draft')
    io.answers.push('y')
    const o = await cli(io, 'optimize', join(io.homedir, 'a.md'))
    expect(o.code).toBe(0)
    expect(o.stderr).toContain('Could not save your rating: A rating needs an API key for now.')
    expect(o.stderr).toContain('amdahl keys create --name rating')
  })
})

describe('the "Was this useful?" line', () => {
  async function terminal(env: Record<string, string> = {}): Promise<FakeIo> {
    const io = await withKey(env)
    io.stdoutIsTTY = true
    mkdirSync(io.homedir, { recursive: true })
    writeFileSync(join(io.homedir, 'a.md'), 'draft')
    return io
  }

  it('is off by default: no question after an optimize or a search', async () => {
    const io = await terminal()
    io.answers.push('n')
    await cli(io, 'optimize', join(io.homedir, 'a.md'))
    await cli(io, 'search', 'pricing')
    expect(io.prompts.filter((p) => p.startsWith('Was this useful?'))).toEqual([])
    expect(ratings()).toEqual([])
  })

  it('with AMDAHL_FEEDBACK_PROMPT=1 asks once after an optimize; a no asks what went wrong; Enter skips', async () => {
    const io = await terminal({ AMDAHL_FEEDBACK_PROMPT: '1' })
    io.answers.push('n', 'Too generic.')
    const r = await cli(io, 'optimize', join(io.homedir, 'a.md'))
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual(['Was this useful? [y/n, Enter to skip] ', 'What went wrong? (Enter to skip) '])
    expect(ratings()).toHaveLength(1)
    expect(ratings()[0]).toMatchObject({ surface: 'optimize', rating: 'down', comment: 'Too generic.', client: 'cli', client_version: VERSION })
    expect(r.stderr).toContain('Thanks, saved.')

    io.prompts.length = 0
    io.answers.push('')
    await cli(io, 'optimize', join(io.homedir, 'a.md'))
    expect(io.prompts).toEqual(['Was this useful? [y/n, Enter to skip] '])
    expect(ratings()).toHaveLength(1)
  })

  it('a yes after a search rates it by the query id the search returned', async () => {
    const io = await terminal({ AMDAHL_FEEDBACK_PROMPT: '1' })
    io.answers.push('y')
    expect((await cli(io, 'search', 'pricing')).code).toBe(0)
    expect(ratings()).toEqual([expect.objectContaining({ surface: 'search', subject_id: SEARCH_QUERY, rating: 'up' })])
  })

  it('asks after a finished --research answer and rates it by the research id', async () => {
    const io = await terminal({ AMDAHL_FEEDBACK_PROMPT: '1' })
    io.answers.push('n', 'Missed the pricing calls.')
    const r = await cli(io, 'search', 'why do we lose deals', '--research')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('Deals with a pricing objection closed less often')
    expect(io.prompts).toEqual(['Was this useful? [y/n, Enter to skip] ', 'What went wrong? (Enter to skip) '])
    expect(ratings()).toEqual([
      {
        answer_id: ROUTED_RESEARCH,
        subject_id: ROUTED_RESEARCH,
        research_id: ROUTED_RESEARCH,
        surface: 'research',
        rating: 'down',
        comment: 'Missed the pricing calls.',
        client: 'cli',
        client_version: VERSION,
      },
    ])
    expect(r.stderr).toContain('Thanks, saved.')
  })

  it('a research job the server routed to carries the query id of the search that started it, so the rating links to its run', async () => {
    server = await startMockServer({ routedResearch: { route: 'research', reason: 'counts', signals: [] } })
    const io = fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_KEY: API_KEY, AMDAHL_FEEDBACK_PROMPT: '1' })
    io.stdoutIsTTY = true
    io.answers.push('y')
    expect((await cli(io, 'search', 'how many deals closed last quarter')).code).toBe(0)
    expect(io.prompts).toEqual(['Was this useful? [y/n, Enter to skip] '])
    expect(ratings()).toEqual([expect.objectContaining({ surface: 'research', subject_id: ROUTED_RESEARCH, research_id: ROUTED_RESEARCH, search_query_id: ROUTED_QUERY, rating: 'up' })])
  })

  it('asks after search --research-id reads a finished job, and never with --json', async () => {
    const io = await terminal({ AMDAHL_FEEDBACK_PROMPT: '1' })
    io.answers.push('y')
    expect((await cli(io, 'search', '--research-id', RESEARCH_ID)).code).toBe(0)
    expect(ratings()).toEqual([expect.objectContaining({ surface: 'research', subject_id: RESEARCH_ID, research_id: RESEARCH_ID, rating: 'up' })])
    expect(ratings()[0]).not.toHaveProperty('search_query_id')

    io.prompts.length = 0
    io.answers.push('y')
    expect((await cli(io, 'search', 'why do we lose deals', '--research', '--json')).code).toBe(0)
    expect(io.prompts).toEqual([])
    expect(ratings()).toHaveLength(1)
  })

  it('Ctrl+C at the question after a finished optimize does not change the exit code', async () => {
    const io = await terminal({ AMDAHL_FEEDBACK_PROMPT: '1' })
    io.answers.push(null)
    const r = await cli(io, 'optimize', join(io.homedir, 'a.md'))
    expect(r.code).toBe(0)
    expect(r.stderr).not.toContain('Could not save')
    expect(ratings()).toEqual([])
  })

  it('reads the config setting, and an env of 0 beats it', async () => {
    const io = await terminal()
    mkdirSync(join(configPath(io), '..'), { recursive: true })
    writeFileSync(configPath(io), JSON.stringify({ version: 1, default_profile: null, profiles: {}, feedbackPrompt: true }))
    io.answers.push('y')
    await cli(io, 'optimize', join(io.homedir, 'a.md'))
    expect(ratings()).toHaveLength(1)
    expect(JSON.parse(readFileSync(configPath(io), 'utf8')).feedbackPrompt).toBe(true)

    const off = await terminal({ AMDAHL_FEEDBACK_PROMPT: '0' })
    mkdirSync(join(configPath(off), '..'), { recursive: true })
    writeFileSync(configPath(off), JSON.stringify({ version: 1, default_profile: null, profiles: {}, feedbackPrompt: true }))
    off.answers.push('y')
    await cli(off, 'optimize', join(off.homedir, 'a.md'))
    expect(off.prompts).toEqual([])
  })

  it('asks nothing with --json, off a terminal, in CI or with AMDAHL_NO_PROMPT, and a failed save never changes the exit code', async () => {
    const env = { AMDAHL_FEEDBACK_PROMPT: '1' }
    const json = await terminal(env)
    json.answers.push('y')
    expect((await cli(json, 'optimize', join(json.homedir, 'a.md'), '--json')).code).toBe(0)
    expect(json.prompts).toEqual([])

    const piped = await terminal(env)
    piped.stdoutIsTTY = false
    piped.answers.push('y')
    await cli(piped, 'optimize', join(piped.homedir, 'a.md'))
    expect(piped.prompts).toEqual([])

    const ci = await terminal({ ...env, CI: 'true' })
    await cli(ci, 'optimize', join(ci.homedir, 'a.md'))
    expect(ci.prompts).toEqual([])

    const quiet = await terminal({ ...env, AMDAHL_NO_PROMPT: '1' })
    await cli(quiet, 'optimize', join(quiet.homedir, 'a.md'))
    expect(quiet.prompts).toEqual([])
    expect(ratings()).toEqual([])
  })
})
