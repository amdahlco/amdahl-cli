// The commands that make the terminal a full way in: search (and the research
// it starts), connections, connect, open, the list optimize, feedback, sent,
// and the next steps status and optimize print. All against the mock server.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { asciiTable, blockLines, wrapCell } from '../src/blocks'
import { neutralise, parseCsv, progressLine, resultsPath, toCsv } from '../src/commands/batch'
import { plainMarkdown, wrap } from '../src/text'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { API_KEY, startMockServer, type MockServer } from './helpers/mock-server'

let server: MockServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

/** Signed in through the browser: a CLI OAuth token (no research scopes). */
async function signedIn(options: Parameters<typeof startMockServer>[0] = {}): Promise<FakeIo> {
  server = await startMockServer(options)
  const io = fakeIo({ AMDAHL_API_URL: server.url })
  expect((await cli(io, 'login', '--json')).code).toBe(0)
  io.opened.length = 0
  return io
}

/** An API key in AMDAHL_KEY (a Customer agent key: it can start research and read it back). */
async function withKey(options: Parameters<typeof startMockServer>[0] = {}): Promise<FakeIo> {
  server = await startMockServer(options)
  return fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_KEY: API_KEY })
}

const sentBody = (path: string) => JSON.parse(server!.log.filter((l) => l.path === path).at(-1)?.body ?? '{}')
const requests = (suffix: string) => server!.log.filter((l) => l.path.endsWith(suffix))

describe('search', () => {
  it('prints the cited answer in plain words, then the rows it came from; --json is the server answer', async () => {
    const io = await signedIn()
    const r = await cli(io, 'search', 'what', 'did', 'buyers', 'say?')
    expect(r.code).toBe(0)
    expect(sentBody('/api/platform/v1/search/query')).toEqual({ query: 'what did buyers say?', answer: true })
    expect(r.stdout).toBe(
      [
        'Buyers raised pricing and annual billing.',
        '',
        'From:',
        '1. Discovery call, Dana, 2026-10-01',
        '   Pricing came up twice.',
        '2. Renewal call, Sam, 2026-10-08',
        '   They asked for annual billing.',
        '',
      ].join('\n')
    )
    for (const line of r.stdout.split('\n')) expect(line.length).toBeLessThanOrEqual(80)
    const json = await cli(io, 'search', 'pricing', '--json')
    expect(json.json).toMatchObject({ ok: true, success: true, mode_ran: 'semantic', results: [{ id: 'r1' }, { id: 'r2' }] })
    expect(json.stderr).toBe('')
  })

  it('--research with a sign-in: the search answer, and one line on the key that gives a deeper one', async () => {
    const io = await signedIn()
    const r = await cli(io, 'search', 'why do we lose?', '--research')
    expect(r.code).toBe(0)
    expect(sentBody('/api/platform/v1/search/query')).toMatchObject({ query: 'why do we lose?', route: 'research' })
    expect(r.stdout).toContain('1. Discovery call, Dana, 2026-10-01')
    expect(r.stderr).toBe('A deeper answer needs a Customer agent key: amdahl keys create --name research --preset agent\n')
    expect(requests('/research/66666666-6666-4666-8666-666666666666')).toEqual([])
  })

  it('--research with an agent key waits on the job and prints its cited answer', async () => {
    const io = await withKey({ researchPolls: 2 })
    const r = await cli(io, 'search', 'why do we lose?', '--research')
    expect(r.code).toBe(0)
    const reads = requests('/research/66666666-6666-4666-8666-666666666666')
    expect(reads).toHaveLength(3)
    expect(reads[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`)
    expect(server!.log.find((l) => l.path.includes('/research/'))?.path).toBe('/api/platform/v1/research/66666666-6666-4666-8666-666666666666')
    expect(r.stdout).toBe('Deals with a pricing objection closed less often.\n\nAsk next:\n- Which competitor came up most?\n')
    expect(r.stderr).toBe('Amdahl started research on it. This can take a few minutes.\n')
    const json = await cli(io, 'search', 'why?', '--research', '--json')
    expect(json.json).toMatchObject({ ok: true, mode_ran: 'research', research: { status: 'complete', answer: { partial: false } } })
  })

  it('a research answer keeps its paragraphs and lists, wrapped to 80 columns, with control characters gone', async () => {
    const long = 'The two lost deals name no rival product in any call, and that holds for both accounts we read in full.'
    const text = `**Short answer.** ${long}\n\n\n\nWhat the data shows:\n- Cobalt: a [call recap](amdahl:cite?block=b1) after the close date, with a long list item that has to wrap onto a second line.\n- Alder: first call\u001b[2J later.\r\n\nGaps: none.`
    const io = await withKey({ researchText: text })
    const r = await cli(io, 'search', 'why do we lose?', '--research')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(
      [
        'Short answer. The two lost deals name no rival product in any call, and that',
        'holds for both accounts we read in full.',
        '',
        'What the data shows:',
        '- Cobalt: a call recap after the close date, with a long list item that has to',
        '  wrap onto a second line.',
        '- Alder: first call[2J later.',
        '',
        'Gaps: none.',
        '',
        'Ask next:',
        '- Which competitor came up most?',
        '',
      ].join('\n')
    )
    expect(r.stdout).not.toContain('\u001b')
    for (const line of r.stdout.split('\n')) expect(line.length).toBeLessThanOrEqual(80)
  })

  it('prints the answer\'s content blocks after it, in the order the job presented them', async () => {
    const answer = 'Two deals closed lost, and neither names a rival product.'
    const blocks = [
      { id: 'answer-text', type: 'text', markdown: answer },
      { id: 'b1', type: 'table', title: 'Closed lost deals', columns: [{ key: 'account', label: 'Account' }, { key: 'stage', label: 'Stage' }, { key: 'amount', label: 'Amount' }], query: { kind: 'data.query', sql: 'select 1' }, data: [{ account: 'Cobalt Payments', stage: 'Closed Lost', amount: 85000 }, { account: 'Alder Health', stage: 'Closed Lost', amount: null }] },
      { id: 'b2', type: 'text', markdown: 'Both losses carry the **same** timestamp, [a backfill sign](amdahl:cite?block=b1), and <unverified>2</unverified> deals.' },
      { id: 'b3', type: 'text', markdown: answer },
      { id: 'b4', type: 'metric', label: 'Lost deals', data: { value: 2, delta: 'was 0 last quarter' } },
      { id: 'b5', type: 'citation', kind: 'utterance', ref: 'utt_1', label: 'Cobalt call, Oct 20', snippet: 'We already moved the budget.' },
      { id: 'b6', type: 'callout', tone: 'warn', markdown: 'Two deals is a small sample.' },
      { id: 'b7', type: 'cluster_finding', cluster_id: 'c1', label: 'Budget moved', insight: 'Buyers shift budget mid-cycle.', conversations: 12, period_label: 'last 90 days', status: 'rising' },
      { id: 'b8', type: 'chart_spec', title: 'Deals by stage', chart_type: 'bar', encoding: { x: 'stage', y: 'deals' }, query: { kind: 'named', named_id: 'q' }, data: [{ stage: 'won', deals: 4 }, { stage: 'lost', deals: 2 }] },
      { id: 'b9', type: 'sparkle', anything: true },
    ]
    const io = await withKey({ researchText: answer, researchBlocks: blocks })
    const r = await cli(io, 'search', 'why?', '--research')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(
      [
        answer,
        '',
        'Details:',
        'Closed lost deals:',
        '| Account         | Stage       | Amount |',
        '|-----------------|-------------|--------|',
        '| Cobalt Payments | Closed Lost | 85000  |',
        '| Alder Health    | Closed Lost |        |',
        '',
        'Both losses carry the same timestamp, a backfill sign, and 2 (unverified) deals.',
        '',
        'Lost deals: 2 (was 0 last quarter)',
        '',
        '- Cobalt call, Oct 20',
        '  "We already moved the budget."',
        '',
        'Warning: Two deals is a small sample.',
        '',
        'Budget moved (12 conversations in last 90 days, rising): Buyers shift budget',
        'mid-cycle.',
        '',
        '"Deals by stage", a bar chart of 2 rows, is not drawn here. Add --json for its',
        'data.',
        '',
        'A "sparkle" block is not shown here. Add --json to see it.',
        '',
        'Ask next:',
        '- Which competitor came up most?',
        '',
      ].join('\n')
    )
    // The answer's own block (answer-text) and a text block that repeats the answer are not printed again.
    expect(r.stdout.split(answer).length).toBe(2)
    for (const line of r.stdout.split('\n')) expect(line.length).toBeLessThanOrEqual(80)
    // --json is the job as the server sent it, blocks and all.
    const json = await cli(io, 'search', 'why?', '--research', '--json')
    expect(json.json.research.answer.content_blocks).toHaveLength(blocks.length)
  })

  it('a workspace with nothing connected prints the message and link, then the connect command', async () => {
    const setup = {
      success: true,
      mode_ran: 'fuzzy',
      results: [],
      setup_needed: { reason: 'no_sources_connected', message: 'This workspace has no data connected yet. Connect it at https://console.example/acme/settings/connections.', connect_url: 'https://console.example/acme/settings/connections' },
    }
    const io = await signedIn({ searchResult: setup })
    const r = await cli(io, 'search', 'anything')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(
      'This workspace has no data connected yet. Connect it at\nhttps://console.example/acme/settings/connections.\nConnect your CRM or call recorder: amdahl connect\n'
    )
    expect((await cli(io, 'search', 'anything', '--json')).json.setup_needed.reason).toBe('no_sources_connected')
  })

  it('names a deal row by its stage and amount and a call row by its date (the fuzzy lane field names)', async () => {
    const io = await signedIn({
      searchResult: {
        success: true,
        results: [
          { deal_id: '1', deal_name: 'Pinecrest - Lab pilot', deal_stage_label: 'Presentation Scheduled', deal_amount: 12000, close_date: '2026-12-29T00:00:00.000Z' },
          { parent_interaction_id: '2', company_name: 'Hubspot', call_timestamp: '2026-10-13T18:31:21.414Z' },
        ],
      },
    })
    expect((await cli(io, 'search', 'deals')).stdout).toBe('1. Pinecrest - Lab pilot, Presentation Scheduled, 12000, 2026-12-29\n2. Hubspot, 2026-10-13\n')
  })

  it('no rows: the freshness line, or "Nothing matched."; no question is a usage error', async () => {
    const io = await signedIn({ searchResult: { success: true, results: [], data_freshness: { message: 'No matches. Latest conversation 2026-11-01; last sync 2026-11-02.' } } })
    expect((await cli(io, 'search', 'x')).stdout).toBe('No matches. Latest conversation 2026-11-01; last sync 2026-11-02.\n')
    server!.options.searchResult = { success: true, results: [] }
    expect((await cli(io, 'search', 'x')).stdout).toBe('Nothing matched.\n')
    const r = await cli(io, 'search')
    expect(r.code).toBe(2)
    expect((await cli(io, 'search', 'x', '--limit', 'ten')).code).toBe(2)
  })

  it('not signed in exits 3', async () => {
    server = await startMockServer()
    expect((await cli(fakeIo({ AMDAHL_API_URL: server.url }), 'search', 'x')).code).toBe(3)
  })
})

describe('connections, connect and open', () => {
  it('lists each connection with its health in words, and where to fix the one that needs it', async () => {
    const io = await signedIn()
    const r = await cli(io, 'connections')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(
      [
        'HubSpot             crm    healthy        synced 2026-11-11',
        'Gong (Sales calls)  calls  needs sign-in  never synced',
        'Sign in to it again: http://localhost:4000/acme/connections/c1',
        '',
      ].join('\n')
    )
    expect((await cli(io, 'connections', '--json')).json).toMatchObject({ ok: true, connections: [{ id: 'c0' }, { id: 'c1' }] })
    await cli(io, 'connections', '--all')
    expect(server!.log.at(-1)?.path).toBe('/api/platform/v1/connections')
    expect(requests('/connections').length).toBe(3)
  })

  it('with nothing connected, says so and names `amdahl connect`', async () => {
    const io = await signedIn({ connections: [] })
    expect((await cli(io, 'connections')).stdout).toBe('No data connected yet.\nConnect your CRM or call recorder: amdahl connect\n')
  })

  it('connect checks the connector in the catalog, then opens the console add page for it', async () => {
    const io = await signedIn()
    const r = await cli(io, 'connect', 'HubSpot')
    expect(r.code).toBe(0)
    expect(io.opened).toEqual(['http://localhost:4000/acme/settings/connections?add=1&connector=hubspot'])
    expect(r.stderr).toBe('Opened the console to connect HubSpot. Finish there; then check it with `amdahl connections`.\n')
    expect(requests('/connections/catalog')).toHaveLength(1)
    // The CLI never creates a connection itself.
    expect(server!.log.filter((l) => l.method === 'POST' && l.path.includes('/connections'))).toEqual([])
  })

  it('connect --no-browser prints the link; bare connect opens the add page without a catalog read', async () => {
    const io = await signedIn()
    const r = await cli(io, 'connect', 'gong', '--no-browser')
    expect(io.opened).toEqual([])
    expect(r.stdout).toBe('http://localhost:4000/acme/settings/connections?add=1&connector=gong\n')
    expect(r.stderr).toBe('Open this link to connect Gong:\n')
    const before = requests('/connections/catalog').length
    const bare = await cli(io, 'connect', '--json', '--no-browser')
    expect(bare.json).toEqual({ ok: true, url: 'http://localhost:4000/acme/settings/connections?add=1', opened: false, connector: null })
    expect(requests('/connections/catalog').length).toBe(before)
  })

  it('an unknown connector is a usage error that lists them; one not offered yet exits 1', async () => {
    const io = await signedIn()
    const r = await cli(io, 'connect', 'fax')
    expect(r.code).toBe(2)
    expect(r.stderr).toBe('Error: Amdahl has no connector called "fax".\nConnectors: hubspot, gong\n')
    const planned = await cli(io, 'connect', 'slack')
    expect(planned.code).toBe(1)
    expect(planned.stderr).toContain("Slack can't be connected yet: it is coming soon.")
    expect(io.opened).toEqual([])
  })

  it('open: the workspace in the console; --no-browser prints it; not signed in, the console home', async () => {
    const io = await signedIn()
    expect((await cli(io, 'open')).stderr).toBe('Opened your workspace in your browser.\n')
    expect(io.opened).toEqual(['http://localhost:4000/acme'])
    expect((await cli(io, 'open', '--no-browser')).stdout).toBe('http://localhost:4000/acme\n')
    // The stored sign-in names the workspace: no request.
    expect(requests('/me/context').filter((l) => l.headers.authorization)).toHaveLength(1)
    const out = fakeIo({ AMDAHL_API_URL: server!.url })
    expect((await cli(out, 'open', '--json', '--no-browser')).json).toEqual({ ok: true, url: 'http://localhost:4000', opened: false, workspace: null })
    const key = fakeIo({ AMDAHL_API_URL: server!.url, AMDAHL_KEY: API_KEY })
    expect((await cli(key, 'open', '--no-browser')).stdout).toBe('http://localhost:4000/acme\n')
  })
})

describe('connect and open launch a browser only for a person at a terminal', () => {
  const url = 'http://localhost:4000/acme/settings/connections?add=1&connector=hubspot'

  it.each<[string, (io: FakeIo) => void]>([
    ['--json', () => {}],
    ['an agent (CLAUDECODE)', (io) => void (io.env.CLAUDECODE = '1')],
    ['an agent (CURSOR_AGENT)', (io) => void (io.env.CURSOR_AGENT = '1')],
    ['CI', (io) => void (io.env.CI = 'true')],
    ['no terminal on stdin', (io) => void (io.stdinIsTTY = false)],
    ['AMDAHL_NO_PROMPT=1', (io) => void (io.env.AMDAHL_NO_PROMPT = '1')],
  ])('%s: connect and open print the link and open nothing', async (label, setup) => {
    const io = await signedIn()
    setup(io)
    const json = label === '--json'
    const connect = await cli(io, 'connect', 'hubspot', ...(json ? ['--json'] : []))
    expect(connect.code).toBe(0)
    if (json) expect(connect.json).toEqual({ ok: true, url, opened: false, connector: 'hubspot' })
    else expect(connect.stdout).toBe(`${url}\n`)
    const open = await cli(io, 'open', ...(json ? ['--json'] : []))
    expect(open.code).toBe(0)
    if (json) expect(open.json).toEqual({ ok: true, url: 'http://localhost:4000/acme', opened: false, workspace: 'acme' })
    else expect(open.stdout).toBe('http://localhost:4000/acme\n')
    expect(io.opened).toEqual([])
    // --json prints no machine event either: nothing was opened.
    expect(connect.stderr + open.stderr).not.toContain('open_url')
  })

  it('a person at a terminal still gets the browser', async () => {
    const io = await signedIn()
    expect((await cli(io, 'connect', 'hubspot')).code).toBe(0)
    expect(io.opened).toEqual([url])
  })
})

describe('optimize --list', () => {
  it('sends a CSV as one batch with the flags as defaults, shows progress and writes the results beside it', async () => {
    const io = await signedIn({ batchPolls: 2 })
    const list = join(io.cwd, 'drafts.csv')
    writeFileSync(list, 'item_id,message,facts\ndana,"Hi Dana, quick one",Dana runs ops\nsam,"Hi Sam\nsecond line","Sam is new\nSam likes golf"\n')
    const r = await cli(io, 'optimize', '--list', list, '--channel', 'linkedin')
    expect(r.code).toBe(0)
    expect(sentBody('/api/platform/v1/messages/optimize/batch')).toEqual({
      items: [
        { item_id: 'dana', message: 'Hi Dana, quick one', context: { facts: ['Dana runs ops'] }, channel: 'linkedin' },
        { item_id: 'sam', message: 'Hi Sam\nsecond line', context: { facts: ['Sam is new', 'Sam likes golf'] }, channel: 'linkedin' },
      ],
    })
    const id = server!.log.find((l) => l.path.includes('/batches/'))?.path.split('/').at(-1)
    expect(r.stderr).toBe(
      [
        `Queued 2 messages as batch ${id}.`,
        `Ctrl+C stops waiting, not the batch. To pick it up later: amdahl optimize --list ${list} --batch ${id}`,
        'Queued behind 3 items: 0 of 2 done, about 5 min left',
        '2 of 2 done',
        '2 of 2 messages optimized.',
        '',
      ].join('\n')
    )
    const out = join(io.cwd, 'drafts.optimized.csv')
    expect(r.stdout).toBe(`Results: ${out}\n`)
    expect(parseCsv(readFileSync(out, 'utf8')).rows).toEqual([
      ['item_id', 'message', 'facts', 'optimized_message', 'status', 'what_changed', 'run_id', 'error'],
      ['dana', 'Hi Dana, quick one', 'Dana runs ops', 'better: Hi Dana, quick one', 'done', 'Cut the opener.', 'run-0', ''],
      ['sam', 'Hi Sam\nsecond line', 'Sam is new\nSam likes golf', 'better: Hi Sam\nsecond line', 'done', 'Cut the opener.', 'run-1', ''],
    ])
  })

  it('a JSONL list sends each line as an item; --json prints every item and writes no file', async () => {
    const io = await signedIn()
    const list = join(io.cwd, 'drafts.jsonl')
    writeFileSync(list, '{"message":"one","evidence":"workspace"}\n\n{"message":"two"}\n')
    const r = await cli(io, 'optimize', '--list', list, '--json', '--evidence', 'off')
    expect(r.code).toBe(0)
    expect(sentBody('/api/platform/v1/messages/optimize/batch').items).toEqual([
      { message: 'one', evidence: 'workspace' },
      { message: 'two', evidence: 'off' },
    ])
    expect(r.json).toMatchObject({ ok: true, status: 'completed', items: [{ index: 0, status: 'done', result: { message: 'better: one' } }, { index: 1 }] })
    expect(existsSync(join(io.cwd, 'drafts.optimized.jsonl'))).toBe(false)
  })

  it('reads the results page by page', async () => {
    const io = await signedIn()
    const list = join(io.cwd, 'many.jsonl')
    writeFileSync(list, Array.from({ length: 130 }, (_, i) => JSON.stringify({ message: `m${i}` })).join('\n'))
    expect((await cli(io, 'optimize', '--list', list)).code).toBe(0)
    const lines = readFileSync(join(io.cwd, 'many.optimized.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(130)
    expect(JSON.parse(lines[129] ?? '{}')).toMatchObject({ index: 129, result: { message: 'better: m129' } })
  })

  it('a failed item exits 1 and says how many; its row says why', async () => {
    const io = await signedIn({ batchFailures: [1] })
    const list = join(io.cwd, 'd.csv')
    writeFileSync(list, 'message\na\nb\n')
    const r = await cli(io, 'optimize', '--list', list)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('1 of 2 messages optimized, 1 failed.')
    expect(parseCsv(readFileSync(join(io.cwd, 'd.optimized.csv'), 'utf8')).rows[2]).toEqual(['b', '', 'failed', '', '', 'optimizer_error: It failed.'])
  })

  it('refuses a column it does not read, a bad line and an empty list, before sending anything', async () => {
    const io = await signedIn()
    const list = join(io.cwd, 'd.csv')
    writeFileSync(list, 'message,email\nhi,a@b.c\n')
    const r = await cli(io, 'optimize', '--list', list)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain(`${list} has a column Amdahl doesn't read: "email".`)
    writeFileSync(list, 'message,channel\nhi\n')
    expect((await cli(io, 'optimize', '--list', list)).stderr).toContain('Line 2 of')
    writeFileSync(list, 'message\n')
    expect((await cli(io, 'optimize', '--list', list)).stderr).toContain('has no messages.')
    writeFileSync(join(io.cwd, 'x.jsonl'), '{"message":"a"}\nnot json\n')
    expect((await cli(io, 'optimize', '--list', join(io.cwd, 'x.jsonl'))).stderr).toContain('Line 2 of')
    expect(requests('/messages/optimize/batch')).toEqual([])
  })

  it('a refused item names its line in the list', async () => {
    const io = await signedIn()
    const list = join(io.cwd, 'x.jsonl')
    writeFileSync(list, '{"message":"a"}\n\n{"channel":"email"}\n')
    const r = await cli(io, 'optimize', '--list', list)
    expect(r.code).toBe(1)
    expect(r.stderr).toBe(`Error: Input failed schema validation: $.items[1].message: Required\nitems[1] is line 3 of ${list}.\n`)
  })

  it('--no-wait queues and prints the batch id; --batch picks it up later', async () => {
    const io = await signedIn()
    const list = join(io.cwd, 'd.csv')
    writeFileSync(list, 'message\na\n')
    const queued = await cli(io, 'optimize', '--list', list, '--no-wait')
    expect(queued.code).toBe(0)
    const id = /batch (\S+)\./.exec(queued.stdout)?.[1] ?? ''
    expect(queued.stdout).toBe(`Queued 1 message as batch ${id}.\nGet the results: amdahl optimize --list ${list} --batch ${id}\n`)
    expect(requests(`/batches/${id}`)).toEqual([])
    const picked = await cli(io, 'optimize', '--list', list, '--batch', id)
    expect(picked.code).toBe(0)
    expect(requests('/messages/optimize/batch')).toHaveLength(1)
    expect(readFileSync(join(io.cwd, 'd.optimized.csv'), 'utf8')).toContain('better: a')
    // With no list, the items go to <id>.optimized.jsonl here.
    expect((await cli(io, 'optimize', '--batch', id)).stdout).toBe(`Results: ${join(io.cwd, `${id}.optimized.jsonl`)}\n`)
  })

  it('starts a results cell that a spreadsheet would run as a formula with a quote', async () => {
    const io = await signedIn({ batchMessage: '+cmd|calc' })
    const list = join(io.cwd, 'f.csv')
    writeFileSync(list, 'item_id,message\n-5,=1+1\nok,"@me and a normal one"\n')
    expect((await cli(io, 'optimize', '--list', list)).code).toBe(0)
    expect(parseCsv(readFileSync(join(io.cwd, 'f.optimized.csv'), 'utf8')).rows.slice(1)).toEqual([
      ["'-5", "'=1+1", "'+cmd|calc", 'done', 'Cut the opener.', 'run-0', ''],
      ['ok', "'@me and a normal one", "'+cmd|calc", 'done', 'Cut the opener.', 'run-1', ''],
    ])
    expect([neutralise('=a'), neutralise('+a'), neutralise('-a'), neutralise('@a'), neutralise('\ta'), neutralise('\ra'), neutralise('a=b'), neutralise('')]).toEqual([
      "'=a", "'+a", "'-a", "'@a", "'\ta", "'\ra", 'a=b', '',
    ])
  })

  it('does not replace a results file that exists without --force, and queues nothing first', async () => {
    const io = await signedIn()
    const list = join(io.cwd, 'd.csv')
    const out = join(io.cwd, 'd.optimized.csv')
    writeFileSync(list, 'message\na\n')
    writeFileSync(out, 'keep me\n')
    const r = await cli(io, 'optimize', '--list', list)
    expect(r.code).toBe(2)
    expect(r.stderr).toBe(`Error: ${out} already exists.\nMove it, or add --force to replace it.\n`)
    expect(readFileSync(out, 'utf8')).toBe('keep me\n')
    expect(requests('/messages/optimize/batch')).toEqual([])
    // --json writes no file, and --no-wait writes none yet: neither is refused.
    expect((await cli(io, 'optimize', '--list', list, '--json')).code).toBe(0)
    expect((await cli(io, 'optimize', '--list', list, '--no-wait')).code).toBe(0)
    expect(readFileSync(out, 'utf8')).toBe('keep me\n')
    const forced = await cli(io, 'optimize', '--list', list, '--force')
    expect(forced.code).toBe(0)
    expect(readFileSync(out, 'utf8')).toContain('better: a')
    // A pickup is refused the same way, before it reads the batch.
    const id = /batch (\S+)\./.exec((await cli(io, 'optimize', '--list', list, '--no-wait')).stdout)?.[1] ?? ''
    const reads = requests('/batches/').length
    expect((await cli(io, 'optimize', '--list', list, '--batch', id)).code).toBe(2)
    expect(requests('/batches/').length).toBe(reads)
    expect((await cli(io, 'optimize', '--batch', id)).code).toBe(0)
    expect((await cli(io, 'optimize', '--batch', id)).code).toBe(2)
  })

  it('--force and --no-wait mean nothing without a list, and --no-wait nothing with --batch', async () => {
    const io = await signedIn()
    const file = join(io.cwd, 'm.md')
    writeFileSync(file, 'draft')
    expect((await cli(io, 'optimize', file, '--force')).stderr).toBe('Error: --force goes with --list <file>.\n')
    const batch = await cli(io, 'optimize', '--batch', 'b1', '--no-wait')
    expect(batch).toMatchObject({ code: 2, stderr: 'Error: --no-wait does nothing with --batch: it only queues a new list.\n' })
    expect(requests('/batches/')).toEqual([])
  })

  it('--batch with a list that has a different number of messages is refused before any wait', async () => {
    const io = await signedIn()
    const two = join(io.cwd, 'two.csv')
    writeFileSync(two, 'message\na\nb\n')
    const id = /batch (\S+)\./.exec((await cli(io, 'optimize', '--list', two, '--no-wait')).stdout)?.[1] ?? ''
    const three = join(io.cwd, 'three.csv')
    writeFileSync(three, 'message\na\nb\nc\n')
    const r = await cli(io, 'optimize', '--list', three, '--batch', id)
    expect(r.code).toBe(2)
    expect(r.stderr).toBe(`Error: ${three} has 3 messages, but batch ${id} has 2 items.\nUse the same list you queued the batch from.\n`)
    expect(existsSync(join(io.cwd, 'three.optimized.csv'))).toBe(false)
    expect((await cli(io, 'optimize', '--list', two, '--batch', id)).code).toBe(0)
    expect(readFileSync(join(io.cwd, 'two.optimized.csv'), 'utf8')).toContain('better: b')
  })

  it('an unknown or missing header names the headers it expects; a message in the header row is cut short', async () => {
    const io = await signedIn()
    const list = join(io.cwd, 'h.csv')
    const hint = 'The first row must name the columns, from: item_id, message, channel, evidence, on_unsupported, facts, rules (message is required). For any other field, use a JSONL file.'
    writeFileSync(list, 'message,email\nhi,a@b.c\n')
    expect((await cli(io, 'optimize', '--list', list)).stderr).toBe(`Error: ${list} has a column Amdahl doesn't read: "email".\n${hint}\n`)
    writeFileSync(list, 'channel\nemail\n')
    expect((await cli(io, 'optimize', '--list', list)).stderr).toBe(`Error: ${list} needs a "message" column.\n${hint}\n`)
    // No header row: the first message is read as the header.
    writeFileSync(list, `${'Hi Dana I saw your talk and wanted to ask about your data stack '.repeat(3)}\nsecond\n`)
    const headerless = await cli(io, 'optimize', '--list', list)
    expect(headerless.code).toBe(2)
    expect(headerless.stderr.split('\n')[0]).toMatch(/column Amdahl doesn't read: "hi dana i saw your talk and wanted to\.\.\."\.$/)
    expect(headerless.stderr).toContain(hint)
  })

  it('a file without --list is still one message; --list beside files, or --no-wait alone, is a usage error', async () => {
    const io = await signedIn()
    const file = join(io.cwd, 'd.csv')
    writeFileSync(file, 'message\na\n')
    const one = await cli(io, 'optimize', file, '--json')
    expect(one.json).toMatchObject({ ok: true, file, result: { message: 'better: message\na\n' } })
    expect((await cli(io, 'optimize', file, '--list', file)).code).toBe(2)
    expect((await cli(io, 'optimize', file, '--no-wait')).code).toBe(2)
    expect(requests('/messages/optimize/batch')).toEqual([])
  })

  it('parses and writes CSV: quotes, commas, line breaks, CRLF and a BOM', () => {
    const { rows, lines } = parseCsv('﻿a,b\r\n"x, ""y""","1\r\n2"\r\n\r\nlast,\n')
    expect(rows).toEqual([['a', 'b'], ['x, "y"', '1\n2'], ['last', '']])
    expect(lines).toEqual([1, 2, 5])
    expect(parseCsv(toCsv(rows)).rows).toEqual(rows)
    expect(() => parseCsv('a\n"open')).toThrow('never ends')
    expect(resultsPath('/t/drafts.csv', 'csv')).toBe('/t/drafts.optimized.csv')
    expect(resultsPath('/t/list', 'jsonl')).toBe('/t/list.optimized.jsonl')
    expect(progressLine({ counts: { total: 10, done: 4, failed: 1, queued: 5, running: 0 }, eta: { seconds: 60 } })).toBe('4 of 10 done, 1 failed, about a minute left')
  })
})

describe('feedback and sent', () => {
  it('feedback sends what the schema takes, and needs --evidence and one of the rest', async () => {
    const io = await signedIn()
    const text = join(io.cwd, 'sent.txt')
    writeFileSync(text, 'Hi Dana, as sent')
    const r = await cli(io, 'feedback', 'run-1', '--evidence', 'did_it_myself', '--outcome', 'used_with_edits', '--sent-text', text, '--comment', 'Too formal')
    expect(r.code).toBe(0)
    expect(sentBody('/api/platform/v1/messages/optimize/runs/run-1/feedback')).toEqual({
      evidence: 'did_it_myself',
      sent_text: 'Hi Dana, as sent',
      comment: 'Too formal',
      outcome: 'used_with_edits',
    })
    expect(r.stdout).toBe('Feedback saved for run run-1. Amdahl learns your preferences from the edit.\n')
    expect((await cli(io, 'feedback', 'run-1', '--outcome', 'used')).code).toBe(2)
    expect((await cli(io, 'feedback', 'run-1', '--evidence', 'inferred')).code).toBe(2)
    expect((await cli(io, 'feedback', 'run-1', '--evidence', 'guess', '--outcome', 'used')).code).toBe(2)
    expect((await cli(io, 'feedback', '--evidence', 'inferred', '--outcome', 'used')).code).toBe(2)
    const json = await cli(io, 'feedback', 'run-2', '--evidence', 'reported_to_me', '--outcome', 'not_used', '--json')
    expect(json.json).toMatchObject({ ok: true, success: true, feedback_id: 'fb1', run_id: 'run-2', outcome: 'not_used' })
    const unknown = await cli(io, 'feedback', 'unknown', '--evidence', 'inferred', '--outcome', 'used')
    expect(unknown).toMatchObject({ code: 1, stderr: 'Error: No such run.\n' })
  })

  it('sent reports each run id with the shared fields; sent_at defaults to now', async () => {
    const io = await signedIn()
    io.now = () => Date.parse('2026-11-12T09:30:00Z')
    const r = await cli(io, 'sent', 'r1', 'r2', '--provider', 'lemlist', '--channel', 'email', '--sent-as', 'returned', '--provider-campaign-id', 'cam_1', '--sequence-step', '0')
    expect(r.code).toBe(0)
    expect(sentBody('/api/platform/v1/messages/report_send')).toEqual({
      items: ['r1', 'r2'].map((run_id) => ({
        run_id,
        provider: 'lemlist',
        channel: 'email',
        sent_as: 'returned',
        sent_at: '2026-11-12T09:30:00.000Z',
        provider_campaign_id: 'cam_1',
        sequence_step: 0,
      })),
    })
    expect(r.stdout).toBe('Reported 2 sends.\n')
  })

  it('sent: a rejected item exits 1 and says why; a one-send flag takes one run id; bad values are usage errors', async () => {
    const io = await signedIn()
    const base = ['--provider', 'gmail', '--channel', 'email', '--sent-as', 'edited']
    const r = await cli(io, 'sent', 'ok1', 'bad', ...base)
    expect(r.code).toBe(1)
    expect(r.stdout).toBe('Reported 1 send.\nNot stored: bad: No optimize run with this id.\n')
    expect((await cli(io, 'sent', 'a', 'b', ...base, '--provider-send-id', '<m@x>')).stderr).toContain('--provider-send-id names one send')
    expect((await cli(io, 'sent', 'a', '--provider', 'fax', '--channel', 'email', '--sent-as', 'returned')).code).toBe(2)
    expect((await cli(io, 'sent', 'a', ...base, '--sent-at', 'yesterday')).code).toBe(2)
    expect((await cli(io, 'sent', 'a', ...base, '--sent-at', '2026-11-12T09:30:00')).code).toBe(2)
    expect((await cli(io, 'sent', 'a', '--channel', 'email', '--sent-as', 'edited')).code).toBe(2)
    const one = await cli(io, 'sent', 'a', ...base, '--provider-send-id', '<m@x>', '--recipient', 'dana@x.com', '--json')
    expect(sentBody('/api/platform/v1/messages/report_send').items[0]).toMatchObject({ provider_send_id: '<m@x>', recipient: 'dana@x.com' })
    expect(one.json).toMatchObject({ ok: true, accepted: 1, rejected: 0 })
  })
})

describe('next steps', () => {
  it('status names each blocked item\'s fix', async () => {
    const io = await signedIn()
    const r = await cli(io, 'status')
    expect(r.stdout).toContain('  needs attention: Gong (gong): error\n  Fix it: http://localhost:4000/acme/connections/c1\n')
    server!.options.noConnections = true
    server!.options.blocker = 'quota_exhausted'
    const empty = await cli(io, 'status')
    expect(empty.stdout).toContain('Optimize:   blocked (quota_exhausted)\n')
    expect(empty.stdout).toContain('            The monthly optimize quota is used up. It resets on 2026-12-01.\n')
    expect(empty.stdout).toContain('Connections: 0 of 0 healthy\n  No data connected yet. Connect your CRM or call recorder: amdahl connect\n')
    server!.options.blocker = 'role_too_low'
    expect((await cli(io, 'status')).stdout).toContain('Ask a workspace admin to raise it.')
    // --json is the server's body, unchanged.
    const json = await cli(io, 'status', '--json')
    expect(Object.keys(json.json).sort()).toEqual(['caller', 'connections', 'ok', 'optimize', 'source', 'workspace'])
  })

  it('optimize on a workspace with no data connected ends with one line on connecting it; --json does not', async () => {
    const io = await signedIn({ noConnections: true })
    const file = join(io.cwd, 'a.md')
    writeFileSync(file, 'draft')
    const r = await cli(io, 'optimize', file)
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('Tighter opener.\nRun: r1\nConnect calls or a CRM so Amdahl checks claims against them: amdahl connect\n')
    const before = requests('/setup/status').length
    const json = await cli(io, 'optimize', file, '--json')
    expect(json.stderr).toBe('')
    expect(requests('/setup/status').length).toBe(before)
    server!.options.noConnections = false
    expect((await cli(io, 'optimize', file)).stderr).toBe('Tighter opener.\nRun: r1\n')
  })
})

describe('the optimize no-data line is only for a person at a terminal', () => {
  // A workspace with no data, and a result that says so itself: both ways to the line are shut.
  const noData = { noConnections: true, optimizeResult: { ok: true, message: 'Hi', summary: 'Tighter.', run_id: 'r1', setup_needed: { reason: 'no_sources_connected', message: 'x', connect_url: 'y' } } }

  it.each<[string, (io: FakeIo) => void]>([
    ['piped (no terminal on stdin)', (io) => void (io.stdinIsTTY = false)],
    ['an agent (CLAUDECODE)', (io) => void (io.env.CLAUDECODE = '1')],
    ['an agent (CURSOR_AGENT)', (io) => void (io.env.CURSOR_AGENT = '1')],
    ['CI', (io) => void (io.env.CI = 'true')],
    ['AMDAHL_NO_PROMPT=1', (io) => void (io.env.AMDAHL_NO_PROMPT = '1')],
  ])('%s: no setup/status request and no line, in a file run and a piped one', async (_label, setup) => {
    const io = await signedIn(noData)
    setup(io)
    const file = join(io.cwd, 'a.md')
    writeFileSync(file, 'draft')
    const before = requests('/setup/status').length
    const r = await cli(io, 'optimize', file)
    expect(r.code).toBe(0)
    expect(r.stderr).not.toContain('amdahl connect')
    io.stdinIsTTY = false
    io.stdinText = 'draft'
    expect((await cli(io, 'optimize', '-')).stderr).not.toContain('amdahl connect')
    expect(requests('/setup/status').length).toBe(before)
  })

  it('at a terminal, a result that says the workspace has no data gets the line with no status request', async () => {
    const io = await signedIn(noData)
    const file = join(io.cwd, 'a.md')
    writeFileSync(file, 'draft')
    const r = await cli(io, 'optimize', file)
    expect(r.stderr).toContain('Connect calls or a CRM so Amdahl checks claims against them: amdahl connect')
    expect((await cli(io, 'optimize', file, '--json')).stderr).toBe('')
  })
})

describe('tables in the terminal', () => {
  it('a table that fits keeps its columns; one that does not wraps its cells and every line fits 80 columns', () => {
    const fits = asciiTable(['A', 'Long label'], [['x', 'y']])
    expect(fits).toEqual(['| A | Long label |', '|---|------------|', '| x | y          |'])
    const labels = ['Account', 'Theme', 'What they said']
    const rows = [['Cobalt Payments', 'Budget', 'We looked at Collibra for governance, but it does not catch bad data while it flows through the pipeline.'], ['Alder', 'EHR', 'Short.']]
    const wide = asciiTable(labels, rows)
    expect(wide.every((l) => [...l].length <= 80)).toBe(true)
    expect(wide[0]).toContain('What they said')
    expect(wide.join('\n')).toContain('Collibra')
    // A column of ids or timestamps stays whole while the prose column wraps.
    const stamped = asciiTable(['Deal', 'Changed at', 'Note'], [['Cobalt - Audit trail rollout', '2026-10-13T19:22:48.282Z', 'Recorded close date came weeks before the stage change in the CRM log']])
    expect(stamped.join('\n')).toContain('2026-10-13T19:22:48.282Z')
    expect(stamped.every((l) => [...l].length <= 80)).toBe(true)
    // A wrapped row is set off from the next one by a rule.
    expect(wide.filter((l) => /^\|-+\|/.test(l)).length).toBeGreaterThan(1)
  })

  it('cuts a cell that would take more than four lines with ..., and splits a word wider than its column with a -', () => {
    // The last line keeps only what fits beside the mark.
    expect(wrapCell('one two three four five six seven eight nine ten', 8)).toEqual(['one two', 'three', 'four', 'five...'])
    expect(wrapCell('https://example.com/a/very/long/path', 12)).toEqual(['https://exa-', 'mple.com/a/-', 'very/long/p-', 'ath'])
    expect(wrapCell('', 5)).toEqual([''])
    expect(wrapCell('x'.repeat(40), 5, 2)).toEqual(['xxxx-', 'xx...'])
  })

  it('too many columns for 80: every row prints as label: value lines, so no column is dropped', () => {
    const labels = Array.from({ length: 12 }, (_, i) => `Column ${i + 1}`)
    const lines = asciiTable(labels, [labels.map((_, i) => `value ${i + 1}`)])
    expect(lines.slice(0, 3)).toEqual(['Row 1:', '  Column 1: value 1', '  Column 2: value 2'])
    expect(lines).toContain('  Column 12: value 12')
    expect(lines).toHaveLength(13)
  })

  it('prints at most 25 rows and counts the rest', () => {
    const lines = asciiTable(['n'], Array.from({ length: 30 }, (_, i) => [String(i)]))
    expect(lines.at(-1)).toBe('... and 5 more rows (all of them: add --json).')
    expect(lines).toHaveLength(2 + 25 + 1)
  })

  it('a table block with no rows or columns prints nothing, and block text is made safe', () => {
    expect(blockLines([{ type: 'table', columns: [], data: [] }, { type: 'text', markdown: '   ' }], 'answer')).toEqual([])
    expect(blockLines([{ type: 'text', markdown: 'safe\u001b[2J text' }], 'answer')).toEqual(['safe[2J text'])
    expect(blockLines(undefined, 'answer')).toEqual([])
  })
})

describe('text helpers', () => {
  it('says markdown links plainly and wraps to 80 columns', () => {
    expect(plainMarkdown('See [the call](amdahl:cite?block=r1) [2](amdahl:cite?block=r2), **bold**, [docs](https://x.y/z).')).toBe('See the call, bold, docs (https://x.y/z).')
    const lines = wrap('word '.repeat(40).trim())
    expect(lines.every((l) => l.length <= 80)).toBe(true)
    expect(wrap('- a list item that goes on '.repeat(5), 30).slice(1).every((l) => l.startsWith('  '))).toBe(true)
  })
})
