// Key format, exit-code map, argument errors, optimize, keys edge cases,
// install (codex TOML idempotence, cursor merge, claude-code), workspace
// profiles and the version.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import pkg from '../package.json'
import { parseCommandLine } from '../src/args'
import { configPath } from '../src/config'
import { PASTE_PROMPT, VERSION_RULE, whatAmdahlDid } from '../src/commands/optimize'
import { EXIT, exitForHttp } from '../src/errors'
import { generateKey } from '../src/keygen'
import { SKILL_TEXT, isShippedSkill } from '../src/skill'
import { VERSION } from '../src/version'
import { cli, fakeIo } from './helpers/fake-io'
import { startMockServer, type MockServer } from './helpers/mock-server'

let server: MockServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

async function loggedIn(options: Parameters<typeof startMockServer>[0] = {}) {
  server = await startMockServer(options)
  const io = fakeIo({ AMDAHL_API_URL: server.url })
  expect((await cli(io, 'login', '--json')).code).toBe(0)
  return io
}

describe('key generation', () => {
  it('is amdhl_ + 48 hex, hashed with sha256, with a 14-char prefix', () => {
    const k = generateKey()
    expect(k.secret).toMatch(/^amdhl_[0-9a-f]{48}$/)
    expect(k.hash).toBe(createHash('sha256').update(k.secret).digest('hex'))
    expect(k.prefix).toHaveLength(14)
    expect(k.prefix).toMatch(/^amdhl_[0-9a-f]{8}$/)
    expect(generateKey().secret).not.toBe(k.secret)
  })
})

describe('exit codes', () => {
  it('maps statuses and server codes', () => {
    expect(exitForHttp(401)).toBe(EXIT.unauthenticated)
    expect(exitForHttp(403)).toBe(EXIT.forbidden)
    expect(exitForHttp(403, 'cli_client_required')).toBe(4)
    expect(exitForHttp(403, 'not_admin')).toBe(4)
    expect(exitForHttp(429)).toBe(6)
    expect(exitForHttp(429, 'too_many_pending')).toBe(6)
    expect(exitForHttp(200, 'quota_exceeded')).toBe(6)
    expect(exitForHttp(410)).toBe(7)
    expect(exitForHttp(500)).toBe(8)
    expect(exitForHttp(0)).toBe(8)
    expect(exitForHttp(404)).toBe(1)
    expect(exitForHttp(400, 'invalid_grant')).toBe(3)
  })

  it('usage errors exit 2', async () => {
    const io = fakeIo()
    expect((await cli(io, 'whoami', '--bogus')).code).toBe(2)
    expect((await cli(io, 'nope')).code).toBe(2)
    expect((await cli(io, 'keys')).code).toBe(2)
    io.env.AMDAHL_NO_PROMPT = '1'
    expect((await cli(io)).code).toBe(2)
    delete io.env.AMDAHL_NO_PROMPT
    const r = await cli(io, 'keys', 'create', '--json')
    expect(r.code).toBe(2)
    expect(r.json.error.code).toBe('usage')
  })

  it('an unknown option or command says so in one line and points at --help', async () => {
    const io = fakeIo()
    const flag = await cli(io, '--foo')
    expect(flag).toMatchObject({ code: 2, stderr: 'Error: Unknown option --foo.\nRun `amdahl --help`.\n' })
    expect((await cli(io, 'whoami', '-x')).stderr).toBe('Error: Unknown option -x.\nRun `amdahl --help`.\n')
    expect((await cli(io, 'login', '--port')).stderr).toBe('Error: --port needs a value.\nRun `amdahl --help`.\n')
    expect((await cli(io, 'nope')).stderr).toBe('Error: Unknown command `nope`.\nRun `amdahl --help` to see the commands.\n')
  })

  it('`amdahl help` is --help', async () => {
    const io = fakeIo()
    expect(await cli(io, 'help')).toMatchObject({ code: 0, stdout: (await cli(io, '--help')).stdout })
  })

  it('under npx, every next step says `npx -y amdahl`', async () => {
    for (const env of [{ npm_command: 'exec' }, { npm_lifecycle_event: 'npx' }]) {
      const io = fakeIo(env)
      expect((await cli(io, 'whoami')).stderr).toBe('Error: Not signed in. Run `npx -y amdahl login`, or set AMDAHL_KEY.\n')
      expect((await cli(io, '--bogus')).stderr).toContain('Run `npx -y amdahl --help`.')
    }
    const cached = fakeIo()
    cached.scriptPath = '/Users/a/.npm/_npx/0123abcd/node_modules/.bin/amdahl'
    expect((await cli(cached, 'whoami')).stderr).toContain('Run `npx -y amdahl login`')
    // Installed, the command is on PATH by its own name.
    const installed = fakeIo()
    installed.scriptPath = '/usr/local/lib/node_modules/@amdahl/cli/bin/amdahl.js'
    expect((await cli(installed, 'whoami')).stderr).toContain('Run `amdahl login`')
  })

  it('auth login / logout / status are aliases', () => {
    expect(parseCommandLine(['auth', 'login', '--workspace', 'acme']).command).toBe('login')
    expect(parseCommandLine(['auth', 'logout', '--all']).command).toBe('logout')
    expect(parseCommandLine(['auth', 'status', '--show-token']).command).toBe('whoami')
    expect(parseCommandLine(['auth', 'token']).command).toBe('auth token')
    expect(parseCommandLine(['--json', 'keys', 'revoke', 'abc', '--yes'])).toMatchObject({
      command: 'keys revoke',
      args: ['abc'],
      flags: { json: true, yes: true },
    })
  })

  it('a network failure exits 8', async () => {
    const io = fakeIo({ AMDAHL_API_URL: 'http://127.0.0.1:1', AMDAHL_KEY: 'amdhl_x' })
    const r = await cli(io, 'status', '--json')
    expect(r.code).toBe(8)
    expect(r.json.error.code).toBe('network_error')
  })

  it('status prints the degraded shape the server sends when a read fails', async () => {
    const io = await loggedIn({ degradedStatus: true })
    const r = await cli(io, 'status')
    expect(r.code).toBe(0)
    expect(r.stdout + r.stderr).toContain('Workspace:  unknown')
    expect(r.stdout + r.stderr).toContain('Connections: could not be read right now')
  })

  it('--version and --help', async () => {
    const io = fakeIo()
    expect((await cli(io, '--version')).stdout).toBe('0.4.9\n')
    expect((await cli(io, '-v')).stdout).toBe('0.4.9\n')
    expect((await cli(io, '--help')).stdout).toContain('Usage: amdahl')
    expect(VERSION).toBe(pkg.version)
  })

  it('--help lists what you can do, and --json does not change it', async () => {
    const io = fakeIo()
    const help = (await cli(io, '--help')).stdout
    expect(help).toMatchSnapshot()
    expect(help).toContain('Everything Amdahl can do: https://docs.amdahl.ai/skills/amdahl/SKILL.md')
    expect((await cli(io, '--help', '--json')).stdout).toBe(help)
    // Every line fits an 80-column terminal.
    expect(help.split('\n').filter((line) => line.length > 79)).toEqual([])
  })
})

describe('optimize', () => {
  it('runs files one after another and returns an array for several', async () => {
    const io = await loggedIn()
    const dir = io.homedir
    writeFileSync(join(dir, 'a.md'), 'first draft')
    writeFileSync(join(dir, 'b.md'), 'second draft')
    writeFileSync(join(dir, 'ctx.json'), JSON.stringify({ rules: ['be brief'], voice_examples: [], facts: [] }))
    const r = await cli(io, 'optimize', join(dir, 'a.md'), join(dir, 'b.md'), '--context', join(dir, 'ctx.json'), '--tries', '--json')
    expect(r.code).toBe(0)
    expect(r.json).toHaveLength(2)
    expect(r.json[1]).toMatchObject({ ok: true, file: join(dir, 'b.md'), result: { message: 'better: second draft' } })
    const bodies = server!.log.filter((l) => l.path.endsWith('/messages/optimize')).map((l) => JSON.parse(l.body))
    expect(bodies[0]).toEqual({ message: 'first draft', include_tries: true, context: { rules: ['be brief'], voice_examples: [], facts: [] } })
  })

  it('prints only the rewrite on stdout without --json', async () => {
    const io = await loggedIn()
    writeFileSync(join(io.homedir, 'a.md'), 'draft')
    const r = await cli(io, 'optimize', join(io.homedir, 'a.md'))
    expect(r.stdout).toBe('better: draft\n')
  })

  it('prints what Amdahl did on stderr after the message, and nothing extra under --json', async () => {
    const optimizeResult = {
      ok: true,
      outcome: 'rewritten',
      message: 'Hi Sam, ...',
      summary: 'Wrote it from your facts.',
      what_changed: 'Cut the opener and 3 more sentences, replaced the ask',
      steps: [
        { node: 'w1', changed: false, reason: 'not_planned' },
        { node: 'w2', changed: true, reason: 'wrote_one_version' },
        { node: 'w3', changed: true, reason: 'repaired:2,deleted:1' },
        { node: 'w4', changed: false, reason: 'weakest:ask' },
        { node: 'w5', changed: true, reason: 'repaired:ask' },
        { node: 'w6', changed: false, reason: 'no_draft' },
        { node: 'w7', changed: false, reason: 'message' },
      ],
      omitted: [
        { what: 'The customer count', why: 'None of the facts gives a customer count.' },
        { what: 'A sentence', why: 'Nothing you sent backs it' },
        { what: 'Another sentence', why: 'Nothing you sent backs it' },
      ],
      evidence: { requested: 'workspace', used: true },
      lift: { quotes: 20 },
      unsupported_claims: [{ span: 'we cut onboarding 40%', status: 'kept' }, { span: 'x', status: 'removed' }],
      context_use: { pack_id: 'cp_1', identity: 'high', rows: [{ row: 'r', bucket: 'internal', verdict: 'pass', cited_id: 'ci_3' }] },
    }
    const io = await loggedIn({ optimizeResult })
    writeFileSync(join(io.homedir, 'a.md'), 'draft')
    const r = await cli(io, 'optimize', join(io.homedir, 'a.md'))
    expect(r.stdout).toBe('Hi Sam, ...\n')
    expect(r.stderr).toBe(
      [
        'Wrote it from your facts.',
        "Removed 1 claim your calls don't back.",
        'Left out 3 things: None of the facts gives a customer count. (1 more reason in --json)',
        "Flagged 1 claim your calls don't back; check before sending.",
        '',
      ].join('\n')
    )
    // `what_changed` is the same sentence on every run, so it is not printed.
    expect(r.stderr).not.toContain('Cut the opener')

    const json = await cli(io, 'optimize', join(io.homedir, 'a.md'), '--json')
    expect(json.json).toEqual({ ok: true, file: join(io.homedir, 'a.md'), result: optimizeResult })
    expect(json.stderr).not.toContain('Flagged')
  })

  it('sends X-Amdahl-Client: cli/<version> and User-Agent: amdahl-cli/<version> on every request to the API', async () => {
    const io = await loggedIn()
    writeFileSync(join(io.homedir, 'a.md'), 'draft')
    expect((await cli(io, 'optimize', join(io.homedir, 'a.md'))).code).toBe(0)
    expect(server!.log.some((l) => l.path.endsWith('/messages/optimize'))).toBe(true)
    expect(server!.log.some((l) => l.path === '/oauth/token')).toBe(true)
    // The browser, not the CLI, opens the authorize page.
    const fromCli = server!.log.filter((l) => !l.path.startsWith('/oauth/authorize'))
    for (const l of fromCli) {
      expect(l.headers['x-amdahl-client'], l.path).toBe(`cli/${VERSION}`)
      expect(l.headers['user-agent'], l.path).toBe(`amdahl-cli/${VERSION}`)
    }
  })

  it('ends each run with its run id; the staff-only feedback link prints only when turned on', async () => {
    const io = await loggedIn()
    const file = join(io.homedir, 'a.md')
    writeFileSync(file, 'draft')
    const sentIt = 'Sent it? amdahl sent r1 --provider <provider> --channel <channel> --sent-as returned --provider-send-id <id>\nOr say how it went: amdahl feedback r1 --evidence did_it_myself --outcome used\n'
    const run = `Tighter opener.\nRun: r1\n${sentIt}`
    const link = `Tighter opener.\nRun: r1\nFeedback: http://localhost:4000/admin/optimizer/runs/r1\n${sentIt}`

    // Off by default: the run page is internal, so customers see only the id.
    expect((await cli(io, 'optimize', file)).stderr).toBe(run)
    expect((await cli(io, 'optimize', file, '--json')).stderr).toBe('')

    io.env.AMDAHL_FEEDBACK_LINK = '1'
    expect((await cli(io, 'optimize', file)).stderr).toBe(link)
    expect((await cli(io, 'optimize', file, '--json')).stderr).toBe('')

    io.env.AMDAHL_CONSOLE_URL = 'https://console.example.test/'
    expect((await cli(io, 'optimize', file)).stderr).toContain(
      'Feedback: https://console.example.test/admin/optimizer/runs/r1\n'
    )
    delete io.env.AMDAHL_CONSOLE_URL
    delete io.env.AMDAHL_FEEDBACK_LINK

    const config = JSON.parse(readFileSync(configPath(io), 'utf8'))
    writeFileSync(configPath(io), JSON.stringify({ ...config, feedbackLink: true }))
    expect((await cli(io, 'optimize', file)).stderr).toBe(link)

    io.env.AMDAHL_FEEDBACK_LINK = '0'
    expect((await cli(io, 'optimize', file)).stderr).toBe(run)
  })

  it('keeps feedbackLink in the config when a sign-in rewrites the file', async () => {
    const io = await loggedIn()
    const config = JSON.parse(readFileSync(configPath(io), 'utf8'))
    writeFileSync(configPath(io), JSON.stringify({ ...config, feedbackLink: true }))
    expect((await cli(io, 'login', '--json')).code).toBe(0)
    expect(JSON.parse(readFileSync(configPath(io), 'utf8')).feedbackLink).toBe(true)
  })

  it('what Amdahl did: steps and omitted reasons fill the lines left, at most three', () => {
    const steps = [
      { node: 'w3', changed: true, reason: 'repaired:2,deleted:1,open:1' },
      { node: 'w5', changed: true, reason: 'repaired:ask' },
      { node: 'w6', changed: true, reason: 'kept_before_repair:adds_claim' },
    ]
    const omitted = [
      { what: 'a', why: 'None of the facts gives a customer count' },
      { what: 'b', why: 'Nothing you sent backs it.' },
      { what: 'c', why: 'Nothing you sent backs it.' },
    ]
    expect(whatAmdahlDid({ steps, omitted })).toEqual([
      'Rewrote 2 sentences and cut 1 that nothing backed. Reworked the ask.',
      'Left out 3 things: None of the facts gives a customer count. (1 more reason in --json)',
      'Flagged 1 sentence problem it could not fix; check before sending.',
    ])
    // With more to say, the step trail is the first line dropped.
    const full = whatAmdahlDid({
      what_changed: 'Cut the opener',
      steps,
      evidence: { requested: 'workspace', used: true },
      unsupported_claims: [],
      context_use: { rows: [{ bucket: 'external', verdict: 'pass' }, { bucket: 'internal', verdict: 'fail' }] },
    })
    expect(full).toEqual([
      "Checked every claim against your calls and found none they don't back.",
      'Used 1 source: what their company or market published.',
      'Flagged 1 sentence problem it could not fix; check before sending.',
    ])
    // `what_changed` is never a line: it is the same sentence on every run.
    expect(whatAmdahlDid({ what_changed: 'Wrote this message from the context you sent.' })).toEqual([])
    expect(
      whatAmdahlDid({
        evidence: { requested: 'workspace', used: true },
        lift: { quotes: 20 },
        unsupported_claims: [{ status: 'removed' }, { status: 'removed' }],
        context_use: { rows: [{ bucket: 'internal', verdict: 'pass' }, { bucket: 'external', verdict: 'pass' }] },
      })
    ).toEqual([
      'Checked every claim against your calls (20 quotes).',
      "Removed 2 claims your calls don't back.",
      "Used 2 sources: Amdahl's own records and what their company or market published.",
    ])
    // A kept draft is not what the steps describe.
    expect(whatAmdahlDid({ unchanged: true, steps })).toEqual([])
    // An unknown second-check reason still asks for a check.
    expect(whatAmdahlDid({ steps: [{ node: 'w6', changed: true, reason: 'something_new' }] })).toEqual([
      'Flagged a second-check concern; check before sending.',
    ])
  })

  it('prints no what-Amdahl-did section when the response says nothing worth reading', async () => {
    const io = await loggedIn({
      optimizeResult: {
        ok: true,
        message: 'Hi',
        summary: 'Tighter.',
        steps: [{ node: 'w3', changed: false, reason: 'no_open_problems' }, { node: 'w6', changed: false, reason: 'no_draft' }],
        omitted: [],
        evidence: { requested: 'off', used: false, reason: 'not_requested' },
        unsupported_claims: null,
      },
    })
    writeFileSync(join(io.homedir, 'a.md'), 'draft')
    const r = await cli(io, 'optimize', join(io.homedir, 'a.md'))
    expect(r.stdout).toBe('Hi\n')
    expect(r.stderr).toBe('Tighter.\n')
  })

  it('names a second-check concern, a missed evidence read and strips control characters; an empty workspace gets the connect line', async () => {
    const io = await loggedIn({
      optimizeResult: {
        ok: true,
        message: 'Hi',
        what_changed: 'Wrote this message from the context you sent.',
        omitted: [{ what: 'a', why: 'Nothing\u001b[2J backs it.' }],
        steps: [{ node: 'w6', changed: true, reason: 'drops_ask' }],
        evidence: { requested: 'workspace', used: false, reason: 'corpus_empty' },
        unsupported_claims: null,
      },
    })
    writeFileSync(join(io.homedir, 'a.md'), 'draft')
    const r = await cli(io, 'optimize', join(io.homedir, 'a.md'))
    expect(r.stderr).toBe(
      [
        'Skipped checking claims against your calls: the workspace has none yet.',
        'Left out 1 thing: Nothing[2J backs it.',
        'Flagged a second-check concern (it leaves out your ask); check before sending.',
        'Connect calls or a CRM so Amdahl checks claims against them: amdahl connect',
        '',
      ].join('\n')
    )
  })

  it('an ok:false result exits 1 and prints its reason', async () => {
    const io = await loggedIn({ optimizeResult: { ok: false, reason: 'optimizer_timeout', detail: 'Took too long.' } })
    io.stdinIsTTY = false
    io.stdinText = 'draft'
    const r = await cli(io, 'optimize', '--json')
    expect(r.code).toBe(1)
    expect(r.json).toMatchObject({ ok: false, file: '-', result: { ok: false, reason: 'optimizer_timeout' } })
    expect(r.stderr).toContain('optimizer_timeout')
  })

  it('a quota refusal exits 6', async () => {
    const io = await loggedIn({
      optimizeResult: { ok: false, success: false, error: { code: 'quota_exceeded', message: 'Monthly limit reached.' } },
    })
    io.stdinIsTTY = false
    io.stdinText = 'draft'
    const r = await cli(io, 'optimize', '--json')
    expect(r.code).toBe(6)
    expect(r.json.error.code).toBe('quota_exceeded')
  })

  it('no file with AMDAHL_NO_PROMPT=1 at a terminal is a usage error; a bad flag value too', async () => {
    const io = await loggedIn()
    io.env.AMDAHL_NO_PROMPT = '1'
    expect((await cli(io, 'optimize')).code).toBe(2)
    expect((await cli(io, 'optimize', '-', '--channel', 'fax')).code).toBe(2)
  })

  it.each<[string, Record<string, string>]>([
    ['Claude Code runs it', { CLAUDECODE: '1' }],
    ['Cursor runs it', { CURSOR_AGENT: '1' }],
    ['CI is set', { CI: 'true' }],
    ['Jenkins (no CI variable)', { JENKINS_URL: 'https://ci.example' }],
  ])('no file at a terminal when %s: the usage (exit 2), no paste prompt, no browser', async (_label, env) => {
    server = await startMockServer()
    const io = fakeIo({ AMDAHL_API_URL: server.url, ...env })
    const r = await cli(io, 'optimize')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('Give a file to optimize, or pipe the message on stdin.')
    expect(io.prompts).toEqual([])
    expect(io.opened).toEqual([])
    expect(server.log.filter((l) => l.path.endsWith('/messages/optimize'))).toEqual([])
  })
})

describe('optimize with no file at a terminal', () => {
  it('asks for a paste, sends it with the flags, and shows Amdahl\'s version, what it did and how to run it next time', async () => {
    const io = await loggedIn({ optimizeResult: { ok: true, message: 'Hi Sam, short.', summary: 'Tighter.', what_changed: 'Cut the opener' } })
    io.env.npm_command = 'exec'
    io.platform = 'darwin'
    io.answers.push('Hi Sam,\n\nLong draft.')
    const r = await cli(io, 'optimize', '--channel', 'linkedin')
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([PASTE_PROMPT])
    expect(r.stdout).toBe('Hi Sam, short.\n')
    expect(r.stderr).toBe(
      `Amdahl is rewriting it. This can take a minute.\n${VERSION_RULE}\nNext time: npx -y amdahl optimize draft.txt,\nor pbpaste | npx -y amdahl optimize -\n`
    )
    const bodies = server!.log.filter((l) => l.path.endsWith('/messages/optimize')).map((l) => JSON.parse(l.body))
    expect(bodies).toEqual([{ message: 'Hi Sam,\n\nLong draft.', channel: 'linkedin' }])
  })

  it('not signed in: signs in through the browser first, then asks for the paste', async () => {
    server = await startMockServer()
    const io = fakeIo({ AMDAHL_API_URL: server.url })
    io.answers.push('draft')
    const r = await cli(io, 'optimize')
    expect(r.code).toBe(0)
    expect(io.opened).toHaveLength(1)
    expect(r.stderr).toContain('Sign in first, then paste your message.\nNew to Amdahl? The sign-in sets up your free workspace.\nOpening your browser…\n✓ Signed in · Acme\n')
    expect(r.stdout).toBe('better: draft\n')
    // The sign-in is kept for next time.
    io.answers.push('again')
    expect((await cli(io, 'optimize')).stdout).toBe('better: again\n')
    expect(io.opened).toHaveLength(1)
  })

  it('nothing pasted sends nothing; Ctrl+C stops (exit 130)', async () => {
    const io = await loggedIn()
    io.answers.push('')
    const r = await cli(io, 'optimize')
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: 'Nothing pasted, so nothing was sent.\nNext time: amdahl optimize draft.txt\n' })
    io.answers.push(null)
    expect(await cli(io, 'optimize')).toMatchObject({ code: 130, stderr: 'Stopped. Nothing changed.\n' })
    expect(server!.log.filter((l) => l.path.endsWith('/messages/optimize'))).toEqual([])
  })

  it('with --json: the same JSON as a file run, and no extra lines', async () => {
    const io = await loggedIn()
    io.answers.push('draft')
    const r = await cli(io, 'optimize', '--json')
    expect(r.json).toMatchObject({ ok: true, file: '-', result: { message: 'better: draft' } })
    expect(r.stderr).toBe('Amdahl is rewriting it. This can take a minute.\n')
  })

  it('an ok:false result exits 1 with its reason', async () => {
    const io = await loggedIn({ optimizeResult: { ok: false, reason: 'optimizer_timeout', detail: 'Took too long.' } })
    io.answers.push('draft')
    const r = await cli(io, 'optimize')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Not optimized (optimizer_timeout): Took too long.\n')
  })

  it('a piped stdin is still read whole, with no question', async () => {
    const io = await loggedIn()
    io.stdinIsTTY = false
    io.stdinText = 'piped draft'
    const r = await cli(io, 'optimize')
    expect(r.stdout).toBe('better: piped draft\n')
    expect(io.prompts).toEqual([])
  })
})

describe('keys edge cases', () => {
  it('a denied request exits 7', async () => {
    const io = await loggedIn({ decision: 'denied' })
    const r = await cli(io, 'keys', 'create', '--name', 'x', '--no-browser', '--json')
    expect(r.code).toBe(7)
    expect(r.json.error.code).toBe('request_denied')
    expect(r.stdout).not.toContain('amdhl_')
  })

  it('an expired request exits 7', async () => {
    const io = await loggedIn({ decision: 'expired' })
    const r = await cli(io, 'keys', 'create', '--name', 'x', '--no-browser', '--json')
    expect(r.code).toBe(7)
    expect(r.json.error.code).toBe('request_expired')
  })

  it('defaults to read-only for 90 days', async () => {
    const io = await loggedIn()
    await cli(io, 'keys', 'create', '--name', 'x', '--no-browser', '--json')
    const [req] = [...server!.keyRequests.values()]
    expect(req).toMatchObject({ bundle_name: 'mcp_read_only', expires_in_days: 90 })
    expect(io.opened.filter((u) => u.includes('/cli/approve'))).toEqual([])
  })

  it('rejects an unknown preset or expiry', async () => {
    const io = await loggedIn()
    expect((await cli(io, 'keys', 'create', '--name', 'x', '--preset', 'god')).code).toBe(2)
    expect((await cli(io, 'keys', 'create', '--name', 'x', '--expires', 'never')).code).toBe(2)
  })

  it('revoke without --yes exits 2 when non-interactive', async () => {
    const io = await loggedIn()
    io.env.AMDAHL_NO_PROMPT = '1'
    const r = await cli(io, 'keys', 'revoke', 'amdhl_deadbeef', '--json')
    expect(r.code).toBe(2)
    expect(server!.keyRequests.size).toBe(0)
  })

  it('revoke aborts when the typed name does not match', async () => {
    const io = await loggedIn()
    io.answers.push('wrong')
    const r = await cli(io, 'keys', 'revoke', 'amdhl_deadbeef', '--json')
    expect(r.code).toBe(1)
    expect(server!.keyRequests.size).toBe(0)
  })

  it('revoke --yes skips the prompt and sends the key id', async () => {
    const io = await loggedIn()
    const r = await cli(io, 'keys', 'revoke', '33333333-3333-4333-8333-333333333333', '--yes', '--json')
    expect(r.code).toBe(0)
    const [req] = [...server!.keyRequests.values()]
    expect(req).toMatchObject({ action: 'revoke', key_id: '33333333-3333-4333-8333-333333333333' })
  })
})

describe('install', () => {
  it('codex appends once, then reports unchanged', async () => {
    const io = fakeIo({ AMDAHL_API_URL: 'https://staging.amdahl.ai' })
    const path = join(io.homedir, '.codex', 'config.toml')
    mkdirSync(join(io.homedir, '.codex'))
    writeFileSync(path, 'model = "o3"\n')
    const first = await cli(io, 'install', 'codex', '--json')
    const skill = join(io.homedir, '.agents', 'skills', 'amdahl', 'SKILL.md')
    expect(first.json).toEqual({ ok: true, client: 'codex', action: 'wrote', path, skill: { action: 'wrote', path: skill } })
    const second = await cli(io, 'install', 'codex', '--json')
    expect(second.json).toEqual({ ok: true, client: 'codex', action: 'unchanged', path, skill: { action: 'unchanged', path: skill } })
    expect(readFileSync(path, 'utf8')).toBe(
      'model = "o3"\n\n[mcp_servers.amdahl]\nurl = "https://staging.amdahl.ai/mcp"\nrequired = true\n'
    )
  })

  it('codex leaves an existing amdahl section alone', async () => {
    const io = fakeIo()
    mkdirSync(join(io.homedir, '.codex'))
    const path = join(io.homedir, '.codex', 'config.toml')
    writeFileSync(path, '[mcp_servers.amdahl]\nurl = "https://elsewhere/mcp"\n')
    expect((await cli(io, 'install', 'codex', '--json')).json.action).toBe('unchanged')
    expect(readFileSync(path, 'utf8')).toContain('elsewhere')
  })

  it('cursor merges into mcpServers and never writes a token', async () => {
    const io = fakeIo({ AMDAHL_KEY: 'amdhl_should_not_appear' })
    mkdirSync(join(io.homedir, '.cursor'))
    const path = join(io.homedir, '.cursor', 'mcp.json')
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { url: 'x' } }, theme: 'dark' }))
    const r = await cli(io, 'install', 'cursor', '--json')
    expect(r.json).toEqual({
      ok: true,
      client: 'cursor',
      action: 'wrote',
      path,
      skill: { action: 'wrote', path: join(io.homedir, '.cursor', 'skills', 'amdahl', 'SKILL.md') },
    })
    const written = readFileSync(path, 'utf8')
    expect(JSON.parse(written)).toEqual({
      mcpServers: { other: { url: 'x' }, amdahl: { url: 'https://app.amdahl.ai/mcp' } },
      theme: 'dark',
    })
    expect(written).not.toContain('amdhl_')
    expect((await cli(io, 'install', 'cursor', '--json')).json.action).toBe('unchanged')
  })

  it('--print writes nothing', async () => {
    const io = fakeIo()
    const r = await cli(io, 'install', 'cursor', '--print', '--json')
    expect(r.json.action).toBe('printed')
    expect(r.json.skill).toEqual({ action: 'printed', path: join(io.homedir, '.cursor', 'skills', 'amdahl', 'SKILL.md') })
    expect(existsSync(join(io.homedir, '.cursor'))).toBe(false)
  })

  it('claude-code runs `claude mcp add` when claude is on PATH, and --print only prints it', async () => {
    const io = fakeIo()
    const printed = await cli(io, 'install', 'claude-code', '--print', '--json')
    expect(printed.json).toEqual({
      ok: true,
      client: 'claude-code',
      action: 'printed',
      command: 'claude mcp add --scope user --transport http amdahl https://app.amdahl.ai/mcp',
      skill: { action: 'printed', path: join(io.homedir, '.claude', 'skills', 'amdahl', 'SKILL.md') },
    })
    expect(existsSync(join(io.homedir, '.claude.json'))).toBe(false)
    io.run.mockImplementation(async () => ({ code: 0, stdout: '', stderr: '' }))
    const ran = await cli(io, 'install', 'claude-code', '--json')
    expect(ran.json.action).toBe('ran')
    expect(io.run).toHaveBeenLastCalledWith('claude', ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'amdahl', 'https://app.amdahl.ai/mcp'])
  })

  it('claude-code skips `claude mcp add` when Amdahl is already there at this URL, and still adds the skill', async () => {
    const io = fakeIo()
    io.run.mockImplementation(async (command: string, args: string[]) =>
      args[1] === 'get'
        ? { code: 0, stdout: 'amdahl:\n  URL: https://app.amdahl.ai/mcp\n  Headers:\n    X-API-Key: amdhl_secret_header\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' }
    )
    const r = await cli(io, 'install', 'claude-code', '--json')
    expect(r.code).toBe(0)
    expect(r.json).toEqual({
      ok: true,
      client: 'claude-code',
      action: 'unchanged',
      command: 'claude mcp add --scope user --transport http amdahl https://app.amdahl.ai/mcp',
      skill: { action: 'wrote', path: join(io.homedir, '.claude', 'skills', 'amdahl', 'SKILL.md') },
    })
    expect(io.run.mock.calls.filter((c) => c[0] === 'claude').map((c) => (c[1] as string[])[1])).toEqual(['get'])
    expect(r.stdout + r.stderr).not.toContain('amdhl_secret_header')
    // At another URL it still tries the add (which Claude Code refuses for an existing name).
    io.run.mockImplementation(async (command: string, args: string[]) =>
      args[1] === 'get' ? { code: 0, stdout: 'amdahl:\n  URL: https://elsewhere/mcp\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }
    )
    expect((await cli(io, 'install', 'claude-code', '--json')).json.action).toBe('ran')
  })

  it.each<[string, string]>([
    ['cursor', 'mcp.json'],
    ['codex', 'config.toml'],
  ])('%s: a config file it cannot write exits 1 with write_failed, not a network error', async (client, file) => {
    const io = fakeIo()
    const dir = join(io.homedir, `.${client}`)
    writeFileSync(dir, 'a file where the folder should be')
    const r = await cli(io, 'install', client, '--json')
    expect(r.code).toBe(1)
    expect(r.json.error.code).toBe('write_failed')
    expect(r.json.error.message).toMatch(new RegExp(`^Could not update ${join(dir, file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(`))
  })

  it('claude-code installs the bundled skill next to the MCP server', async () => {
    const io = fakeIo()
    io.run.mockImplementation(async () => ({ code: 0, stdout: '', stderr: '' }))
    const path = join(io.homedir, '.claude', 'skills', 'amdahl', 'SKILL.md')
    const r = await cli(io, 'install', 'claude-code')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(
      `Added Amdahl to Claude Code for all your projects. Run /mcp in Claude Code to sign in. If amdahl is not listed there, restart Claude Code first.\nAdded the Amdahl skill (what Amdahl can do) at ${path}.\n`
    )
    expect(readFileSync(path, 'utf8')).toBe(SKILL_TEXT)
    expect((await cli(io, 'install', 'claude-code', '--json')).json.skill).toEqual({ action: 'unchanged', path })
  })

  it('keeps a changed skill file unless --force', async () => {
    const io = fakeIo()
    io.run.mockImplementation(async () => ({ code: 0, stdout: '', stderr: '' }))
    const path = join(io.homedir, '.claude', 'skills', 'amdahl', 'SKILL.md')
    mkdirSync(join(io.homedir, '.claude', 'skills', 'amdahl'), { recursive: true })
    writeFileSync(path, 'my notes\n')
    const kept = await cli(io, 'install', 'claude-code', '--json')
    expect(kept.code).toBe(0)
    expect(kept.json.skill).toEqual({ action: 'kept', path })
    expect(kept.stderr).toBe(
      `Kept ${path}: it differs from every Amdahl skill this CLI has shipped, so it may have your edits. Run again with --force to replace it with the current Amdahl skill.\n`
    )
    expect(readFileSync(path, 'utf8')).toBe('my notes\n')
    const forced = await cli(io, 'install', 'claude-code', '--force', '--json')
    expect(forced.json.skill).toEqual({ action: 'replaced', path })
    expect(readFileSync(path, 'utf8')).toBe(SKILL_TEXT)
  })

  it('upgrades a skill an earlier release installed, without --force', async () => {
    const io = fakeIo()
    io.run.mockImplementation(async () => ({ code: 0, stdout: '', stderr: '' }))
    const path = join(io.homedir, '.claude', 'skills', 'amdahl', 'SKILL.md')
    mkdirSync(join(io.homedir, '.claude', 'skills', 'amdahl'), { recursive: true })
    writeFileSync(path, readFileSync(join(__dirname, 'fixtures', 'skill-0.1.3.md'), 'utf8'))
    const r = await cli(io, 'install', 'claude-code', '--json')
    expect(r.json.skill).toEqual({ action: 'replaced', path })
    expect(r.stderr).toBe('')
    expect(readFileSync(path, 'utf8')).toBe(SKILL_TEXT)
  })

  it('knows every skill an earlier release shipped, and not the bundled one', () => {
    expect(isShippedSkill(readFileSync(join(__dirname, 'fixtures', 'skill-0.1.3.md'), 'utf8'))).toBe(true)
    expect(isShippedSkill(SKILL_TEXT)).toBe(false)
  })

  it('claude-code --print shows the skill path and writes nothing', async () => {
    const io = fakeIo()
    const path = join(io.homedir, '.claude', 'skills', 'amdahl', 'SKILL.md')
    const r = await cli(io, 'install', 'claude-code', '--print')
    expect(r.stdout).toBe(`claude mcp add --scope user --transport http amdahl https://app.amdahl.ai/mcp\n# Amdahl skill: ${path}\n`)
    expect(existsSync(join(io.homedir, '.claude'))).toBe(false)
    expect(io.run).not.toHaveBeenCalled()
  })

  it('the bundled skill is the amdahl SKILL.md', () => {
    const bundled = readFileSync(join(__dirname, '..', 'skill', 'SKILL.md'), 'utf8')
    expect(SKILL_TEXT).toBe(bundled)
    expect(bundled).toMatch(/^---\nname: amdahl\ndescription: .+\n---\n/)
  })

  it('an unknown client is a usage error', async () => {
    expect((await cli(fakeIo(), 'install', 'vim')).code).toBe(2)
  })
})

describe('workspace profiles', () => {
  it('lists profiles and switches the default', async () => {
    const io = await loggedIn()
    const list = await cli(io, 'workspace', 'list', '--json')
    expect(list.json).toEqual({
      ok: true,
      default: 'acme',
      profiles: [{ name: 'acme', workspace: { id: expect.any(String), name: 'Acme', slug: 'acme' }, email: 'dev@example.com', api_url: server!.url }],
    })
    expect((await cli(io, 'workspace', 'use', 'nope')).code).toBe(2)
    expect((await cli(io, 'workspace', 'use', 'acme', '--json')).json).toEqual({ ok: true, default: 'acme' })
  })
})
