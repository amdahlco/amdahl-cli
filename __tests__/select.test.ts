// The arrow-key menus (src/select.ts), driven through readline's own keypress
// decoding over a fake terminal: the keys a person presses, and that raw
// mode, the keypress listener and the cursor are put back on every way out.

import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { PromptCancelled } from '../src/io'
import { listenForEnter, multiSelectMenu, readPaste, screenLines, selectMenu, type TickMenuOptions } from '../src/select'

const UP = '\u001b[A'
const DOWN = '\u001b[B'
const CHOICES = ['This project (~/proj)', 'Every project on this computer']

/** A terminal: input that records raw mode, output that keeps what was drawn. */
function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    rawCalls: [] as boolean[],
    setRawMode(mode: boolean) {
      this.isRaw = mode
      this.rawCalls.push(mode)
      return this
    },
  })
  let drawn = ''
  const output = new Writable({
    write(chunk, _enc, done) {
      drawn += String(chunk)
      done()
    },
  })
  return { input, output, drawn: () => drawn }
}

/** Open the menu, press `keys` one at a time, and settle. */
async function press(keys: string[], initial = 0, color = false) {
  const t = terminal()
  const result = selectMenu(t.input, t.output, 'Install it in:', CHOICES, { initial, color }).then(
    (pick) => ({ pick }),
    (error: unknown) => ({ error })
  )
  for (const key of keys) {
    t.input.write(key)
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { ...(await result), ...t }
}

/** What a person sees: the drawing with every escape code removed. */
const plain = (text: string) => text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '')

/**
 * The screen a terminal `columns` wide shows after `drawn`, with no bottom
 * edge: text wraps at the right edge (a line exactly as wide waits to wrap
 * until the next character, as xterm does), and the cursor moves the way the
 * menu's escape codes say (up, clear line, clear down, carriage return).
 */
function screen(drawn: string, columns: number): string[] {
  const rows: string[][] = [[]]
  let row = 0
  let col = 0
  let pending = false
  const line = () => (rows[row] ??= [])
  for (let i = 0; i < drawn.length; i++) {
    const c = drawn[i]!
    if (c === '\u001b') {
      const csi = /^\u001b\[([0-9;?]*)([A-Za-z])/.exec(drawn.slice(i))
      if (!csi) throw new Error(`unknown escape at ${i}`)
      i += csi[0].length - 1
      const n = Number(csi[1] || '1')
      if (csi[2] === 'A') row = Math.max(0, row - n)
      else if (csi[2] === 'K') rows[row] = []
      else if (csi[2] === 'J') {
        rows[row] = line().slice(0, col)
        rows.length = row + 1
      }
      pending = false
    } else if (c === '\r') {
      col = 0
      pending = false
    } else if (c === '\n') {
      row++
      col = 0
      pending = false
      line()
    } else {
      if (pending) {
        row++
        col = 0
        pending = false
      }
      line()[col] = c
      if (col === columns - 1) pending = true
      else col++
    }
  }
  // A full row is kept whole (it wraps into the next one); a shorter row loses the blanks after it.
  const text = rows.map((r) => Array.from(r, (ch) => ch ?? ' ').join('')).map((r) => (r.length >= columns ? r : r.trimEnd()))
  return text.filter((r, i) => r !== '' || i < text.length - 1)
}

describe('selectMenu', () => {
  it.each<[string, string[], number]>([
    ['Enter: the start row', ['\r'], 0],
    ['Down, Enter', [DOWN, '\r'], 1],
    ['j, Enter', ['j', '\r'], 1],
    ['Down, Up, Enter', [DOWN, UP, '\r'], 0],
    ['Down, k, Enter', [DOWN, 'k', '\r'], 0],
    ['Down twice wraps to the top', [DOWN, DOWN, '\r'], 0],
    ['Up from the top wraps to the bottom', [UP, '\r'], 1],
    ['2, Enter', ['2', '\r'], 1],
    ['2, 1, Enter', ['2', '1', '\r'], 0],
    ['a row number that does not exist is ignored', ['9', '\r'], 0],
    ['other keys are ignored', ['x', ' ', '\r'], 0],
  ])('%s', async (_label, keys, want) => {
    const r = await press(keys)
    expect(r).toMatchObject({ pick: want })
    expect(r.input.rawCalls).toEqual([true, false])
    expect(r.input.isRaw).toBe(false)
    expect(r.input.listenerCount('keypress')).toBe(0)
  })

  it('starts on the row it is given', async () => {
    expect(await press(['\r'], 1)).toMatchObject({ pick: 1 })
  })

  it('draws the rows with a marker, then collapses to one line and shows the cursor', async () => {
    const r = await press([DOWN, '\r'])
    const drawn = r.drawn()
    expect(drawn.startsWith('\u001b[?25l')).toBe(true)
    expect(drawn.endsWith('Install it in: Every project on this computer\n\u001b[?25h')).toBe(true)
    // First frame: the marker on the first row; bold, since colour is off.
    expect(drawn).toContain('\u001b[1m> This project (~/proj)\u001b[0m\n')
    expect(drawn).toContain('  Every project on this computer\n')
    expect(drawn).toContain('(Use the arrow keys, then Enter)\n')
    // After Down: the marker moved to the second row.
    expect(drawn).toContain('\u001b[1m> Every project on this computer\u001b[0m\n')
    expect(plain(drawn)).toContain('Install it in:\n> This project (~/proj)\n  Every project on this computer\n(Use the arrow keys, then Enter)\n')
  })

  it('marks the row in the brand colour when colour is on', async () => {
    const r = await press(['\r'], 0, true)
    expect(r.drawn()).toContain('\u001b[1;38;5;202m> This project (~/proj)\u001b[0m')
    const t = terminal()
    const done = selectMenu(t.input, t.output, 'Install it in:', CHOICES, { color: true, trueColor: true })
    t.input.write('\r')
    await done
    expect(t.drawn()).toContain('\u001b[1;38;2;253;75;3m> This project (~/proj)\u001b[0m')
  })

  it.each<[string, string]>([
    ['Ctrl+C', '\u0003'],
    ['Ctrl+D', '\u0004'],
    ['Esc', '\u001b'],
    ['q', 'q'],
  ])('%s rejects with PromptCancelled and restores the terminal', async (_label, key) => {
    const r = await press([DOWN, key])
    expect((r as { error?: unknown }).error).toBeInstanceOf(PromptCancelled)
    expect(r.input.rawCalls).toEqual([true, false])
    expect(r.input.listenerCount('keypress')).toBe(0)
    expect(r.drawn().endsWith('\u001b[?25h')).toBe(true)
  })

  it('a SIGINT sent to the process cancels and restores the terminal', async () => {
    const t = terminal()
    const before = process.listenerCount('SIGINT')
    const result = selectMenu(t.input, t.output, 'Install it in:', CHOICES).catch((e: unknown) => e)
    expect(process.listenerCount('SIGINT')).toBe(before + 1)
    process.emit('SIGINT')
    expect(await result).toBeInstanceOf(PromptCancelled)
    expect(t.input.rawCalls).toEqual([true, false])
    expect(process.listenerCount('SIGINT')).toBe(before)
    expect(t.drawn().endsWith('\u001b[?25h')).toBe(true)
  })

  it('an input error rejects with it and restores the terminal', async () => {
    const t = terminal()
    const result = selectMenu(t.input, t.output, 'Install it in:', CHOICES).catch((e: unknown) => e)
    t.input.emit('error', new Error('terminal closed'))
    expect(((await result) as Error).message).toBe('terminal closed')
    expect(t.input.rawCalls).toEqual([true, false])
    expect(t.input.listenerCount('keypress')).toBe(0)
  })

  it('puts back raw mode as it found it', async () => {
    const t = terminal()
    t.input.isRaw = true
    const done = selectMenu(t.input, t.output, 'Install it in:', CHOICES)
    t.input.write('\r')
    await done
    expect(t.input.rawCalls).toEqual([true, true])
  })
})

describe('multiSelectMenu', () => {
  const CLIENTS = ['Claude Code', 'Cursor', 'Codex']

  async function tick(keys: string[], ticked?: boolean[], options: TickMenuOptions = {}) {
    const t = terminal()
    const result = multiSelectMenu(t.input, t.output, 'Set up Amdahl in:', CLIENTS, { ticked, ...options }).then(
      (picks) => ({ picks }),
      (error: unknown) => ({ error })
    )
    for (const key of keys) {
      t.input.write(key)
      await new Promise((resolve) => setImmediate(resolve))
    }
    return { ...(await result), ...t }
  }

  it.each<[string, string[], boolean[] | undefined, number[]]>([
    ['Enter keeps the start ticks', ['\r'], [true, false, true], [0, 2]],
    ['Enter with nothing ticked picks none', ['\r'], undefined, []],
    ['Space ticks the marked row', [' ', '\r'], undefined, [0]],
    ['Space unticks it', [' ', '\r'], [true, true, false], [1]],
    ['Down, Space ticks the second row', [DOWN, ' ', '\r'], undefined, [1]],
    ['Up wraps to the last row', [UP, ' ', '\r'], undefined, [2]],
    ['j and k move too', ['j', 'j', 'k', ' ', '\r'], undefined, [1]],
    ['a digit ticks that row', ['3', '1', '\r'], undefined, [0, 2]],
    ['a digit twice unticks it', ['2', '2', '\r'], undefined, []],
    ['other keys are ignored', ['x', '9', '\r'], [false, true, false], [1]],
  ])('%s', async (_label, keys, ticked, want) => {
    const r = await tick(keys, ticked)
    expect(r).toMatchObject({ picks: want })
    expect(r.input.rawCalls).toEqual([true, false])
    expect(r.input.listenerCount('keypress')).toBe(0)
  })

  it('draws a box per row, then collapses to the ticked names', async () => {
    const r = await tick([DOWN, ' ', '\r'], [true, false, false])
    expect(plain(r.drawn())).toContain('Set up Amdahl in:\n> [x] Claude Code\n  [ ] Cursor\n  [ ] Codex\n↑↓ move · Space tick/untick · Enter to accept\n')
    expect(plain(r.drawn())).toContain('> [x] Cursor\n')
    expect(r.drawn().endsWith('Set up Amdahl in: Claude Code, Cursor\n\u001b[?25h')).toBe(true)
    expect(screen(r.drawn(), 80)).toEqual(['Set up Amdahl in: Claude Code, Cursor'])
    const none = await tick(['\r'])
    expect(none.drawn().endsWith('Set up Amdahl in: none\n\u001b[?25h')).toBe(true)
  })

  it('starts the marker on the first ticked row', async () => {
    const r = await tick([' ', '\r'], [false, true, false])
    expect(plain(r.drawn())).toContain('Set up Amdahl in:\n  [ ] Claude Code\n> [x] Cursor\n')
    // Space on the marked row unticks Cursor.
    expect(r).toMatchObject({ picks: [] })
  })

  it('colours only the marker, so an unticked row under it does not look picked; tags are dim grey', async () => {
    const r = await tick(['\r'], [false, true, false], { color: true, tags: [undefined, 'found on your machine', undefined] })
    const drawn = r.drawn()
    expect(drawn).toContain('\u001b[1;38;5;202m>\u001b[0m [x] Cursor        \u001b[90mfound on your machine\u001b[39m\n')
    expect(drawn).toContain('  [ ] Claude Code\n')
    // No colour (NO_COLOR, --no-color): the marker is bold, the tag plain words.
    const plainRun = await tick(['\r'], [false, true, false], { tags: [undefined, 'found on your machine', undefined] })
    expect(plainRun.drawn()).toContain('\u001b[1m>\u001b[0m [x] Cursor        found on your machine\n')
    expect(plainRun.drawn()).not.toMatch(/\u001b\[(?:9\d|3\d|38)[;m]/)
  })

  it('shows a note under the question and the hint it is given', async () => {
    const r = await tick(['\r'], undefined, { note: "We didn't find any of these on this computer. Tick the ones you use.", hint: '↑↓ move · Space tick/untick · Enter to install' })
    expect(plain(r.drawn())).toContain(
      "Set up Amdahl in:\nWe didn't find any of these on this computer. Tick the ones you use.\n> [ ] Claude Code\n  [ ] Cursor\n  [ ] Codex\n↑↓ move · Space tick/untick · Enter to install\n"
    )
    expect(screen(r.drawn(), 80)).toEqual(['Set up Amdahl in: none'])
  })

  it.each([20, 30, 40, 56, 57, 80])('redraws in place at %i columns: one menu on screen after every key, and one line after Enter', async (columns) => {
    const note = "We didn't find any of these on this computer. Tick the ones you use."
    const t = terminal()
    const done = multiSelectMenu(t.input, t.output, 'Where should Amdahl work?', CLIENTS, {
      note,
      tags: ['found on your machine', undefined, undefined],
      columns: () => columns,
    })
    const keys = [DOWN, ' ', DOWN, ' ', UP, UP, ' ', 'j', ' ']
    for (const key of keys) {
      t.input.write(key)
      await new Promise((resolve) => setImmediate(resolve))
      // Rows that wrap join up again: exactly one copy of each row and of the question.
      const shown = screen(t.drawn(), columns).join('')
      for (const text of ['Where should Amdahl work?', '] Claude Code', '] Cursor', '] Codex']) {
        expect(shown.split(text).length - 1, `${text} at ${columns} columns`).toBe(1)
      }
    }
    expect(screen(t.drawn(), columns).join('')).toContain('> [ ] Cursor')
    t.input.write('\r')
    expect(await done).toEqual([0, 2])
    expect(screen(t.drawn(), columns).join('')).toBe('Where should Amdahl work? Claude Code, Codex')
  })

  it('in a narrow window, the tag moves closer, then goes, and the hint wraps at its separators', async () => {
    const draw = async (columns: number) => {
      const t = terminal()
      const done = multiSelectMenu(t.input, t.output, 'Where?', CLIENTS, {
        tags: ['found on your machine', undefined, undefined],
        hint: '↑↓ move · Space tick/untick · Enter to install',
        columns: () => columns,
      })
      t.input.write('\u0003')
      await done.catch(() => {})
      return plain(t.drawn())
    }
    expect(await draw(80)).toContain('> [ ] Claude Code   found on your machine\n  [ ] Cursor\n')
    expect(await draw(40)).toContain('> [ ] Claude Code found on your machine\n')
    expect(await draw(40)).toContain('↑↓ move · Space tick/untick\nEnter to install\n')
    expect(await draw(30)).toContain('> [ ] Claude Code\n')
    expect(await draw(30)).toContain('↑↓ move · Space tick/untick\nEnter to install\n')
    expect(await draw(20)).toContain('↑↓ move\nSpace tick/untick\nEnter to install\n')
  })

  it('in a narrow window, the note wraps between words', async () => {
    const t = terminal()
    const done = multiSelectMenu(t.input, t.output, 'Where?', CLIENTS, { note: "We didn't find any of these on this computer. Tick the ones you use.", columns: () => 30 })
    t.input.write('\r')
    await done
    expect(plain(t.drawn())).toContain("Where?\nWe didn't find any of these on\nthis computer. Tick the ones\nyou use.\n> [ ] Claude Code\n")
    expect(screen(t.drawn(), 30)).toEqual(['Where? none'])
  })

  it('the setup\'s menu with nothing found: a two-line note, four rows, the marker on the last, and Space then Enter picks it', async () => {
    const note = "We didn't find Claude Code, Cursor or Codex on this computer.\nUsing the Claude or ChatGPT app? Connect it at https://amdahl.ai/connect"
    for (const columns of [80, 40]) {
      const t = terminal()
      const done = multiSelectMenu(t.input, t.output, 'Where should Amdahl work?', [...CLIENTS, 'This terminal'], {
        note,
        initial: 3,
        hint: '↑↓ move · Space tick/untick · Enter continue',
        columns: () => columns,
      })
      if (columns === 80) {
        expect(plain(t.drawn())).toContain(
          "Where should Amdahl work?\nWe didn't find Claude Code, Cursor or Codex on this computer.\nUsing the Claude or ChatGPT app? Connect it at https://amdahl.ai/connect\n  [ ] Claude Code\n  [ ] Cursor\n  [ ] Codex\n> [ ] This terminal\n↑↓ move · Space tick/untick · Enter continue\n"
        )
      }
      t.input.write(' ')
      await new Promise((resolve) => setImmediate(resolve))
      t.input.write('\r')
      expect(await done).toEqual([3])
      // The note's two lines (wrapped or not) are erased with the rest.
      expect(screen(t.drawn(), columns)).toEqual(['Where should Amdahl work? This terminal'])
    }
  })

  it('a ticked row wins over `initial` for where the marker starts', async () => {
    const t = terminal()
    const done = multiSelectMenu(t.input, t.output, 'Where?', [...CLIENTS, 'This terminal'], { ticked: [false, true, false, false], initial: 3 })
    t.input.write(' ')
    await new Promise((resolve) => setImmediate(resolve))
    t.input.write('\r')
    expect(await done).toEqual([])
  })

  it('counts the screen lines a row takes', () => {
    expect(screenLines('abc', 80)).toBe(1)
    expect(screenLines('x'.repeat(40), 40)).toBe(1)
    expect(screenLines('x'.repeat(41), 40)).toBe(2)
    expect(screenLines('↑↓ move · Space tick/untick · Enter to install', 20)).toBe(3)
    expect(screenLines('\u001b[1;38;5;202m>\u001b[0m [ ] Codex', 11)).toBe(1)
    expect(screenLines('', 40)).toBe(1)
    expect(screenLines('x'.repeat(200), undefined)).toBe(1)
  })

  it.each<[string, string]>([
    ['Ctrl+C', '\u0003'],
    ['Esc', '\u001b'],
    ['q', 'q'],
  ])('%s rejects with PromptCancelled, leaves only the question, and restores the terminal', async (_label, key) => {
    const r = await tick([' ', key])
    expect((r as { error?: unknown }).error).toBeInstanceOf(PromptCancelled)
    expect(r.input.rawCalls).toEqual([true, false])
    expect(r.drawn().endsWith('\u001b[?25h')).toBe(true)
    expect(screen(r.drawn(), 80)).toEqual(['Set up Amdahl in:'])
  })
})

describe('listenForEnter', () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve))

  /** Listen on a fake terminal and count what happened. */
  function listen() {
    const t = terminal()
    const seen = { enter: 0, cancel: 0 }
    const stop = listenForEnter(
      t.input,
      () => seen.enter++,
      () => seen.cancel++
    )
    return { ...t, seen, stop }
  }

  it('calls back at each Enter, ignores every other key, draws nothing, and restores the terminal when stopped', async () => {
    const t = listen()
    expect(t.input.isRaw).toBe(true)
    for (const key of ['a', ' ', UP, '\r', 'q', '\n', '\u0004']) {
      t.input.write(key)
      await tick()
    }
    expect(t.seen).toEqual({ enter: 2, cancel: 0 })
    expect(t.drawn()).toBe('')
    t.stop()
    t.stop()
    expect(t.input.rawCalls).toEqual([true, false])
    expect(t.input.listenerCount('keypress')).toBe(0)
    t.input.write('\r')
    await tick()
    expect(t.seen.enter).toBe(2)
  })

  it('Ctrl+C restores the terminal and cancels, once', async () => {
    const before = process.listenerCount('SIGINT')
    const t = listen()
    expect(process.listenerCount('SIGINT')).toBe(before + 1)
    t.input.write('\u0003')
    await tick()
    t.stop()
    expect(t.seen).toEqual({ enter: 0, cancel: 1 })
    expect(t.input.rawCalls).toEqual([true, false])
    expect(t.input.listenerCount('keypress')).toBe(0)
    expect(process.listenerCount('SIGINT')).toBe(before)
  })

  it('a SIGINT sent to the process restores the terminal and cancels', () => {
    const before = process.listenerCount('SIGINT')
    const t = listen()
    process.emit('SIGINT')
    expect(t.seen).toEqual({ enter: 0, cancel: 1 })
    expect(t.input.rawCalls).toEqual([true, false])
    expect(process.listenerCount('SIGINT')).toBe(before)
  })

  it('puts back raw mode as it found it', () => {
    const t = terminal()
    t.input.isRaw = true
    listenForEnter(t.input, () => {}, () => {})()
    expect(t.input.rawCalls).toEqual([true, true])
  })
})

describe('readPaste', () => {
  /** Start reading, write each chunk as the terminal would deliver it, and settle. */
  async function paste(chunks: string[], gapMs = 0) {
    const t = terminal()
    const result = readPaste(t.input, t.output, 'Paste it:').then(
      (text) => ({ text }),
      (error: unknown) => ({ error })
    )
    for (const chunk of chunks) {
      t.input.write(chunk)
      await new Promise((resolve) => setTimeout(resolve, gapMs))
    }
    return { ...(await result), ...t }
  }

  it('reads typed lines up to an empty line, with bracketed paste on while it reads and off after', async () => {
    const r = await paste(['Hi Sam,\r', 'Quick one.\r', '\r'], 20)
    expect(r).toMatchObject({ text: 'Hi Sam,\nQuick one.' })
    expect(r.drawn().startsWith('Paste it:\n\u001b[?2004h')).toBe(true)
    // No readline prompt: its default "> " would show on lines it redraws.
    expect(r.drawn()).not.toContain('> ')
    expect(r.drawn().endsWith('\u001b[?2004l')).toBe(true)
    expect(r.input.isRaw).toBe(false)
  })

  it('keeps the empty lines inside a bracketed paste, and ends at the empty line typed after it', async () => {
    const r = await paste(['\u001b[200~Hi Sam,\r\rSaw your post.\r\rBest,\rDom\r\u001b[201~', '\r'], 200)
    expect(r).toMatchObject({ text: 'Hi Sam,\n\nSaw your post.\n\nBest,\nDom' })
  })

  it('keeps a long pasted line whole: no line limit as in a cooked terminal', async () => {
    const long = 'x'.repeat(3000)
    const r = await paste([`\u001b[200~${long}\r\u001b[201~`, '\r'], 200)
    expect(r).toMatchObject({ text: long })
  })

  it('without bracketed paste, an empty line followed at once by more text is part of the paste', async () => {
    const r = await paste(['Hi Sam,\r\rSaw your post.\r', '\r'], 300)
    expect(r).toMatchObject({ text: 'Hi Sam,\n\nSaw your post.' })
  })

  it('skips empty lines before anything is pasted', async () => {
    const r = await paste(['\r', '\r', 'draft\r', '\r'], 200)
    expect(r).toMatchObject({ text: 'draft' })
  })

  it('with emptyEnds, Enter before any text ends it with an empty answer; text typed first still reads to the empty line', async () => {
    const skip = terminal()
    const skipped = readPaste(skip.input, skip.output, 'Changed it?', { emptyEnds: true })
    skip.input.write('\r')
    expect(await Promise.race([skipped, new Promise((r) => setTimeout(() => r('hung'), 1000))])).toBe('')
    expect(skip.input.isRaw).toBe(false)
    expect(skip.drawn().endsWith('\u001b[?2004l')).toBe(true)

    const t = terminal()
    const typed = readPaste(t.input, t.output, 'Changed it?', { emptyEnds: true })
    t.input.write('my words\r')
    await new Promise((r) => setTimeout(r, 20))
    t.input.write('\r')
    expect(await typed).toBe('my words')
  })

  it('without emptyEnds, a message prompt still waits through a stray Enter (Ctrl+D or Ctrl+C leaves)', async () => {
    const r = await paste(['\r', 'draft\r', '\r'], 200)
    expect(r).toMatchObject({ text: 'draft' })
  })

  it('Ctrl+D ends it with what was typed', async () => {
    const r = await paste(['draft\r', '\u0004'], 20)
    expect(r).toMatchObject({ text: 'draft' })
  })

  it('Ctrl+C rejects with PromptCancelled and puts the terminal back', async () => {
    const r = await paste(['half a dr', '\u0003'], 20)
    expect((r as { error?: unknown }).error).toBeInstanceOf(PromptCancelled)
    expect(r.drawn().endsWith('\u001b[?2004l')).toBe(true)
    expect(r.input.isRaw).toBe(false)
    expect(r.input.listenerCount('keypress')).toBe(0)
  })
})
