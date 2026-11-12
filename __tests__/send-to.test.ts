// 0.4.2: `amdahl optimize --list <file.csv> --for <tool>` writes the messages
// Amdahl wrote as a file a sequencer imports, and says how to import it. The
// console's "Send to" writes the same file, so the first test is its own
// end-to-end scenario (amdahl-frontend, e2e-stub/optimizer-send-to.spec.ts)
// run through the CLI: same list, same results, same header names and cells.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { COMMAND_OPTIONS } from '../src/args'
import { CSV_COLUMNS, parseCsv, shellWord } from '../src/commands/batch'
import { AMDAHL_INPUT_COLUMNS, SEND_TO_IDS, SEND_TO_PRESETS, buildSendToFile, guideLines, leftOutLine, planSendTo, sendToFileName, snakeHeader, writtenOf, type Written } from '../src/send-to'
import { cli, fakeIo, type FakeIo } from './helpers/fake-io'
import { startMockServer, type MockOptions, type MockServer } from './helpers/mock-server'

let server: MockServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

async function signedIn(options: MockOptions = {}): Promise<FakeIo> {
  server = await startMockServer(options)
  const io = fakeIo({ AMDAHL_API_URL: server.url })
  expect((await cli(io, 'login', '--json')).code).toBe(0)
  io.stdoutIsTTY = true
  return io
}

const requests = (suffix: string) => server!.log.filter((l) => l.path.endsWith(suffix))
const batchRequests = () => server!.log.filter((l) => l.path === '/api/platform/v1/messages/optimize/batch')

// The console's own scenario: five leads, one with no LinkedIn URL, one with no email, one that fails.
const LIST = [
  'First Name,Last Name,Work Email,Company Name,LinkedIn URL,Notes,message',
  'Sam,Rivera,sam.rivera@example.com,Northwind Traders,https://www.linkedin.com/in/sam-rivera,"Hiring 4 AEs, call notes",Hi Sam',
  'Jo,Okafor,jo.okafor@example.com,Fabrikam,,=1+1,Hi Jo',
  'Lee,Park,lee.park@example.com,Contoso,https://www.linkedin.com/in/lee-park,Skip,Hi Lee',
  'Ana,Cruz,,Initech,https://www.linkedin.com/in/ana-cruz,No email,Hi Ana',
  'Max,Vale,max.vale@example.com,Acme,https://www.linkedin.com/in/max-vale,Failed,Hi Max',
].join('\n')

const MESSAGE = (name: string) => `Subject: A note for ${name}\n\nHi ${name},\n\nA <unverified>claim</unverified> about calls.\n\nOpen to 20 minutes?`

/** What Amdahl wrote for each lead of LIST: Max fails. */
const results: MockOptions['batchResults'] = (item, index) => {
  const name = String(item.message).replace('Hi ', '')
  if (name === 'Max') return { status: 'failed', result: { ok: false, reason: 'optimizer_error', detail: 'It failed.' } }
  return { status: 'done', result: { ok: true, message: MESSAGE(name), summary: 'Written.', run_id: `99999999-9999-4999-8999-${String(index).padStart(12, '0')}`, unchanged: false } }
}

async function withList(options: MockOptions = {}, text = LIST, name = 'q4 leads.csv'): Promise<{ io: FakeIo; list: string }> {
  const io = await signedIn({ batchResults: results, ...options })
  const list = join(io.cwd, name)
  writeFileSync(list, text)
  return { io, list }
}

const sentBody = () => JSON.parse(batchRequests().at(-1)?.body ?? '{}') as { items: Record<string, unknown>[] }

describe('--for writes the console file', () => {
  it('lemlist, email: the console scenario gives the same header names, rows and left-out line', async () => {
    const { io } = await withList()
    const r = await cli(io, 'optimize', '--list', join(io.cwd, 'q4 leads.csv'), '--for', 'lemlist', '--channel', 'email')
    expect(r.code, r.stderr).toBe(1)
    const file = join(io.cwd, 'q4-leads-lemlist.csv')
    expect(readFileSync(file, 'utf8')).toBe(
      [
        'email,firstName,lastName,companyName,linkedinUrl,amdahl_subject,amdahl_message,notes',
        'sam.rivera@example.com,Sam,Rivera,Northwind Traders,https://www.linkedin.com/in/sam-rivera,A note for Sam,"Hi Sam,\n\nA claim about calls.\n\nOpen to 20 minutes?","Hiring 4 AEs, call notes"',
        'jo.okafor@example.com,Jo,Okafor,Fabrikam,,A note for Jo,"Hi Jo,\n\nA claim about calls.\n\nOpen to 20 minutes?",=1+1',
        'lee.park@example.com,Lee,Park,Contoso,https://www.linkedin.com/in/lee-park,A note for Lee,"Hi Lee,\n\nA claim about calls.\n\nOpen to 20 minutes?",Skip',
      ].join('\r\n')
    )
    expect(r.stdout).toBe(`Results: ${join(io.cwd, 'q4 leads.optimized.csv')}\nImport file for lemlist: ${file}\n`)
    expect(r.stderr).toContain('3 messages ready for lemlist. 2 left out: 1 failed, 1 with no email.\n')
    // The batch was sent as email.
    expect(sentBody().items.map((i) => i.channel)).toEqual(['email', 'email', 'email', 'email', 'email'])
  })

  it('HeyReach, LinkedIn: only leads with a profile URL and both names, and no subject column', async () => {
    const { io, list } = await withList()
    const r = await cli(io, 'optimize', '--list', list, '--for', 'heyreach')
    expect(r.code).toBe(1)
    const rows = readFileSync(join(io.cwd, 'q4-leads-heyreach.csv'), 'utf8').split('\r\n')
    expect(rows[0]).toBe('email,first_name,last_name,company,linkedin_url,amdahl_message,notes')
    expect(rows.map((row) => row.split(',')[1])).toEqual(['first_name', 'Sam', 'Lee', 'Ana'])
    expect(r.stderr).toContain('3 messages ready for HeyReach. 2 left out: 1 failed, 1 with no LinkedIn URL or full name.\n')
    // A tool that takes one channel sends its channel: the messages are written for it.
    expect(sentBody().items.map((i) => i.channel)).toEqual(['linkedin', 'linkedin', 'linkedin', 'linkedin', 'linkedin'])
  })

  it('prints the three steps after the file, wrapped to 80 columns, then the next step for a sent message', async () => {
    const { io, list } = await withList()
    const r = await cli(io, 'optimize', '--list', list, '--for', 'lemlist', '--channel', 'email')
    const after = r.stderr.slice(r.stderr.indexOf('3 messages ready'))
    expect(after.split('\n').slice(0, 5)).toEqual([
      '3 messages ready for lemlist. 2 left out: 1 failed, 1 with no email.',
      '  1. Import: In your campaign, open Leads list > Import new leads > CSV.',
      '  2. email and the name columns map on their own. amdahl_subject and',
      '     amdahl_message become custom variables.',
      '  3. Paste into your step: Subject {{amdahl_subject}}, Body {{amdahl_message}}',
    ])
    for (const line of after.split('\n').slice(0, 5)) expect([...line].length, line).toBeLessThanOrEqual(80)
    expect(r.stderr).toContain('Sent one? amdahl sent ')
  })

  it('a tool with a note, and a message over the tool\'s variable limit, say so', async () => {
    const long = 'x'.repeat(2001)
    const { io, list } = await withList({ batchResults: (item, i) => results(item, i) && { status: 'done', result: { ok: true, message: `Subject: S\n\n${long}`, summary: 'Written.', run_id: `99999999-9999-4999-8999-${String(i).padStart(12, '0')}`, unchanged: false } } })
    const lemlist = await cli(io, 'optimize', '--list', list, '--for', 'lemlist', '--channel', 'email')
    expect(lemlist.stderr).toContain("4 messages are over lemlist's 2,000 character limit for a variable.")
    const hubspot = await cli(io, 'optimize', '--list', list, '--for', 'hubspot', '--force')
    expect(hubspot.stderr.replace(/\n/g, ' ')).toContain('HubSpot sequences can drop line breaks from a multi-line property, so check one email before you enroll.')
    expect(hubspot.stderr).not.toContain('character limit')
  })

  it('--json adds send_to with the file and the counts, prints no steps, and still writes the file but not the results file', async () => {
    const { io, list } = await withList()
    const r = await cli(io, 'optimize', '--list', list, '--for', 'lemlist', '--channel', 'email', '--json')
    expect(r.code).toBe(1)
    expect(r.json).toMatchObject({
      ok: false,
      send_to: { tool: 'lemlist', channel: 'email', file: join(io.cwd, 'q4-leads-lemlist.csv'), ready: 3, left_out: { failed: 1, not_written: 0, needs_input: 0, no_contact: 1 }, over_limit: 0 },
    })
    expect(existsSync(join(io.cwd, 'q4-leads-lemlist.csv'))).toBe(true)
    expect(existsSync(join(io.cwd, 'q4 leads.optimized.csv'))).toBe(false)
    expect(r.stderr).not.toContain('Import:')
  })

  it('leaves out what was not written, in the console\'s order of reasons, and a lead that needed input', async () => {
    const { io, list } = await withList({
      batchResults: (item, i) => {
        const name = String(item.message).replace('Hi ', '')
        if (name === 'Jo') return { status: 'done', result: { ok: true, outcome: 'needs_input', ask: [], summary: 'Needs facts.' } }
        if (name === 'Lee') return { status: 'running', result: null }
        return results(item, i)
      },
    })
    const r = await cli(io, 'optimize', '--list', list, '--for', 'instantly')
    expect(r.stderr).toContain('1 message ready for Instantly. 4 left out: 1 failed, 1 not written yet, 1 needed input, 1 with no email.\n')
    expect(readFileSync(join(io.cwd, 'q4-leads-instantly.csv'), 'utf8').split('\r\n')[0]).toBe('email,first_name,last_name,company_name,linkedin_url,amdahl_subject,amdahl_message,notes')
  })

  it('no lead ready: no file, a line that says so, and exit 1', async () => {
    const { io, list } = await withList({ batchFailures: [0, 1, 2, 3, 4], batchResults: undefined })
    const r = await cli(io, 'optimize', '--list', list, '--for', 'instantly')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('Nothing to send to Instantly. 5 left out: 5 failed.\n')
    expect(existsSync(join(io.cwd, 'q4-leads-instantly.csv'))).toBe(false)
    expect(r.stdout).toBe(`Results: ${join(io.cwd, 'q4 leads.optimized.csv')}\n`)
  })

  it('names the file after the list and the tool', () => {
    const reply = SEND_TO_PRESETS.find((p) => p.id === 'reply_io')!
    expect(sendToFileName('/x/Q4 Leads.csv', reply)).toBe('q4-leads-reply-io.csv')
    expect(sendToFileName('/x/café list.CSV', reply)).toBe('cafe-list-reply-io.csv')
    expect(sendToFileName('/x/___.csv', reply)).toBe('leads-reply-io.csv')
    expect(sendToFileName('/x/contacts', reply)).toBe('contacts-reply-io.csv')
    expect(snakeHeader('  Q4 / Région  ')).toBe('q4_region')
  })
})

describe('the import file is for a sequencer, not a spreadsheet', () => {
  const run = (index: number) => `99999999-9999-4999-8999-${String(index).padStart(12, '0')}`

  it('never puts a guard quote on a cell: a body starting "- ", a "-20%" subject and a +1 415 phone arrive as written, and the results file keeps its guard', async () => {
    const text = 'Email,First Name,Phone,Notes,message\nsam@x.com,Sam,+1 415 555 0100,@home,Hi Sam\njo@x.com,Jo,-5,=1+1,Hi Jo\n'
    const { io, list } = await withList(
      {
        batchResults: (item, i) => ({
          status: 'done',
          result: { ok: true, message: i === 0 ? 'Subject: -20% off for Sam\n\n- Hi Sam,\n\n- second line' : '-20% off for Jo', summary: 'Written.', run_id: run(i), unchanged: false },
        }),
      },
      text,
      'p.csv'
    )
    const r = await cli(io, 'optimize', '--list', list, '--for', 'instantly')
    expect(r.code, r.stderr).toBe(0)
    expect(readFileSync(join(io.cwd, 'p-instantly.csv'), 'utf8')).toBe(
      ['email,first_name,last_name,amdahl_subject,amdahl_message,phone,notes', 'sam@x.com,Sam,,-20% off for Sam,"- Hi Sam,\n\n- second line",+1 415 555 0100,@home', 'jo@x.com,Jo,,,-20% off for Jo,-5,=1+1'].join('\r\n')
    )
    // The results file is for a spreadsheet, so it keeps the guard.
    const results = parseCsv(readFileSync(join(io.cwd, 'p.optimized.csv'), 'utf8')).rows
    expect(results[2]?.slice(0, 3)).toEqual(['jo@x.com', 'Jo', "'-5"])
    expect(results[2]?.[5]).toBe("'-20% off for Jo")
  })

  it('leaves out the columns Amdahl reads itself, in any case, and keeps the rest; the request still sends them', async () => {
    const text = 'Item_ID,Email,Channel,Message,Evidence,On_Unsupported,Facts,Rules,Notes\nr1,a@x.com,email,Hi,off,flag,Fact one,Rule one,keep me\n'
    const { io, list } = await withList({}, text, 'own.csv')
    const r = await cli(io, 'optimize', '--list', list, '--for', 'instantly')
    expect(r.code, r.stderr).toBe(0)
    const rows = readFileSync(join(io.cwd, 'own-instantly.csv'), 'utf8').split('\r\n')
    expect(rows[0]).toBe('email,amdahl_subject,amdahl_message,notes')
    expect(rows[1]?.endsWith(',keep me')).toBe(true)
    expect(sentBody().items).toEqual([{ item_id: 'r1', message: 'Hi', channel: 'email', evidence: 'off', on_unsupported: 'flag', context: { facts: ['Fact one'], rules: ['Rule one'] } }])
  })

  it('names exactly the columns the list reader reads', () => {
    expect([...AMDAHL_INPUT_COLUMNS].sort()).toEqual([...CSV_COLUMNS].sort())
  })
})

describe('a channel is read in any case', () => {
  it('LinkedIn in the channel column is linkedin: it picks the file\'s channel and is what the batch is sent with', async () => {
    const { io, list } = await withList({}, 'LinkedIn URL,Channel,message\nhttps://linkedin.com/in/a,LinkedIn,Hi\n', 'ch.csv')
    const r = await cli(io, 'optimize', '--list', list, '--for', 'other')
    expect(r.code, r.stderr).toBe(0)
    expect(sentBody().items).toEqual([{ message: 'Hi', channel: 'linkedin' }])
    expect(readFileSync(join(io.cwd, 'ch-other.csv'), 'utf8').split('\r\n')[0]).toBe('linkedin_url,amdahl_message')
  })

  it('--list alone sends Email as email too, and a list that mixes Email and linkedin is still two channels', async () => {
    const { io, list } = await withList({}, 'Email,channel,message\na@x.com, EMAIL ,Hi\nb@x.com,Email,Yo\n', 'e.csv')
    expect((await cli(io, 'optimize', '--list', list)).code).toBe(0)
    expect(sentBody().items.map((i) => i.channel)).toEqual(['email', 'email'])
    const mixed = join(io.cwd, 'm.csv')
    writeFileSync(mixed, 'Email,LinkedIn URL,channel,message\na@x.com,https://l/in/a,Email,Hi\nb@x.com,https://l/in/b,LinkedIn,Hi\n')
    const before = batchRequests().length
    const r = await cli(io, 'optimize', '--list', mixed, '--for', 'other')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--for writes one channel at a time')
    expect(batchRequests().length).toBe(before)
  })
})

describe('HeyReach\'s step says to set a fallback, and says what is not confirmed', () => {
  it('step 3 names the fallback, and a note says the brace form is not documented', async () => {
    const heyreach = SEND_TO_PRESETS.find((p) => p.id === 'heyreach')!
    expect(guideLines(heyreach, 'linkedin')[2]).toBe('Name the variable amdahl_message, set a fallback value for it, then paste: Message {amdahl_message}')
    expect(heyreach.note).toBe('HeyReach does not document the exact form of a variable in a message, so add it from the Add variable menu in your step if {amdahl_message} does not work.')
    const { io, list } = await withList()
    const r = await cli(io, 'optimize', '--list', list, '--for', 'heyreach')
    const text = r.stderr.replace(/\n\s*/g, ' ')
    expect(text).toContain('Name the variable amdahl_message, set a fallback value for it, then paste: Message {amdahl_message}')
    expect(text).toContain('HeyReach does not document the exact form of a variable in a message')
  })

  it('a lead with no full name is left out as "no LinkedIn URL or full name"', () => {
    const heyreach = SEND_TO_PRESETS.find((p) => p.id === 'heyreach')!
    expect(leftOutLine({ failed: 0, unwritten: 0, needsInput: 0, noContact: 2 }, 'linkedin', heyreach)).toBe('2 left out: 2 with no LinkedIn URL or full name.')
  })
})

describe('a file that appears while the batch runs', () => {
  /** A mock whose batch read plants `target()` once, as another process would while the batch runs. */
  async function planting(target: () => string) {
    return withList({
      batchResults: (item, i) => {
        const path = target()
        if (path && !existsSync(path)) writeFileSync(path, 'appeared\n')
        return results?.(item, i)
      },
    })
  }
  const pickUp = (list: string, id: string, rest = '') => `amdahl optimize --list ${shellWord(list)} --batch ${id}${rest}`

  it('the results file: says it already exists and how to read the batch again, never the system\'s EEXIST', async () => {
    let target = ''
    const { io, list } = await planting(() => target)
    target = join(io.cwd, 'q4 leads.optimized.csv')
    const r = await cli(io, 'optimize', '--list', list)
    const id = /as batch (\S+)\./.exec(r.stderr)?.[1] ?? ''
    expect(r.code).toBe(2)
    expect(r.stderr.endsWith(`Error: ${target} already exists.\nMove it, or add --force to replace it. The batch is done, and you can read it again: ${pickUp(list, id)}\n`)).toBe(true)
    expect(r.stderr).not.toContain('EEXIST')
    expect(readFileSync(target, 'utf8')).toBe('appeared\n')
  })

  it('the import file: the same message, with the tool in the pick-up line; the results file was already written', async () => {
    let target = ''
    const { io, list } = await planting(() => target)
    target = join(io.cwd, 'q4-leads-lemlist.csv')
    const r = await cli(io, 'optimize', '--list', list, '--for', 'lemlist', '--channel', 'email')
    const id = /as batch (\S+)\./.exec(r.stderr)?.[1] ?? ''
    expect(r.code).toBe(2)
    expect(r.stderr.endsWith(`Error: ${target} already exists.\nMove it, or add --force to replace it. The batch is done, and you can read it again: ${pickUp(list, id, ' --for lemlist --channel email')}\n`)).toBe(true)
    expect(r.stderr).not.toContain('EEXIST')
    expect(readFileSync(target, 'utf8')).toBe('appeared\n')
    expect(existsSync(join(io.cwd, 'q4 leads.optimized.csv'))).toBe(true)
  })

  it('--json too, and --force replaces a file that appeared', async () => {
    let target = ''
    const { io, list } = await planting(() => target)
    target = join(io.cwd, 'q4-leads-instantly.csv')
    const json = await cli(io, 'optimize', '--list', list, '--for', 'instantly', '--json')
    expect(json.code).toBe(2)
    expect(json.stdout).toContain(`${target} already exists.`)
    const forced = await cli(io, 'optimize', '--list', list, '--for', 'instantly', '--force')
    expect(forced.code).toBe(1)
    expect(readFileSync(target, 'utf8')).toContain('amdahl_message')
  })
})

describe('--for is checked before anything is sent', () => {
  async function refused(args: string[], expected: { code?: number; error: string; hint?: string }, text = LIST, name = 'q4 leads.csv') {
    const { io, list } = await withList({}, text, name)
    const r = await cli(io, 'optimize', ...args.map((a) => (a === '$LIST' ? list : a)))
    expect(r.code).toBe(expected.code ?? 2)
    expect(r.stderr).toBe(`Error: ${expected.error.replace('$LIST', list)}\n${expected.hint ? `${expected.hint.replace('$LIST', list)}\n` : ''}`)
    expect(batchRequests()).toEqual([])
    expect(requests('/batches/')).toEqual([])
  }

  it('a tool that is not one, and the two that send from a mailbox', async () => {
    await refused(['--list', '$LIST', '--for', 'mailchimp'], { error: `--for must be one of: ${SEND_TO_IDS.join(', ')}.`, hint: 'Use other for a tool that is not listed.' })
    await refused(['--list', '$LIST', '--for', 'gmail'], { error: 'Gmail sends from a mailbox, so it has no import file.', hint: 'Use --for other for any tool that imports a CSV.' })
    await refused(['--list', '$LIST', '--for', 'outlook'], { error: 'Outlook sends from a mailbox, so it has no import file.', hint: 'Use --for other for any tool that imports a CSV.' })
  })

  it('--for needs a value and a list, and a single message takes none', async () => {
    await refused(['--list', '$LIST', '--for', ''], { error: '--for needs a tool.', hint: `One of: ${SEND_TO_IDS.join(', ')}.` })
    await refused(['--list', '$LIST', '--for'], { error: '--for needs a value.', hint: 'Run `amdahl --help`.' })
    await refused(['--for', 'lemlist', '--batch', '77777777-7777-4777-8777-000000000001'], { error: '--for needs the list: add --list <file.csv>.' })
    await refused(['$LIST', '--for', 'lemlist'], { error: '--for goes with --list <file.csv>.' })
  })

  it('a tool that takes both channels needs to know which, and one that takes a channel refuses the other', async () => {
    await refused(['--list', '$LIST', '--for', 'lemlist'], { error: 'lemlist takes email and LinkedIn lists, so --for needs to know which this is.', hint: 'Add --channel email or --channel linkedin.' })
    await refused(['--list', '$LIST', '--for', 'heyreach', '--channel', 'email'], { error: 'HeyReach takes LinkedIn lists only, and this one is email.', hint: 'Pick a tool for this channel, or use --for other.' })
    await refused(['--list', '$LIST', '--for', 'instantly', '--channel', 'linkedin'], { error: 'Instantly takes email lists only, and this one is LinkedIn.', hint: 'Pick a tool for this channel, or use --for other.' })
  })

  it('a list with both channels is refused: the file is for one', async () => {
    const mixed = 'Email,channel,message\na@x.com,email,Hi\nb@x.com,linkedin,Hi\n'
    await refused(['--list', '$LIST', '--for', 'other'], { error: '--for writes one channel at a time, and this list has both email and LinkedIn rows.', hint: 'Split $LIST by channel, and run each part with --for.' }, mixed, 'mixed.csv')
  })

  it('a list without the column the channel needs is refused, naming the spellings it reads', async () => {
    await refused(['--list', '$LIST', '--for', 'instantly'], { error: '$LIST has no email column.', hint: 'Name the column email, email_address or work_email, so the tool can import it.' }, 'name,message\nSam,Hi\n', 'no-email.csv')
    await refused(['--list', '$LIST', '--for', 'lgm'], { error: '$LIST has no LinkedIn URL column.', hint: 'Name the column linkedin_url, linkedin or linkedin_profile, so the tool can import it.' }, 'email,message\na@x.com,Hi\n', 'no-li.csv')
    await refused(['--list', '$LIST', '--for', 'heyreach'], { error: 'HeyReach needs a first and a last name for each lead, and $LIST has no name columns.', hint: 'Add first_name and last_name columns, or one name column.' }, 'linkedin_url,message\nhttps://linkedin.com/in/a,Hi\n', 'no-names.csv')
  })

  it('a JSONL list is refused: the file keeps the list\'s columns', async () => {
    const { io } = await withList()
    const jsonl = join(io.cwd, 'd.jsonl')
    writeFileSync(jsonl, '{"message":"Hi"}\n')
    const r = await cli(io, 'optimize', '--list', jsonl, '--for', 'lemlist', '--channel', 'email')
    expect(r.code).toBe(2)
    expect(r.stderr).toBe(`Error: --for needs a CSV list: the import file keeps your list's columns.\n${jsonl} is not a CSV. Make one, or leave --for out.\n`)
    expect(batchRequests()).toEqual([])
  })

  it('a file that exists is not replaced without --force, and nothing is queued first', async () => {
    const { io, list } = await withList()
    const out = join(io.cwd, 'q4-leads-instantly.csv')
    writeFileSync(out, 'keep me\n')
    const r = await cli(io, 'optimize', '--list', list, '--for', 'instantly')
    expect(r.code).toBe(2)
    expect(r.stderr.endsWith(`Error: ${out} already exists.\nMove it, or add --force to replace it.\n`)).toBe(true)
    expect(readFileSync(out, 'utf8')).toBe('keep me\n')
    expect(batchRequests()).toEqual([])
    expect((await cli(io, 'optimize', '--list', list, '--for', 'instantly', '--force')).code).toBe(1)
    expect(readFileSync(out, 'utf8')).toContain('amdahl_message')
  })
})

describe('--for with --no-wait and --batch', () => {
  it('--no-wait queues, and the pick-up line carries the tool and, for a tool of both channels, the channel', async () => {
    const { io, list } = await withList()
    const queued = await cli(io, 'optimize', '--list', list, '--for', 'reply-io', '--channel', 'linkedin', '--no-wait')
    expect(queued.code).toBe(0)
    const id = /batch (\S+)\./.exec(queued.stdout)?.[1] ?? ''
    expect(queued.stdout).toContain(`Get the results: amdahl optimize --list ${list.includes(' ') ? `'${list}'` : list} --batch ${id} --for reply_io --channel linkedin\n`)
    expect(existsSync(join(io.cwd, 'q4-leads-reply-io.csv'))).toBe(false)
    // The pick-up writes the file.
    const picked = await cli(io, 'optimize', '--list', list, '--batch', id, '--for', 'reply_io', '--channel', 'linkedin')
    expect(picked.code).toBe(1)
    expect(readFileSync(join(io.cwd, 'q4-leads-reply-io.csv'), 'utf8').split('\r\n')[0]).toBe('email,first_name,last_name,company,linkedin_url,amdahl_message,notes')
    // A tool of one channel needs no --channel in the pick-up line.
    const one = await cli(io, 'optimize', '--list', list, '--for', 'instantly', '--no-wait', '--force')
    expect(one.stdout).toMatch(/--batch \S+ --for instantly\n$/)
  })
})

describe('the file builder', () => {
  const lemlist = SEND_TO_PRESETS.find((p) => p.id === 'lemlist')!
  const written = (body: string): Written => ({ kind: 'written', subject: 'S', body })

  it('reads a result as the console does: markers gone, the subject split off, failures and gaps named', () => {
    expect(writtenOf({ status: 'done', result: { ok: true, message: 'Subject: Hi\r\n\r\nBody <unverified>x</unverified>\r\n' } })).toEqual({ kind: 'written', subject: 'Hi', body: 'Body x' })
    expect(writtenOf({ status: 'done', result: { ok: true, message: 'No subject line' } })).toEqual({ kind: 'written', subject: '', body: 'No subject line' })
    expect(writtenOf({ status: 'failed', result: null })).toEqual({ kind: 'failed' })
    expect(writtenOf({ status: 'done', result: { ok: false } })).toEqual({ kind: 'failed' })
    expect(writtenOf({ status: 'queued', result: null })).toEqual({ kind: 'unwritten' })
    expect(writtenOf(undefined)).toEqual({ kind: 'unwritten' })
    expect(writtenOf({ status: 'done', result: { ok: true, outcome: 'needs_input', ask: [] } })).toEqual({ kind: 'needs_input' })
    expect(writtenOf({ status: 'done', result: { ok: true } })).toEqual({ kind: 'unwritten' })
  })

  it('carries identity columns under the tool\'s names, then Amdahl\'s, then the rest in order, with a clash renamed', () => {
    const file = buildSendToFile({
      path: 'x.csv',
      headers: ['﻿Notes', 'Work Email', 'Full Name', 'Account', 'LinkedIn', 'amdahl_message', 'Notes', ''],
      rows: [{ cells: ['n1', 'a@x.com', 'Sam Rivera', 'Acme', 'https://li/in/a', 'mine', 'n2', 'blank'], written: written('Hi') }],
      channel: 'email',
      preset: lemlist,
    })
    expect(file.csv).toBe(
      ['email,firstName,lastName,companyName,linkedinUrl,amdahl_subject,amdahl_message,notes,full_name,amdahl_message_2,notes_2,column_8', 'a@x.com,Sam,Rivera,Acme,https://li/in/a,S,Hi,n1,Sam Rivera,mine,n2,blank'].join('\r\n')
    )
  })

  it('leaves out a lead with no contact for the channel, and counts a body over the tool\'s limit', () => {
    const file = buildSendToFile({
      path: 'x.csv',
      headers: ['email', 'name'],
      rows: [
        { cells: ['', 'No Email'], written: written('a') },
        { cells: ['a@x.com', 'Has Email'], written: written('x'.repeat(2001)) },
      ],
      channel: 'email',
      preset: lemlist,
    })
    expect(file.ready).toBe(1)
    expect(file.leftOut).toEqual({ failed: 0, unwritten: 0, needsInput: 0, noContact: 1 })
    expect(file.overLimit).toBe(1)
    expect(leftOutLine(file.leftOut, 'email', lemlist)).toBe('1 left out: 1 with no email.')
    expect(leftOutLine({ failed: 0, unwritten: 0, needsInput: 0, noContact: 0 }, 'email', lemlist)).toBeNull()
  })

  it('every tool and channel has a three-step guide of plain ASCII', () => {
    for (const preset of SEND_TO_PRESETS) {
      for (const channel of preset.channels) {
        const guide = guideLines(preset, channel)
        expect(guide).toHaveLength(3)
        for (const line of [...guide, preset.where, preset.note ?? '']) expect(line).toMatch(/^[\x20-\x7e]*$/)
        expect(guide[2]).toContain(preset.variable('amdahl_message'))
        expect(guide[2]?.includes(preset.variable('amdahl_subject'))).toBe(channel === 'email')
      }
    }
  })

  it('has the console\'s tool ids, and the CLI takes --for', () => {
    expect([...SEND_TO_IDS]).toEqual(['instantly', 'smartlead', 'lemlist', 'heyreach', 'reply_io', 'apollo', 'outreach', 'salesloft', 'hubspot', 'lgm', 'woodpecker', 'other'])
    expect(Object.keys(COMMAND_OPTIONS.optimize ?? {})).toContain('for')
    expect(planSendTo(SEND_TO_PRESETS[0]!, { path: 'x.csv', kind: 'csv', header: ['email', 'message'], items: [{ message: 'a' }] }, undefined)).toEqual({ preset: SEND_TO_PRESETS[0], channel: 'email' })
  })

  it('pins each tool\'s header names and variable syntax to the console\'s', () => {
    const syntax = SEND_TO_PRESETS.map((p) => [p.id, p.headers ?? {}, p.variable('amdahl_subject'), p.variable('amdahl_message'), [...p.channels], p.needsNames ?? false, p.maxValue ?? 0])
    expect(syntax).toEqual([
      ['instantly', { company: 'company_name' }, '{{amdahl_subject}}', '{{amdahl_message}}', ['email'], false, 0],
      ['smartlead', { company: 'company_name' }, '{{amdahl_subject}}', '{{amdahl_message}}', ['email'], false, 0],
      ['lemlist', { first_name: 'firstName', last_name: 'lastName', company: 'companyName', linkedin_url: 'linkedinUrl' }, '{{amdahl_subject}}', '{{amdahl_message}}', ['email', 'linkedin'], false, 2000],
      ['heyreach', {}, '{amdahl_subject}', '{amdahl_message}', ['linkedin'], true, 0],
      ['reply_io', {}, '{{amdahl_subject}}', '{{amdahl_message}}', ['email', 'linkedin'], false, 0],
      ['apollo', {}, 'amdahl_subject', 'amdahl_message', ['email'], false, 0],
      ['outreach', {}, '{{custom1}}', '{{custom2}}', ['email'], false, 0],
      ['salesloft', {}, 'amdahl_subject', 'amdahl_message', ['email'], false, 0],
      ['hubspot', {}, 'amdahl_subject', 'amdahl_message', ['email'], false, 0],
      ['lgm', {}, 'amdahl_subject', 'amdahl_message', ['linkedin'], false, 0],
      ['woodpecker', {}, 'Snippet 1', 'Snippet 2', ['email'], false, 0],
      ['other', {}, '{{amdahl_subject}}', '{{amdahl_message}}', ['email', 'linkedin'], false, 0],
    ])
  })
})
