// 0.4.1: what a person reads and does with the commands 0.4.0 added. Each
// block is one item of Dom's cold QA of 0.4.0, against the mock server (which
// refuses what the real server refuses).

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { COMMAND_OPTIONS, USAGE, parseCommandLine } from '../src/args'
import { parseCsv, progressKey, progressLine } from '../src/commands/batch'
import { SEND_PROVIDERS } from '../src/commands/feedback'
import { searchLines } from '../src/commands/search'
import { HELP_COMMANDS, commandHelp } from '../src/help'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { API_KEY, KNOWN_RUN, READONLY_KEY, startMockServer, type MockServer } from './helpers/mock-server'
import { SEND_PROVIDERS as SERVER_PROVIDERS } from './helpers/strict'

let server: MockServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

/** Signed in through the browser, at a terminal. */
async function signedIn(options: Parameters<typeof startMockServer>[0] = {}): Promise<FakeIo> {
  server = await startMockServer(options)
  const io = fakeIo({ AMDAHL_API_URL: server.url })
  expect((await cli(io, 'login', '--json')).code).toBe(0)
  io.opened.length = 0
  io.stdoutIsTTY = true
  return io
}

/** A key in AMDAHL_KEY. */
async function withKey(key: string, options: Parameters<typeof startMockServer>[0] = {}): Promise<FakeIo> {
  server = await startMockServer(options)
  return fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_KEY: key })
}

const requests = (suffix: string) => server!.log.filter((l) => l.path.endsWith(suffix))
const sentBody = (path: string) => JSON.parse(server!.log.filter((l) => l.path === path).at(-1)?.body ?? '{}')

describe('search: what a person reads', () => {
  const rows = [
    { company_name: 'Acme', occurred_at: '2026-10-02T10:00:00Z', content_preview: 'We need annual billing, not monthly.' },
    { id: 'u2', occurred_at: '2026-10-03T10:00:00Z', speaker_type: 'customer', content_preview: 'Pricing was the blocker.' },
  ]

  it('prints each row\'s quote (content_preview) under its "Company, date" line', () => {
    const lines = searchLines({ results: rows, answer: { status: 'answered', text: 'Two buyers raised billing.' } })
    expect(lines).toEqual([
      'Two buyers raised billing.',
      '',
      'From:',
      '1. Acme, 2026-10-02',
      '   We need annual billing, not monthly.',
      '2. customer, 2026-10-03',
      '   Pricing was the blocker.',
    ])
  })

  it('says plainly that Amdahl could not answer from these rows (not_enough_data), then suggests a rephrase or amdahl connections', async () => {
    const io = await signedIn({ searchResult: { success: true, mode_ran: 'semantic', results: rows, answer: { status: 'not_enough_data', text: null, citations: [], model: 'm', reason: 'rows_do_not_answer' } } })
    const r = await cli(io, 'search', 'what did the CFO say about tax?')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(
      [
        "Amdahl couldn't answer that from these rows. Try rephrasing the question, or run",
        'amdahl connections to see whether your data is synced.',
        '',
        'Rows it read:',
        '1. Acme, 2026-10-02',
        '   We need annual billing, not monthly.',
        '2. customer, 2026-10-03',
        '   Pricing was the blocker.',
        '',
      ].join('\n')
    )
    for (const line of r.stdout.split('\n')) expect(line.length).toBeLessThanOrEqual(80)
    // No rows: the freshness line, as before, not a claim about rows.
    server!.options.searchResult = { success: true, results: [], answer: { status: 'skipped', text: null, reason: 'no_rows' }, data_freshness: { message: 'No matches. Last sync: 4 days ago.' } }
    expect((await cli(io, 'search', 'x')).stdout).toBe('No matches. Last sync: 4 days ago.\n')
  })

  it('says it found rows but could not write an answer when the answer failed', () => {
    const lines = searchLines({ results: rows, answer: { status: 'failed', text: null, reason: 'timeout' } })
    expect(lines.slice(0, 3)).toEqual(["Amdahl found rows but couldn't write an answer this time. Here are the rows. Try", 'again, or rephrase the question.', ''])
    expect(lines[3]).toBe('Rows it read:')
  })

  it('sends the question as typed: the server reads a window like "last month" from the words, there is no other field for it', async () => {
    const io = await signedIn()
    await cli(io, 'search', 'what', 'came', 'up', 'on', 'calls', 'last', 'month?')
    expect(sentBody('/api/platform/v1/search/query')).toEqual({ query: 'what came up on calls last month?', answer: true })
    await cli(io, 'search', 'calls last month', '--limit', '5')
    expect(sentBody('/api/platform/v1/search/query')).toEqual({ query: 'calls last month', answer: true, limit: 5 })
  })
})

describe('a refused credential: a plain sentence, and the same code and hint as 0.4.0', () => {
  const scope = (verb: string) => `This credential cannot ${verb}. Use a Customer agent key, or run \`amdahl login\` again.`

  it('a read-only key: optimize, a list, feedback and sent each say what this credential cannot do, never "Missing required scope(s)"', async () => {
    const io = await withKey(READONLY_KEY)
    const draft = join(io.homedir, 'a.md')
    writeFileSync(draft, 'draft')
    const list = join(io.homedir, 'l.csv')
    writeFileSync(list, 'message\nhi\n')
    const calls: [string[], string][] = [
      [['optimize', draft], 'optimize'],
      [['optimize', '--list', list], 'optimize a list'],
      [['feedback', KNOWN_RUN, '--evidence', 'inferred', '--outcome', 'used'], 'record feedback'],
      [['sent', KNOWN_RUN, '--provider', 'other', '--channel', 'email', '--sent-as', 'returned', '--provider-send-id', 'x'], 'report sends'],
    ]
    for (const [args, verb] of calls) {
      const r = await cli(io, ...args)
      expect([r.code, r.stderr], args[0]).toEqual([4, `Error: ${scope(verb)}\n`])
      expect(r.stderr).not.toContain('Missing required')
    }
    // --json: the server's code and no hint, as in 0.4.0 (an agent branches on `code`); only the message is plain.
    const json = await cli(io, 'optimize', draft, '--json')
    expect(json.json).toEqual({ ok: false, error: { code: 'forbidden', message: scope('optimize') } })
    expect(requests('/messages/optimize').length).toBeGreaterThan(0)
  })

  it('the --json error code is the one the server sent, whatever it is, for a refused scope and a refused key', async () => {
    const io = await withKey(READONLY_KEY, { forbiddenCode: 'scope_denied', unauthenticatedCode: 'token_revoked' })
    const draft = join(io.homedir, 'a.md')
    writeFileSync(draft, 'draft')
    expect((await cli(io, 'optimize', draft, '--json')).json.error.code).toBe('scope_denied')
    const bad = fakeIo({ AMDAHL_API_URL: server!.url, AMDAHL_KEY: 'amdhl_revoked' })
    expect((await cli(bad, 'status', '--json')).json.error.code).toBe('token_revoked')
  })

  it('a bad or revoked key says so in a sentence, and keeps the code and the hint 0.4.0 printed', async () => {
    const io = await withKey('amdhl_revoked')
    const hint = 'Run `amdahl login`, or check AMDAHL_KEY.'
    const sentence = "This key isn't valid (revoked or expired)."
    expect(await cli(io, 'status')).toMatchObject({ code: 3, stderr: `Error: ${sentence}\n${hint}\n` })
    const flag = await cli(fakeIo({ AMDAHL_API_URL: server!.url }), 'status', '--api-key', 'amdhl_revoked')
    expect(flag).toMatchObject({ code: 3, stderr: `Error: ${sentence}\n${hint}\n` })
    const npx = fakeIo({ AMDAHL_API_URL: server!.url, AMDAHL_KEY: 'amdhl_revoked', npm_command: 'exec' })
    expect((await cli(npx, 'search', 'x')).stderr).toBe(`Error: ${sentence}\nRun \`npx -y amdahl login\`, or check AMDAHL_KEY.\n`)
    // --json: the server's code and the same hint as before; only the message is plain.
    expect((await cli(io, 'status', '--json')).json).toEqual({ ok: false, error: { code: 'Unauthorized', message: sentence, hint } })
  })

  it('an OAuth access token the server will not take says "token", not "key"', async () => {
    server = await startMockServer()
    const io = fakeIo({ AMDAHL_API_URL: server.url, AMDAHL_ACCESS_TOKEN: 'at_revoked' })
    const r = await cli(io, 'status')
    expect(r).toMatchObject({ code: 3, stderr: "Error: This token isn't valid (revoked or expired).\nRun `amdahl login`, or check AMDAHL_KEY.\n" })
    expect((await cli(io, 'status', '--json')).json.error).toMatchObject({ code: 'Unauthorized', message: "This token isn't valid (revoked or expired)." })
  })

  it('a sign-in the server no longer takes says so', async () => {
    const io = await signedIn()
    for (const token of server!.issued.access) server!.revoked.push(token)
    const r = await cli(io, 'status')
    expect(r).toMatchObject({ code: 3, stderr: 'Error: Your sign-in is no longer valid.\nRun `amdahl login`, or check AMDAHL_KEY.\n' })
    expect((await cli(io, 'status', '--json')).json.error).toEqual({ code: 'Unauthorized', message: 'Your sign-in is no longer valid.', hint: 'Run `amdahl login`, or check AMDAHL_KEY.' })
  })
})

describe('a file that is not there', () => {
  it("says \"Can't find <file>.\" for a draft, a list, a context file and the sent text, and exits 2", async () => {
    const io = await signedIn()
    const missing = join(io.homedir, 'nope.md')
    expect(await cli(io, 'optimize', missing)).toMatchObject({ code: 2, stderr: `Error: Can't find ${missing}.\n` })
    expect((await cli(io, 'optimize', '--list', missing)).stderr).toBe(`Error: Can't find ${missing}.\n`)
    const draft = join(io.homedir, 'a.md')
    writeFileSync(draft, 'draft')
    expect((await cli(io, 'optimize', draft, '--context', missing)).stderr).toBe(`Error: Can't find ${missing}.\n`)
    expect((await cli(io, 'feedback', KNOWN_RUN, '--evidence', 'inferred', '--sent-text', missing)).stderr).toBe(`Error: Can't find ${missing}.\n`)
    expect((await cli(io, 'sent', KNOWN_RUN, '--provider', 'other', '--channel', 'email', '--sent-as', 'edited', '--provider-send-id', 'x', '--sent-text', missing)).stderr).toBe(`Error: Can't find ${missing}.\n`)
    // Nothing is sent for a file that is not there, and a bad context is a different message.
    expect(requests('/messages/optimize')).toEqual([])
    writeFileSync(join(io.homedir, 'bad.json'), '{nope')
    expect((await cli(io, 'optimize', draft, '--context', join(io.homedir, 'bad.json'))).stderr).toContain('is not valid JSON')
  })

  it('a folder and a file it may not read each say what they are, in one line', async () => {
    const io = await signedIn()
    const dir = join(io.homedir, 'folder')
    mkdirSync(dir)
    expect((await cli(io, 'optimize', dir)).stderr).toBe(`Error: ${dir} is a folder, not a file.\n`)
    const locked = join(io.homedir, 'locked.md')
    writeFileSync(locked, 'draft')
    chmodSync(locked, 0o000)
    // A superuser reads it anyway.
    if (process.getuid?.() !== 0) expect((await cli(io, 'optimize', locked)).stderr).toBe(`Error: Can't read ${locked}: permission denied.\n`)
    chmodSync(locked, 0o600)
  })
})

describe('<command> --help prints that command only', () => {
  it('prints the command\'s usage, not the whole help, for --help, -h and `help <command>`', async () => {
    const io = fakeIo()
    const whole = (await cli(io, '--help')).stdout
    expect(whole).toBe(USAGE)
    for (const argv of [['optimize', '--help'], ['optimize', '-h'], ['help', 'optimize'], ['optimize', 'draft.md', '--help'], ['optimize', '--json', '--help']]) {
      const r = await cli(io, ...argv)
      expect(r.code, argv.join(' ')).toBe(0)
      expect(r.stdout, argv.join(' ')).toBe(commandHelp(['optimize']))
      expect(r.stdout).toMatch(/^Usage: amdahl optimize /)
      expect(r.stdout).not.toContain('What you can do')
      expect(r.stdout).not.toContain('amdahl keys create')
    }
    expect((await cli(io, 'sent', '--help')).stdout).toMatch(/^Usage: amdahl sent <run-id>/)
    expect((await cli(io, 'search', '--help')).stdout).not.toContain('amdahl sent')
    // Two-word commands, their alias, and the group.
    expect((await cli(io, 'keys', 'create', '--help')).stdout).toMatch(/^Usage: amdahl keys create --name/)
    expect((await cli(io, 'auth', 'login', '--help')).stdout).toBe(commandHelp(['login']))
    const group = (await cli(io, 'keys', '--help')).stdout
    expect(group).toContain('amdahl keys create')
    expect(group).toContain('amdahl keys revoke')
    expect(group).not.toContain('amdahl optimize')
    // A command with no help of its own, and no command, get the whole help.
    expect((await cli(io, 'help', 'nope')).stdout).toBe(whole)
    expect((await cli(io, 'help')).stdout).toBe(whole)
  })

  it('has help for every command, naming every flag it takes, in lines that fit 80 columns', () => {
    for (const name of Object.keys(COMMAND_OPTIONS)) {
      if (name === 'help') continue
      const text = commandHelp(name.split(' '))
      expect(text, name).not.toBeNull()
      for (const [flag, spec] of Object.entries(COMMAND_OPTIONS[name] ?? {})) {
        const short = (spec as { short?: string }).short
        expect(text!.includes(`--${flag}`) || (short !== undefined && text!.includes(`-${short}`)), `${name} --${flag}`).toBe(true)
      }
    }
    for (const name of HELP_COMMANDS) {
      expect(() => parseCommandLine(name === 'setup' || name === 'help' ? [name] : name.split(' ')), name).not.toThrow()
      for (const line of commandHelp(name.split(' '))!.split('\n')) expect(line.length, `${name}: ${line}`).toBeLessThanOrEqual(80)
    }
    for (const line of USAGE.split('\n')) expect(line.length).toBeLessThanOrEqual(80)
  })

  it('says where the message is in `optimize --json`, and what each of the two helps lists for sent', () => {
    expect(commandHelp(['optimize'])).toContain('.result.message')
    expect(USAGE).toContain('.result.message')
    for (const text of [commandHelp(['sent'])!, USAGE]) {
      for (const provider of SEND_PROVIDERS) expect(text).toContain(provider)
      expect(text).toContain('linkedin_message')
      expect(text).toContain('linkedin (= linkedin_message)'.slice(0, 8))
    }
  })
})

describe('sent: providers and channels', () => {
  const base = (provider: string, channel: string) => ['sent', KNOWN_RUN, '--provider', provider, '--channel', channel, '--sent-as', 'returned', '--provider-send-id', 'x1']

  it("lists the server's providers in --help and in the refusal of one that is not there (nosuchtool is not)", async () => {
    // The CLI list is the server's list (messages.report_send), in order, with the four 0.5 added.
    expect(SEND_PROVIDERS).toEqual([...SERVER_PROVIDERS])
    for (const added of ['smartlead', 'reply_io', 'lgm', 'woodpecker']) expect(SEND_PROVIDERS).toContain(added)
    const io = await signedIn()
    const before = server!.log.length
    const r = await cli(io, ...base('nosuchtool', 'email'))
    expect(r.code).toBe(2)
    expect(r.stderr).toBe(
      `Error: --provider must be one of: ${SEND_PROVIDERS.join(', ')}.\n"nosuchtool" is not on the list. For a sender that is not, use --provider other.\n`
    )
    expect(server!.log.length).toBe(before)
    // `other` works, and so does each provider the server added.
    expect((await cli(io, ...base('other', 'email'))).code).toBe(0)
    for (const added of ['smartlead', 'reply_io', 'lgm', 'woodpecker']) {
      expect((await cli(io, ...base(added, 'email'))).code).toBe(0)
      expect(sentBody('/api/platform/v1/messages/report_send').items[0]).toMatchObject({ provider: added })
    }
  })

  it('accepts linkedin and sends it as linkedin_message, as optimize --channel linkedin says it; the others stay as they are', async () => {
    const io = await signedIn()
    expect((await cli(io, ...base('other', 'linkedin'))).code).toBe(0)
    expect(sentBody('/api/platform/v1/messages/report_send').items[0]).toMatchObject({ channel: 'linkedin_message' })
    for (const channel of ['linkedin_invite', 'linkedin_inmail', 'linkedin_message', 'email']) {
      expect((await cli(io, ...base('other', channel))).code).toBe(0)
      expect(sentBody('/api/platform/v1/messages/report_send').items[0]).toMatchObject({ channel })
    }
    const bad = await cli(io, ...base('other', 'sms'))
    expect(bad.code).toBe(2)
    expect(bad.stderr).toBe('Error: --channel must be one of: email, linkedin_invite, linkedin_message, linkedin_inmail, linkedin.\n')
  })
})

describe('sent: what it refuses before it sends', () => {
  const base = ['--provider', 'other', '--channel', 'email', '--sent-as', 'returned', '--provider-send-id', 'x1']

  it('refuses a run id given twice, and says one send per command', async () => {
    const io = await signedIn()
    const before = server!.log.length
    const twice = await cli(io, 'sent', KNOWN_RUN, KNOWN_RUN, ...base)
    expect(twice).toMatchObject({ code: 2, stderr: `Error: ${KNOWN_RUN} is there twice.\nGive each run id once. The command reports one send.\n` })
    expect((await cli(io, 'sent', KNOWN_RUN, KNOWN_RUN.toUpperCase(), ...base)).stderr).toContain('is there twice.')
    expect((await cli(io, 'sent', KNOWN_RUN, '99999999-9999-4999-8999-000000000000', ...base)).stderr).toContain('Report one send at a time')
    expect(server!.log.length).toBe(before)
  })

  it('refuses --sent-as edited with no --sent-text, before any request, and takes it with the text', async () => {
    const io = await signedIn()
    const before = server!.log.length
    const edited = ['sent', KNOWN_RUN, '--provider', 'other', '--channel', 'email', '--sent-as', 'edited', '--provider-send-id', 'x1']
    const r = await cli(io, ...edited)
    expect(r).toMatchObject({ code: 2, stderr: 'Error: --sent-as edited needs --sent-text <file>: the message as you sent it.\nAmdahl keeps only a hash of the text. Use - to read it from standard input.\n' })
    expect(server!.log.length).toBe(before)
    const text = join(io.cwd, 'sent.txt')
    writeFileSync(text, 'Hi Dana, as I sent it')
    expect((await cli(io, ...edited, '--sent-text', text)).code).toBe(0)
    expect(sentBody('/api/platform/v1/messages/report_send').items[0]).toMatchObject({ sent_as: 'edited', sent_text: 'Hi Dana, as I sent it' })
    io.stdinText = 'from stdin'
    expect((await cli(io, ...edited, '--sent-text', '-')).code).toBe(0)
    // `returned` needs no text.
    expect((await cli(io, 'sent', KNOWN_RUN, ...base)).code).toBe(0)
  })

  it('takes a send id and a recipient together (the server does), and refuses only a recipient with a hash (it does not)', async () => {
    const io = await signedIn()
    expect((await cli(io, 'sent', KNOWN_RUN, ...base, '--recipient', 'dana@example.com')).code).toBe(0)
    expect(sentBody('/api/platform/v1/messages/report_send').items[0]).toMatchObject({ provider_send_id: 'x1', recipient: 'dana@example.com' })
    expect((await cli(io, 'sent', KNOWN_RUN, ...base, '--recipient', 'dana@example.com', '--recipient-key-hash', 'a'.repeat(64))).code).toBe(2)
  })
})

describe('connect when the connector is already connected', () => {
  const add = 'http://localhost:4000/acme/settings/connections?add=1&connector=hubspot'

  it('says it is connected and healthy first, then offers the add page without opening it', async () => {
    const io = await signedIn()
    const r = await cli(io, 'connect', 'hubspot')
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('HubSpot is already connected and healthy (last sync 2026-11-11).\nTo add another one, open this link:\n')
    expect(r.stdout).toBe(`${add}\n`)
    expect(io.opened).toEqual([])
    const json = await cli(io, 'connect', 'HubSpot', '--json')
    expect(json.json).toEqual({ ok: true, url: add, opened: false, connector: 'hubspot', connected: { id: 'c0', health: 'healthy', healthy: true, url: 'http://localhost:4000/acme/connections/c0' } })
  })

  it('a connection that needs attention says so and links its own page, not the add page', async () => {
    const io = await signedIn()
    const r = await cli(io, 'connect', 'gong')
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('Gong is already connected, but its health is "needs sign-in".\nSign in to it again: http://localhost:4000/acme/connections/c1\n')
    expect(r.stdout).toBe('')
    expect(io.opened).toEqual([])
  })

  it('a connector that is not connected yet opens the add page, and a list that cannot be read does not stop it', async () => {
    const io = await signedIn({ connections: [{ id: 'c9', connector_type: 'gong', name: 'Gong', status: 'connected', health: 'healthy' }] })
    expect((await cli(io, 'connect', 'hubspot')).code).toBe(0)
    expect(io.opened).toEqual([add])
    io.opened.length = 0
    server!.options.connectionsError = true
    expect((await cli(io, 'connect', 'hubspot')).code).toBe(0)
    expect(io.opened).toEqual([add])
  })
})

describe('batch progress', () => {
  it('never prints "0 of N done" twice: queued says it is queued, and a changing estimate alone prints nothing', async () => {
    const io = await signedIn({ batchPolls: 5, batchRunningPolls: 3 })
    const list = join(io.cwd, 'd.csv')
    writeFileSync(list, 'message\na\nb\nc\n')
    const r = await cli(io, 'optimize', '--list', list)
    expect(r.code).toBe(0)
    const lines = r.stderr.split('\n')
    const progress = lines.filter((l) => /done|Queued behind/.test(l) && !l.startsWith('Queued 3'))
    expect(progress).toEqual(['Queued behind 3 items, about 5 min left', '0 of 3 done, about 2 min left', '3 of 3 done'])
    expect(lines.filter((l) => l.includes('0 of 3'))).toHaveLength(1)
  })

  it('a queued line has no counts; a running line says where it stands; the key ignores the estimate', () => {
    const counts = (queued: number, running: number, done: number) => ({ counts: { total: 3, queued, running, done, failed: 0 }, queue_position: 2, eta: { seconds: 300 } })
    expect(progressLine(counts(3, 0, 0))).toBe('Queued behind 2 items, about 5 min left')
    expect(progressLine(counts(3, 0, 0))).not.toContain('0 of')
    expect(progressLine(counts(2, 1, 0))).toBe('0 of 3 done, about 5 min left')
    expect(progressLine(counts(0, 0, 3))).toBe('3 of 3 done')
    expect(progressKey({ ...counts(2, 1, 0), eta: { seconds: 60 } })).toBe(progressKey(counts(2, 1, 0)))
    expect(progressKey(counts(1, 1, 1))).not.toBe(progressKey(counts(2, 1, 0)))
  })
})

describe('after an optimize: what to do once it is sent', () => {
  it('a single run ends with one line that names amdahl sent and amdahl feedback with the real run id; --json prints none', async () => {
    const io = await signedIn({ optimizeResult: { ok: true, message: 'Hi', summary: 'Tighter.', run_id: '9fd4f2e3-bc8e-436b-86d7-a677a89e8d16' } })
    const file = join(io.homedir, 'a.md')
    writeFileSync(file, 'draft')
    const r = await cli(io, 'optimize', file)
    expect(r.stderr).toBe('Tighter.\nRun: 9fd4f2e3-bc8e-436b-86d7-a677a89e8d16\nSent it? amdahl sent 9fd4f2e3-bc8e-436b-86d7-a677a89e8d16 --provider <provider> --channel <channel> --sent-as returned --provider-send-id <id>\nOr say how it went: amdahl feedback 9fd4f2e3-bc8e-436b-86d7-a677a89e8d16 --evidence did_it_myself --outcome used\n')
    expect((await cli(io, 'optimize', file, '--json')).stderr).toBe('')
    // Under npx, the command is named as it is run.
    io.env.npm_command = 'exec'
    expect((await cli(io, 'optimize', file)).stderr).toContain('Sent it? npx -y amdahl sent 9fd4f2e3-')
    // No run id, no line.
    server!.options.optimizeResult = { ok: true, message: 'Hi', summary: 'Tighter.' }
    expect((await cli(io, 'optimize', file)).stderr).toBe('Tighter.\n')
  })

  it('several files each name their own run, and a batch names the first run id of its results', async () => {
    const io = await signedIn()
    const [a, b] = [join(io.homedir, 'a.md'), join(io.homedir, 'b.md')]
    writeFileSync(a, 'one')
    writeFileSync(b, 'two')
    const r = await cli(io, 'optimize', a, b)
    expect(r.stderr.split('\n').filter((l) => l.startsWith('Sent it?'))).toHaveLength(2)
    const list = join(io.homedir, 'l.jsonl')
    writeFileSync(list, '{"message":"a"}\n{"message":"b"}\n')
    const batch = await cli(io, 'optimize', '--list', list)
    expect(batch.stderr).toContain('Sent one? amdahl sent 99999999-9999-4999-8999-000000000000 --provider <provider> --channel <channel> --sent-as returned --provider-send-id <id>\nOr say how it went: amdahl feedback 99999999-9999-4999-8999-000000000000 --evidence did_it_myself --outcome used\n')
    server!.options.batchFailures = [0, 1]
    const failed = await cli(io, 'optimize', '--list', list, '--force')
    expect(failed.stderr).not.toContain('Sent one?')
    const json = await cli(io, 'optimize', '--list', list, '--json')
    expect(json.stderr).not.toContain('Sent one?')
  })
})

describe('what_changed is not printed', () => {
  it('the generic sentence is not a line, in a file run or a pasted one', async () => {
    const generic = 'Wrote this message from the context you sent.'
    const io = await signedIn({ optimizeResult: { ok: true, message: 'Hi', summary: 'Tighter.', what_changed: generic, run_id: 'r1' } })
    const file = join(io.homedir, 'a.md')
    writeFileSync(file, 'draft')
    expect((await cli(io, 'optimize', file)).stderr).not.toContain(generic)
    io.answers.push('Hi Sam')
    io.stdinIsTTY = true
    expect((await cli(io, 'optimize')).stderr).not.toContain(generic)
    // It stays in --json, which is the server's answer.
    expect((await cli(io, 'optimize', file, '--json')).json.result.what_changed).toBe(generic)
  })
})

describe('the mock matches the server it stands for', () => {
  it('knows the keys it is given', async () => {
    server = await startMockServer()
    const get = (key: string) => fetch(`${server!.url}/api/platform/v1/setup/status`, { headers: { Authorization: `Bearer ${key}` } }).then((r) => r.status)
    expect(await get(API_KEY)).toBe(200)
    expect(await get(READONLY_KEY)).toBe(200)
    expect(await get('amdhl_unknown')).toBe(401)
  })
})

describe('the two lines after an optimize are commands to paste', () => {
  it('each holds a command with the real run id and placeholders for the flags it needs, and runs once they are filled in', async () => {
    const io = await signedIn({ optimizeResult: { ok: true, message: 'Hi', summary: 'Tighter.', run_id: KNOWN_RUN } })
    const file = join(io.homedir, 'a.md')
    writeFileSync(file, 'draft')
    const lines = (await cli(io, 'optimize', file)).stderr.split('\n').filter(Boolean)
    const [sent, feedback] = lines.slice(-2) as [string, string]
    expect(sent.startsWith(`Sent it? amdahl sent ${KNOWN_RUN} --provider <provider> `)).toBe(true)
    expect(feedback.startsWith(`Or say how it went: amdahl feedback ${KNOWN_RUN} `)).toBe(true)
    // No shell pipe: a person who pastes the command must not run another program.
    expect(sent + feedback).not.toContain('|')
    // Fill the placeholders in and run each line as it stands: both succeed.
    const run = async (line: string) => {
      const argv = line.slice(line.indexOf('amdahl ') + 'amdahl '.length).replace('<provider>', 'other').replace('<channel>', 'email').replace('<id>', 'x1').split(' ')
      return cli(io, ...argv)
    }
    expect((await run(sent)).code).toBe(0)
    expect((await run(feedback)).code).toBe(0)
    // Pasted as printed, `sent` is refused before it sends anything, instead of running something else.
    const before = server!.log.length
    expect((await cli(io, ...sent.slice(sent.indexOf('amdahl ') + 7).split(' '))).code).toBe(2)
    expect(server!.log.length).toBe(before)
  })
})

describe('a summary that is true of the run', () => {
  const claim = 'Written from your context, with every sentence checked against your facts and rules.'

  it('a single run keeps the summary line only when facts or rules were sent', async () => {
    const io = await signedIn({ optimizeResult: { ok: true, message: 'Hi', summary: claim, run_id: 'r1' } })
    const file = join(io.homedir, 'a.md')
    writeFileSync(file, 'draft')
    expect((await cli(io, 'optimize', file)).stderr).not.toContain('facts and rules')
    const ctx = join(io.homedir, 'ctx.json')
    writeFileSync(ctx, JSON.stringify({ facts: ['Dana runs ops'] }))
    expect((await cli(io, 'optimize', file, '--context', ctx)).stderr).toContain(claim)
    writeFileSync(ctx, JSON.stringify({ voice_examples: ['Hi, quick one.'], facts: [], rules: [] }))
    expect((await cli(io, 'optimize', file, '--context', ctx)).stderr).not.toContain(claim)
    // A summary that says something else is kept either way, and --json is the server's answer.
    server!.options.optimizeResult = { ok: true, message: 'Hi', summary: 'Tightened the opener.', run_id: 'r1' }
    expect((await cli(io, 'optimize', file)).stderr).toContain('Tightened the opener.')
    server!.options.optimizeResult = { ok: true, message: 'Hi', summary: claim, run_id: 'r1' }
    expect((await cli(io, 'optimize', file, '--json')).json.result.summary).toBe(claim)
  })

  it('a batch row gets an empty summary cell when its run had neither facts nor rules, and keeps it when it had either', async () => {
    const io = await signedIn({ batchSummary: claim })
    const list = join(io.cwd, 'f.csv')
    writeFileSync(list, 'message,facts,rules\nno context,,\nwith a fact,Dana runs ops,\nwith a rule,,Never say just\n')
    expect((await cli(io, 'optimize', '--list', list)).code).toBe(0)
    const rows = parseCsv(readFileSync(join(io.cwd, 'f.optimized.csv'), 'utf8')).rows
    expect(rows.map((r) => r[5])).toEqual(['summary', '', claim, claim])
    // Rules from --context reach every row.
    const ctx = join(io.homedir, 'ctx.json')
    writeFileSync(ctx, JSON.stringify({ rules: ['Be brief'] }))
    expect((await cli(io, 'optimize', '--list', list, '--context', ctx, '--force')).code).toBe(0)
    expect(parseCsv(readFileSync(join(io.cwd, 'f.optimized.csv'), 'utf8')).rows.map((r) => r[5])).toEqual(['summary', claim, claim, claim])
    // A summary that makes no such claim is kept for a row with no context.
    server!.options.batchSummary = 'Tighter opener.'
    expect((await cli(io, 'optimize', '--list', list, '--force')).code).toBe(0)
    expect(parseCsv(readFileSync(join(io.cwd, 'f.optimized.csv'), 'utf8')).rows[1]?.[5]).toBe('Tighter opener.')
  })
})

describe('sent: an edit needs its text', () => {
  const edited = ['sent', KNOWN_RUN, '--provider', 'other', '--channel', 'email', '--sent-as', 'edited', '--provider-send-id', 'x1']

  it('refuses --sent-as edited with an empty or blank --sent-text file or empty standard input, before any request', async () => {
    const io = await signedIn()
    const before = server!.log.length
    const empty = join(io.cwd, 'empty.txt')
    writeFileSync(empty, '')
    const r = await cli(io, ...edited, '--sent-text', empty)
    expect(r).toMatchObject({ code: 2, stderr: `Error: --sent-text ${empty} is empty. An edited send needs the message as you sent it.\n` })
    writeFileSync(empty, '  \n\t\n')
    expect((await cli(io, ...edited, '--sent-text', empty)).code).toBe(2)
    io.stdinText = '   '
    expect(await cli(io, ...edited, '--sent-text', '-')).toMatchObject({ code: 2, stderr: 'Error: Standard input is empty. An edited send needs the message as you sent it.\n' })
    expect(server!.log.length).toBe(before)
    // Text, even with an empty line around it, goes through; `returned` needs none.
    writeFileSync(empty, '\nHi Dana, as sent\n')
    expect((await cli(io, ...edited, '--sent-text', empty)).code).toBe(0)
  })
})

describe('the help says what the server allows and what the CLI guards', () => {
  it('sent: at least one of a send id and a recipient, a recipient or a hash but not both; a send id with a recipient is fine', () => {
    for (const text of [commandHelp(['sent'])!, USAGE]) {
      expect(text).toContain('[--provider-send-id <id>]')
      expect(text).toContain('[--recipient <email|url> | --recipient-key-hash <sha256>]')
      expect(text).not.toContain('(--provider-send-id <id> | --recipient')
    }
    expect(commandHelp(['sent'])).toContain('Give at least one of --provider-send-id and a recipient (--recipient or')
    expect(commandHelp(['sent'])).toContain('A send id with a recipient is fine')
  })

  it('optimize --list: a cell that starts with = + - or @ gets a quote in the results, phone numbers included', async () => {
    for (const text of [commandHelp(['optimize'])!, USAGE]) {
      expect(text).toMatch(/starts with =, \+, - ?\n? *or @|starts with =, \+, -\s+or @/)
      expect(text).toContain("gets a '")
    }
    const io = await signedIn()
    const list = join(io.cwd, 'phones.csv')
    writeFileSync(list, 'message,phone,balance\nHi,+1 555 0100,-20\n')
    expect((await cli(io, 'optimize', '--list', list)).code).toBe(0)
    expect(parseCsv(readFileSync(join(io.cwd, 'phones.optimized.csv'), 'utf8')).rows[1]?.slice(0, 3)).toEqual(['Hi', "'+1 555 0100", "'-20"])
  })
})
