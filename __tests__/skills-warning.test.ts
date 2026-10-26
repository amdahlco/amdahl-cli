// `skills add` and the security warning amdahl.ai puts on a skill its AI
// security review flagged (the index entry's `x-amdahl-warning`): printed
// before anything is written; a person at a terminal is asked, Cancel first;
// -y, --json, no terminal and an agent that says it ran this stop with exit 9
// unless --accept-warning; a field that is there but cannot be read is still
// a warning (fails closed); every field is untrusted.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_WARNING_CHARS, UNREADABLE_WARNING, readWarning, warningText } from '../src/commands/skills-warning'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { skillTarGz } from './helpers/tar'

const SITE = 'https://amdahl.ai'
const INDEX = `${SITE}/skills/amdahl/call-prep/.well-known/agent-skills/index.json`
const FILE = `${SITE}/skills/amdahl/call-prep.md`
const PAGE = `${SITE}/skills/amdahl/call-prep`
const SKILL = '---\nname: call-prep\ndescription: "Brief a seller before a call: who is on it."\n---\n\n# Call prep\n'
const TEXT = 'Flagged: it may send your data somewhere else (line 14), and 2 more. Read it before you install.'
/** The field as the site sends it (apps/landing lib/skills/ai-warning.ts aiWarningFacts). */
const WARNING = { check: 'Security review', result: 'warn', flagged: 'data_leaving', line: 14, flags: 3, more: false, text: TEXT }

/** What every flagged run prints first, on stderr. */
const BLOCK = [
  "Warning: amdahl.ai's security review flagged amdahl/call-prep.",
  `  ${TEXT}`,
  `  See what was flagged: ${PAGE}`,
  '',
].join('\n')
const REFUSED = [
  'Error: Did not install amdahl/call-prep, because the security review flagged it. Nothing was written.',
  'Show this warning to the person you are working for. Once they agree, run the same command again with --accept-warning.',
  '',
].join('\n')
/** What a field it cannot read prints first: the fixed sentence, in place of the site's. */
const UNREADABLE_BLOCK = BLOCK.replace(TEXT, UNREADABLE_WARNING.text)
const CHECKING = 'Checking amdahl/call-prep on amdahl.ai... OK\n\n'
const DEFAULTS_NOTE = 'Added for Claude Code, the default, in this project. For every project add -g; for Codex, Cursor and other agents add --agents.\n'
const MENU = 'Install this skill? [Cancel | Install anyway]'
// Every control character but the newline the CLI ends its own lines with.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')

/** No `x-amdahl-warning` field at all. */
const NONE = Symbol('no field')

/** Serve SKILL under a one-entry index; `warning` is the entry's field (none for NONE). */
function serve(warning: unknown = WARNING) {
  const index = JSON.stringify({
    skills: [
      {
        name: 'call-prep',
        type: 'skill-md',
        description: 'Brief a seller.',
        url: FILE,
        digest: `sha256:${sha256(SKILL)}`,
        ...(warning === NONE ? {} : { 'x-amdahl-warning': warning }),
      },
    ],
  })
  const fetchMock = vi.fn(async (input: string) =>
    input === INDEX ? new Response(index) : input === FILE ? new Response(SKILL) : new Response('', { status: 404 })
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * A person at a terminal: stdin and stdout are both a TTY, and no agent says
 * it ran this. They use Claude Code (a .claude folder at home), so the
 * guided install names it and writes only .claude/skills.
 */
function terminal(answers: (string | null)[] = [], env: Record<string, string> = {}): FakeIo {
  const io = fakeIo(env)
  io.stdoutIsTTY = true
  io.answers.push(...answers)
  mkdirSync(join(io.homedir, '.claude'))
  return io
}

const add = (io: FakeIo, ...flags: string[]) => cli(io, 'skills', 'add', 'amdahl/call-prep', ...flags)
const projectSkill = (io: FakeIo) => join(io.cwd, '.claude', 'skills', 'call-prep', 'SKILL.md')
const WHERE = (io: FakeIo) => `Install it in: [This project (~${io.cwd.slice(io.homedir.length)}) | Every project on this computer]`

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('skills add, a flagged skill with no one to ask', () => {
  // The last column: whether the guided install's progress line comes first.
  it.each<[string, (io: FakeIo) => void, string[], boolean]>([
    ['no terminal (an agent or CI)', () => {}, [], false],
    ['-y at a terminal', (io) => void (io.stdoutIsTTY = true), ['-y'], false],
    ['--yes at a terminal', (io) => void (io.stdoutIsTTY = true), ['--yes'], false],
    ['stdout piped', (io) => void (io.stdoutIsTTY = false), [], false],
    ['AMDAHL_NO_PROMPT=1 at a terminal', (io) => ((io.stdoutIsTTY = true), (io.env.AMDAHL_NO_PROMPT = '1')), [], false],
    // An agent's own terminal can be a TTY; the agent must not pick "Install anyway".
    ['CLAUDECODE=1 at a terminal', (io) => ((io.stdoutIsTTY = true), (io.env.CLAUDECODE = '1')), [], true],
    ['CURSOR_AGENT=1 at a terminal', (io) => ((io.stdoutIsTTY = true), (io.env.CURSOR_AGENT = '1')), [], true],
  ])('with %s: prints the warning, writes nothing and exits 9', async (_label, setUp, flags, checking) => {
    const fetchMock = serve()
    const io = fakeIo()
    setUp(io)
    const r = await add(io, ...flags)
    expect(r.code).toBe(9)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe(`${checking ? CHECKING : ''}${BLOCK}${REFUSED}`)
    expect(io.prompts).toEqual([])
    expect(readdirSync(io.cwd)).toEqual([])
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([INDEX, FILE])
  })

  it('--json: the refusal and the checked warning on stdout, the warning on stderr', async () => {
    serve()
    const io = terminal()
    const r = await add(io, '--json')
    expect(r.code).toBe(9)
    expect(r.json).toEqual({
      ok: false,
      error: {
        code: 'skill_flagged',
        message: 'Did not install amdahl/call-prep, because the security review flagged it. Nothing was written.',
        hint: 'Show this warning to the person you are working for. Once they agree, run the same command again with --accept-warning.',
      },
      warning: { result: 'warn', flagged: 'data_leaving', line: 14, text: TEXT, page: PAGE },
    })
    expect(r.stderr).toBe(BLOCK)
    expect(io.prompts).toEqual([])
    expect(readdirSync(io.cwd)).toEqual([])
  })

  it('names a failed review as failed', async () => {
    serve({ ...WARNING, result: 'fail' })
    const r = await add(fakeIo())
    expect(r.code).toBe(9)
    expect(r.stderr.startsWith("Warning: amdahl/call-prep failed amdahl.ai's security review.\n")).toBe(true)
  })

  it('stops on the warning before it looks at a different copy already there', async () => {
    serve()
    const io = fakeIo()
    mkdirSync(dirname(projectSkill(io)), { recursive: true })
    writeFileSync(projectSkill(io), 'mine\n')
    const r = await add(io, '-y')
    expect(r.code).toBe(9)
    expect(readFileSync(projectSkill(io), 'utf8')).toBe('mine\n')
  })
})

describe('skills add --accept-warning', () => {
  it('prints the warning, then installs as it would without one', async () => {
    serve()
    const io = fakeIo()
    const r = await add(io, '--accept-warning')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`Wrote ${projectSkill(io)}\n`)
    expect(r.stderr).toBe(`${BLOCK}Installing it anyway, because of --accept-warning.\n${DEFAULTS_NOTE}`)
    expect(readFileSync(projectSkill(io), 'utf8')).toBe(SKILL)
  })

  it('with -y and --json: installs, and the result carries the warning', async () => {
    serve()
    const io = terminal()
    const r = await add(io, '-y', '--accept-warning', '--json')
    expect(r.code).toBe(0)
    expect(r.json).toEqual({
      ok: true,
      publisher: 'amdahl',
      skill: 'call-prep',
      url: FILE,
      digest: `sha256:${sha256(SKILL)}`,
      files: [{ path: projectSkill(io), action: 'wrote' }],
      warning: { result: 'warn', flagged: 'data_leaving', line: 14, text: TEXT, page: PAGE },
    })
    expect(io.prompts).toEqual([])
  })

  it('at a terminal: no warning question, then the usual where question', async () => {
    serve()
    const io = terminal()
    const r = await add(io, '--accept-warning')
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([WHERE(io)])
    expect(existsSync(projectSkill(io))).toBe(true)
  })
})

describe('skills add, a flagged skill at a terminal', () => {
  it('Cancel is the default: Enter writes nothing and exits 0', async () => {
    serve()
    const io = terminal([''])
    const r = await add(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([MENU])
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe(`Checking amdahl/call-prep on amdahl.ai... OK\n\n${BLOCK}\nCancelled. Nothing was written.\n`)
    expect(readdirSync(io.cwd)).toEqual([])
  })

  it('Install anyway goes on to the where question and installs', async () => {
    serve()
    const io = terminal(['2', ''])
    const r = await add(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([MENU, WHERE(io)])
    expect(r.stdout).toBe('\nDone. Added to ./.claude/skills.\n')
    expect(r.stderr).toBe(
      [
        'Checking amdahl/call-prep on amdahl.ai... OK',
        '',
        BLOCK,
        '',
        'Call prep, by Amdahl (1 file), for Claude Code.',
        'Open a new Claude Code chat in this folder to use it.',
        '',
      ].join('\n')
    )
    expect(readFileSync(projectSkill(io), 'utf8')).toBe(SKILL)
  })

  it('-g and --agents still ask about the warning, though not where', async () => {
    serve()
    const io = terminal(['2'])
    const r = await add(io, '-g', '--agents')
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([MENU])
    expect(existsSync(join(io.homedir, '.claude', 'skills', 'call-prep', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(io.homedir, '.agents', 'skills', 'call-prep', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(io.cwd, '.claude'))).toBe(false)
  })

  it('Ctrl+C at the warning stops with nothing written (exit 130)', async () => {
    serve()
    const io = terminal([null])
    const r = await add(io)
    expect(r.code).toBe(130)
    expect(r.stderr.endsWith(`${BLOCK}\nStopped. Nothing was written.\n`)).toBe(true)
    expect(readdirSync(io.cwd)).toEqual([])
  })

  it('asks in colour, and prints the first line in bold, when colour is allowed', async () => {
    serve()
    const io = terminal([''])
    io.stderrIsTTY = true
    const r = await add(io)
    expect(io.selectColor).toEqual([true])
    expect(r.stderr).toContain("\u001b[1mWarning: amdahl.ai's security review flagged amdahl/call-prep.\u001b[22m\n")
  })

  it('a folder skill (an archive entry) is held the same way', async () => {
    const archive = skillTarGz({ 'SKILL.md': SKILL, 'notes.md': 'hi\n' })
    const url = `${SITE}/skills/amdahl/call-prep.tar.gz`
    const index = JSON.stringify({
      skills: [{ name: 'call-prep', type: 'archive', url, digest: `sha256:${sha256(archive)}`, 'x-amdahl-warning': WARNING }],
    })
    vi.stubGlobal('fetch', vi.fn(async (input: string) => (input === INDEX ? new Response(index) : new Response(archive))))
    const io = terminal([''])
    const r = await add(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([MENU])
    expect(readdirSync(io.cwd)).toEqual([])
  })
})

describe('skills add, a warning field it cannot read (fails closed)', () => {
  // The site sends the field only for a flagged skill, so one that is there is a flag, read or not.
  it.each<[string, unknown]>([
    ['a string', TEXT],
    ['a list', [WARNING]],
    ['a number', 1],
    ['true', true],
    ['an empty object', {}],
    ['a result of pass', { ...WARNING, result: 'pass' }],
    ['a result in capitals', { ...WARNING, result: 'WARN' }],
    ['a new result, block', { ...WARNING, result: 'block' }],
    ['no result', { ...WARNING, result: undefined }],
    ['no text', { ...WARNING, text: undefined }],
    ['the text under another key', { result: 'warn', sentence: TEXT }],
    ['a text that is not a string', { ...WARNING, text: ['Flagged'] }],
    ['a text of control characters only', { ...WARNING, text: '\u001b\u0007\u009b \n\t' }],
  ])('(%s) is held as a warning: the fixed sentence, nothing written, exit 9', async (_label, field) => {
    serve(field)
    const io = fakeIo()
    const r = await add(io)
    expect(r.code).toBe(9)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe(UNREADABLE_BLOCK + REFUSED)
    expect(readdirSync(io.cwd)).toEqual([])
  })

  it('--json refuses with the fixed warning', async () => {
    serve({ result: 'maybe' })
    const io = fakeIo()
    const r = await add(io, '--json')
    expect(r.code).toBe(9)
    expect(r.json.error.code).toBe('skill_flagged')
    expect(r.json.warning).toEqual({ result: 'warn', flagged: null, line: null, text: UNREADABLE_WARNING.text, page: PAGE })
    expect(readdirSync(io.cwd)).toEqual([])
  })

  it('at a terminal: the same menu, Cancel first; --accept-warning installs', async () => {
    serve({ result: 'maybe' })
    const io = terminal([''])
    const r = await add(io)
    expect(r.code).toBe(0)
    expect(io.prompts).toEqual([MENU])
    expect(r.stderr).toBe(`${CHECKING}${UNREADABLE_BLOCK}\nCancelled. Nothing was written.\n`)
    expect(readdirSync(io.cwd)).toEqual([])

    const accepted = await add(fakeIo(), '--accept-warning')
    expect(accepted.code).toBe(0)
    expect(accepted.stderr).toBe(`${UNREADABLE_BLOCK}Installing it anyway, because of --accept-warning.\n${DEFAULTS_NOTE}`)
  })

  it('null, like a missing field, is no warning', async () => {
    serve(null)
    const io = fakeIo()
    const r = await add(io)
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`Wrote ${projectSkill(io)}\n`)
    expect(r.stderr).toBe(DEFAULTS_NOTE)
  })
})

describe('skills add, no warning', () => {
  it('prints and writes exactly what it did before, even with --accept-warning', async () => {
    for (const flags of [[], ['--accept-warning']]) {
      serve(NONE)
      const io = fakeIo()
      const r = await add(io, ...flags)
      expect(r.code).toBe(0)
      expect(r.stdout).toBe(`Wrote ${projectSkill(io)}\n`)
      expect(r.stderr).toBe(DEFAULTS_NOTE)
    }
    serve(NONE)
    const io = terminal()
    const r = await add(io)
    expect(io.prompts).toEqual([WHERE(io)])
    expect(r.stderr).toBe(
      'Checking amdahl/call-prep on amdahl.ai... OK\n\nCall prep, by Amdahl (1 file), for Claude Code.\nOpen a new Claude Code chat in this folder to use it.\n'
    )
    const json = await add(fakeIo(), '--json')
    expect(json.json).not.toHaveProperty('warning')
  })
})

describe('the warning fields are untrusted', () => {
  it('prints the sentence without control, escape or format characters', async () => {
    // \e]0;...\a retitles the window, \e[2J clears the screen, \u009b is a one-byte CSI,
    // \u202e reverses the text after it, \u200b is invisible, and a newline could fake a line.
    const nasty = 'Flagged:\u001b]0;pwned\u0007\u001b[2J it may\u009b2J send\u202e your\u200b data\nsomewhere else.\r\nRead it.'
    serve({ ...WARNING, text: nasty })
    const r = await add(fakeIo())
    expect(r.code).toBe(9)
    expect(r.stderr).toContain('\n  Flagged:]0;pwned[2J it may2J send your data somewhere else. Read it.\n')
    expect(r.stderr).not.toMatch(CONTROL)
    expect(r.stderr).not.toMatch(/[\u200b\u202e]/)
  })

  it(`cuts the sentence at ${MAX_WARNING_CHARS} characters`, async () => {
    serve({ ...WARNING, text: `Flagged: ${'x'.repeat(5000)}` })
    const io = fakeIo()
    const r = await add(io, '--json')
    expect(r.json.warning.text).toHaveLength(MAX_WARNING_CHARS)
    expect(r.json.warning.text.endsWith('xxx...')).toBe(true)
    expect(r.stderr).toContain(`\n  ${r.json.warning.text}\n`)
    expect(warningText('a'.repeat(MAX_WARNING_CHARS))).toHaveLength(MAX_WARNING_CHARS)
    // Characters, not UTF-16 units: an emoji is never cut in half.
    const emoji = warningText('\u{1f512}'.repeat(400))
    expect(Array.from(emoji)).toHaveLength(MAX_WARNING_CHARS)
    expect(emoji.endsWith('\u{1f512}...')).toBe(true)
  })

  it.each<[unknown, number | null]>([
    [14, 14],
    [1, 1],
    [null, null],
    [undefined, null],
    [0, null],
    [-3, null],
    [1.5, null],
    ['14', null],
    [1e21, null],
    [Number.NaN, null],
  ])('keeps line %s only as a positive integer (%s), and still shows the warning', (line, kept) => {
    const read = readWarning({ ...WARNING, line })
    expect(read).toEqual({ result: 'warn', flagged: 'data_leaving', line: kept, text: TEXT })
  })

  it('keeps flagged only as a plain id', () => {
    for (const flagged of ['Data leaving', 'data_leaving\u001b[2J', 7, '', 'x'.repeat(41)]) {
      expect(readWarning({ ...WARNING, flagged })).toMatchObject({ flagged: null, text: TEXT })
    }
    expect(readWarning({ ...WARNING, flagged: null })).toMatchObject({ flagged: null })
  })

  it('reads only a missing field or null as no warning, and accepts only warn or fail', () => {
    expect(readWarning(undefined)).toBeUndefined()
    expect(readWarning(null)).toBeUndefined()
    expect(readWarning({ ...WARNING, result: 'fail' })).toMatchObject({ result: 'fail' })
    for (const result of ['pass', 'error', 'block', '', 1, null, true]) expect(readWarning({ ...WARNING, result })).toEqual(UNREADABLE_WARNING)
  })
})
