// Search follows the server's routing: one line on why research started, the
// research offer (asked at a terminal, told to a sign-in, a command for a
// script), and "For you" with hidden recipes left out and a pending list read
// again. All against the strict mock server.

import { afterEach, describe, expect, it } from 'vitest'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { searchProblem } from './helpers/strict'
import { API_KEY, SUGGESTED_LIBRARY, startMockServer, type MockServer } from './helpers/mock-server'

let server: MockServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

const QUERY_ID = '88888888-8888-4888-8888-888888888888'
const RID = '66666666-6666-4666-8666-666666666666'
const CAUSE_OFFER = 'This asks why. Research can look across your calls and deals for the cause.'

/** What a search that could use research answers: rows, an answer, its query_id, routing and the offer. */
const offered = (extra: Record<string, unknown> = {}) => ({
  success: true,
  mode_ran: 'semantic',
  results: [{ id: 'r1', title: 'Discovery call', speaker: 'Dana', occurred_at: '2026-10-01T10:00:00Z', text: 'Pricing came up twice.' }],
  timing: { total_ms: 5 },
  answer: { status: 'answered', text: 'Buyers raised [pricing](amdahl:cite?block=r1).', citations: [], model: 'm' },
  query_id: QUERY_ID,
  routing: { route: 'both', reason: 'cause', signals: ['why'] },
  research_offer: { reason: CAUSE_OFFER },
  ...extra,
})

/** The scopes of a Customer agent key (`--preset agent`): it can start research. */
const AGENT_SCOPES = ['data:read', 'connections:read', 'messages:execute', 'conversations:write']
/** The scopes of `--preset optimize` (the server's `mcp_optimize`): search and optimize, no research. */
const OPTIMIZE_SCOPES = ['data:read', 'connections:read', 'messages:execute']

async function withKey(options: Parameters<typeof startMockServer>[0] = {}, atTerminal = false): Promise<FakeIo> {
  server = await startMockServer({ scopes: AGENT_SCOPES, ...options })
  const io = fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_KEY: API_KEY })
  io.stdoutIsTTY = atTerminal
  return io
}

async function signedIn(options: Parameters<typeof startMockServer>[0] = {}): Promise<FakeIo> {
  server = await startMockServer(options)
  const io = fakeIo({ AMDAHL_API_URL: server.url })
  expect((await cli(io, 'login', '--json')).code).toBe(0)
  io.opened.length = 0
  io.stdoutIsTTY = true
  return io
}

const posts = (path = '/search/query') => server!.log.filter((l) => l.method === 'POST' && l.path.endsWith(path)).map((l) => JSON.parse(l.body))
const reads = (suffix: string) => server!.log.filter((l) => l.path.endsWith(suffix))

describe('search says why the server started research', () => {
  const REASONS: [string, string][] = [
    ['deal_facts', 'Amdahl is researching this: it needs your deal records.'],
    ['counts', 'Amdahl is researching this: it asks for counts across your deals.'],
    ['statistical', 'Amdahl is researching this: it tests what leads to wins.'],
    ['comparison', 'Amdahl is researching this: it compares groups.'],
    ['cause', 'Amdahl is researching this: it asks why.'],
    ['multi_step', 'Amdahl is researching this: it takes several steps.'],
    ['long_query', 'Amdahl is researching this: it is longer than a search reads.'],
    ['recipe', 'Amdahl is researching this: it is a ready-made question that needs research.'],
    ['written_answer', 'Amdahl is researching this: it asks for a written answer.'],
    ['a_reason_from_a_newer_server', 'Amdahl is researching this.'],
  ]

  it.each(REASONS)('reason %s prints one line before the wait and sends no route', async (reason, line) => {
    const io = await withKey({ routedResearch: { route: 'research', reason, signals: [] } })
    const r = await cli(io, 'search', 'how many deals closed last quarter')
    expect(r.code).toBe(0)
    expect(r.stderr).toBe(`${line}\nAmdahl started research on it. This can take a few minutes.\nResearch id: ${RID}\nRead it later:\n  amdahl search --research-id ${RID}\n`)
    expect(r.stdout).toContain('Deals with a pricing objection closed less often')
    expect(posts()).toEqual([{ query: 'how many deals closed last quarter', answer: true }])
  })

  it('--research says nothing about routing, and --json adds nothing to the server fields', async () => {
    const io = await withKey({ routedResearch: { route: 'research', reason: 'counts', signals: [] } })
    const asked = await cli(io, 'search', 'how many deals', '--research')
    expect(asked.stderr.startsWith('Amdahl started research on it.')).toBe(true)
    const json = await cli(io, 'search', 'how many deals', '--json')
    expect(json.stderr).toBe('')
    expect(json.json).toMatchObject({ ok: true, query_id: '77777777-7777-4777-8777-777777777777', routing: { route: 'research', reason: 'counts' }, research: { research_id: RID, status: 'complete' } })
  })
})

describe('the research offer', () => {
  it('a person at a terminal with a key is asked once, and a yes starts research linked to the answer', async () => {
    const io = await withKey({ searchResult: offered() }, true)
    io.answers = ['y']
    const r = await cli(io, 'search', 'why do deals die')
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([`${CAUSE_OFFER} Research it? [y/N] `])
    expect(posts()).toEqual([
      { query: 'why do deals die', answer: true },
      { query: 'why do deals die', answer: true, route: 'research', from_query_id: QUERY_ID },
    ])
    expect(r.stderr).toBe(`Amdahl started research on it. This can take a few minutes.\nResearch id: ${RID}\nRead it later:\n  amdahl search --research-id ${RID}\n`)
    expect(r.stdout.startsWith('Buyers raised pricing.\n')).toBe(true)
    expect(r.stdout).toContain('Deals with a pricing objection closed less often')
    expect(r.stdout).toContain('Ask next:\n- Which competitor came up most?')
  })

  it('Enter, or anything but yes, ends as today: one request, the search answer, exit 0', async () => {
    for (const answer of ['', 'n', 'no']) {
      const io = await withKey({ searchResult: offered() }, true)
      io.answers = [answer]
      const r = await cli(io, 'search', 'why do deals die')
      expect(r.code).toBe(0)
      expect(io.prompts).toHaveLength(1)
      expect(posts()).toEqual([{ query: 'why do deals die', answer: true }])
      expect(r.stdout).toContain('Buyers raised pricing.')
      expect(r.stdout).not.toContain('Deals with a pricing objection')
      await server!.close()
    }
  })

  it('a yes without a query_id sends no from_query_id', async () => {
    const result = offered()
    delete (result as Record<string, unknown>).query_id
    const io = await withKey({ searchResult: result }, true)
    io.answers = ['yes']
    expect((await cli(io, 'search', 'why do deals die')).code).toBe(0)
    expect(posts()[1]).toEqual({ query: 'why do deals die', answer: true, route: 'research' })
  })

  it('--research on a question that just ran sends route research and no from_query_id', async () => {
    const io = await withKey({ searchResult: offered() }, true)
    const r = await cli(io, 'search', 'why do deals die', '--research')
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([])
    expect(posts()).toEqual([{ query: 'why do deals die', answer: true, route: 'research' }])
  })

  it('an optimize-only key is not asked: it gets the reason and the key line, and sends one search', async () => {
    const io = await withKey({ searchResult: offered(), scopes: OPTIMIZE_SCOPES }, true)
    const r = await cli(io, 'search', 'why do deals die')
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([])
    expect(r.stderr).toBe(`${CAUSE_OFFER}\nResearch needs a Customer agent key: amdahl keys create --name research --preset agent\n`)
    expect(posts()).toHaveLength(1)
    expect(reads('/me/context')).toHaveLength(1)
  })

  it('a failed scope read falls back to the key line and asks nothing', async () => {
    const io = await withKey({ searchResult: offered(), failMeContext: true }, true)
    const r = await cli(io, 'search', 'why do deals die')
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([])
    expect(r.stderr).toBe(`${CAUSE_OFFER}\nResearch needs a Customer agent key: amdahl keys create --name research --preset agent\n`)
    expect(posts()).toHaveLength(1)
  })

  it('reads no scopes when nothing is asked: no offer, --json, or a script', async () => {
    const none = await withKey({}, true)
    await cli(none, 'search', 'why do deals die')
    await server!.close()
    const json = await withKey({ searchResult: offered() }, true)
    await cli(json, 'search', 'why do deals die', '--json')
    expect(reads('/me/context')).toHaveLength(0)
    await server!.close()
    const piped = await withKey({ searchResult: offered() }, false)
    await cli(piped, 'search', 'why do deals die')
    expect(reads('/me/context')).toHaveLength(0)
  })

  it('says Searching... before the research request a yes starts', async () => {
    const io = await withKey({ searchResult: offered() }, true)
    io.stderrIsTTY = true
    io.answers = ['y']
    const r = await cli(io, 'search', 'why do deals die')
    expect(r.code).toBe(0)
    expect(r.stderr.startsWith('Searching...\nSearching...\nAmdahl started research on it.')).toBe(true)
    expect(posts()).toHaveLength(2)
  })

  it('a refused handoff after a yes prints only the key line, not the answer again', async () => {
    const io = await withKey({ searchResult: offered(), researchRefused: true }, true)
    io.answers = ['y']
    const r = await cli(io, 'search', 'why do deals die')
    expect(r.code).toBe(0)
    expect(posts()).toHaveLength(2)
    expect(r.stdout.match(/Buyers raised pricing/g)).toHaveLength(1)
    expect(r.stderr).toBe('Research needs a Customer agent key: amdahl keys create --name research --preset agent\n')
  })

  it('a sign-in is not asked: one line names the key that can research', async () => {
    const io = await signedIn({ searchResult: offered() })
    const r = await cli(io, 'search', 'why do deals die')
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([])
    expect(r.stderr).toBe(`${CAUSE_OFFER}\nResearch needs a Customer agent key: amdahl keys create --name research --preset agent\n`)
    expect(posts()).toHaveLength(1)
  })

  it('a script (no terminal, AMDAHL_NO_PROMPT, an agent) is given the command and no question', async () => {
    const command = `Run it as research: amdahl search 'why do deals die' --research\n`
    const piped = await withKey({ searchResult: offered() }, false)
    const a = await cli(piped, 'search', 'why do deals die')
    expect(a.stderr).toBe(`${CAUSE_OFFER}\n${command}`)
    expect(piped.prompts).toEqual([])
    await server!.close()
    const quiet = await withKey({ searchResult: offered() }, true)
    quiet.env.AMDAHL_NO_PROMPT = '1'
    expect((await cli(quiet, 'search', 'why do deals die')).stderr).toBe(`${CAUSE_OFFER}\n${command}`)
    await server!.close()
    const agent = await withKey({ searchResult: offered() }, true)
    agent.env.CLAUDECODE = '1'
    expect((await cli(agent, 'search', "why do Acme's deals die")).stderr).toBe(`${CAUSE_OFFER}\nRun it as research: amdahl search 'why do Acme'\\''s deals die' --research\n`)
    expect(posts()).toHaveLength(1)
  })

  it('--json passes the server fields through, asks nothing and adds nothing', async () => {
    const io = await withKey({ searchResult: offered() }, true)
    const r = await cli(io, 'search', 'why do deals die', '--json')
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
    expect(io.prompts).toEqual([])
    expect(r.json).toMatchObject({ ok: true, query_id: QUERY_ID, research_offer: { reason: CAUSE_OFFER }, routing: { route: 'both', reason: 'cause' } })
    expect(posts()).toHaveLength(1)
  })

  it('with no rows, the offer is the one next step: the old --research hint is not said too', async () => {
    const empty = { results: [], answer: { status: 'no_answer' }, detail: { message: 'Nothing in the data says why.' } }
    const io = await withKey({ searchResult: offered(empty) }, false)
    const r = await cli(io, 'search', 'why do deals die')
    expect(r.stdout).not.toContain('add --research')
    expect(r.stderr).toBe(`${CAUSE_OFFER}\nRun it as research: amdahl search 'why do deals die' --research\n`)
    await server!.close()
    const old = await withKey({ searchResult: offered({ ...empty, research_offer: undefined }) }, false)
    expect((await cli(old, 'search', 'why do deals die')).stdout).toContain('add --research')
  })

  it('a server that sends no offer gets today\'s output', async () => {
    const io = await withKey({}, true)
    const r = await cli(io, 'search', 'why do deals die')
    expect(r.stderr).toBe('')
    expect(io.prompts).toEqual([])
  })

  it('the strict server takes from_query_id only as a uuid', () => {
    expect(searchProblem({ query: 'q', route: 'research', from_query_id: QUERY_ID })).toBeNull()
    expect(searchProblem({ query: 'q', route: 'research', from_query_id: 'nope' })).toBe('Invalid search request: from_query_id: Invalid uuid')
  })
})

describe('recipes: For you', () => {
  const FOR_YOU = [
    { recipe_id: 'why-deals-die', kind: 'try', reason: '1 deal lost in the last 90 days', fills: {} },
    { recipe_id: 'account-brief', kind: 'try', reason: 'Acme has a call tomorrow', fills: { account: 'Acme' } },
  ]

  it('leaves out a recipe hidden in the console, and keeps it in the library list', async () => {
    const io = await signedIn({ suggestions: { for_you: FOR_YOU, hidden_recipe_ids: ['why-deals-die'] } })
    const r = await cli(io, 'recipes')
    const head = r.stdout.slice(0, r.stdout.indexOf('\nAccounts\n'))
    expect(head).toContain('account-brief')
    expect(head).not.toContain('why-deals-die')
    expect(r.stdout).toContain('why-deals-die')
    expect((await cli(io, 'recipes', '--json')).json.for_you.map((s: { recipe_id: string }) => s.recipe_id)).toEqual(['account-brief'])
  })

  it('a pending list is read again at a terminal, 2 s apart, and shows what came back', async () => {
    const io = await signedIn({ suggestions: { for_you: FOR_YOU }, suggestionsPendingReads: 2 })
    const r = await cli(io, 'recipes')
    expect(r.code).toBe(0)
    expect(reads('/search/suggestions')).toHaveLength(3)
    expect(r.stdout).toContain('For you\n  why-deals-die')
  })

  it('a list that stays pending is read at most 3 more times, then shown without For you', async () => {
    const io = await signedIn({ suggestions: { for_you: FOR_YOU }, suggestionsPendingReads: 99 })
    const r = await cli(io, 'recipes')
    expect(r.code).toBe(0)
    expect(reads('/search/suggestions')).toHaveLength(4)
    expect(r.stdout).not.toContain('For you')
  })

  it('--json and a script read once and say it is pending', async () => {
    const io = await signedIn({ suggestions: { for_you: FOR_YOU }, suggestionsPendingReads: 99 })
    const json = await cli(io, 'recipes', '--json')
    expect(json.json).toMatchObject({ ok: true, pending: true, for_you: [] })
    expect(reads('/search/suggestions')).toHaveLength(1)
    io.env.AMDAHL_NO_PROMPT = '1'
    await cli(io, 'recipes')
    expect(reads('/search/suggestions')).toHaveLength(2)
  })
})
