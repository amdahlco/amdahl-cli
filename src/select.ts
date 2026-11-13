// src/select.ts
//
// Arrow-key menus for a terminal, on node:readline alone (no dependency): one
// that picks a row, and one that ticks any number of rows (Space ticks).
// Up and Down (also k and j) move the marker, a digit jumps to that row,
// Enter picks. Ctrl+C, Ctrl+D, Esc or q rejects with PromptCancelled. Raw
// mode, the keypress listener and the cursor are restored on every way out:
// a pick, a cancel, an input error, and a SIGINT sent to the process. After a
// pick the menu collapses into one line, "<question> <choice>", so the
// scrollback stays short; a cancel leaves only the question. A row wider
// than the terminal takes more than one screen line, and every redraw counts
// those lines, so a narrow window does not pile up copies of the menu. Also a
// quiet wait for Enter, for the sign-in link, and the read of a pasted message.

import { createInterface, emitKeypressEvents } from 'node:readline'
import { PromptCancelled } from './io'

/** The input side: a terminal that can switch raw mode. */
export interface MenuInput extends NodeJS.ReadableStream {
  isRaw?: boolean
  setRawMode?: (mode: boolean) => unknown
}

/** How the menu looks. */
export interface MenuOptions {
  /** The row the marker starts on. */
  initial?: number
  /** Mark the row in the brand colour; without it, bold. */
  color?: boolean
  /** Use 24-bit colour (COLORTERM=truecolor); otherwise the nearest of 256. */
  trueColor?: boolean
  /** The terminal's width in columns, read at each draw; unknown counts every row as one line. */
  columns?: () => number | undefined
}

/** How the tick menu looks, beyond {@link MenuOptions}. */
export interface TickMenuOptions extends MenuOptions {
  /** Which rows start ticked. The marker starts on the first of them, or on `initial` when none is. */
  ticked?: boolean[]
  /** Words after a row's name, dim grey when colour is allowed (for example "found on your machine"). */
  tags?: (string | undefined)[]
  /** Lines between the question and the rows, split at newlines. */
  note?: string
  /** The line under the rows. */
  hint?: string
}

/** A key as readline's keypress event reports it. */
interface Key {
  name?: string
  ctrl?: boolean
  sequence?: string
}

const HINT = '(Use the arrow keys, then Enter)'
const MULTI_HINT = '↑↓ move · Space tick/untick · Enter to accept'
const OFF = '\u001b[0m'
const GREY = '\u001b[90m'
const GREY_OFF = '\u001b[39m'
const HIDE_CURSOR = '\u001b[?25l'
const SHOW_CURSOR = '\u001b[?25h'
const CLEAR_LINE = '\u001b[2K'
const CLEAR_DOWN = '\u001b[0J'
// ESC[0A moves up one line in most terminals, so moving up by none writes nothing.
const up = (n: number) => (n > 0 ? `\u001b[${n}A` : '')
// Escape sequences: CSI (colour, cursor) and OSC (a hyperlink), which take no room on screen.
// eslint-disable-next-line no-control-regex
const ESCAPES = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

/** Escape codes that move the cursor up over `lines` screen lines and clear them and everything below. */
export function eraseUp(lines: number): string {
  return `\r${up(lines)}${CLEAR_DOWN}`
}

/**
 * How many screen lines `text` (one line, no newline) takes in a terminal
 * `columns` wide: a line exactly as wide as the terminal still takes one.
 */
export function screenLines(text: string, columns: number | undefined): number {
  const width = [...text.replace(ESCAPES, '')].length
  if (!columns || columns < 1) return 1
  return Math.max(1, Math.ceil(width / columns))
}

/** What a key did: settled the menu, changed the drawing, or nothing. */
type KeyResult<T> = { pick: T; summary: string } | 'redraw' | null

/**
 * The menu's life cycle, shared by both menus: draw the question (and the
 * note, when there is one), then `rows()` and the hint; hand each key to
 * `onKey`, redraw when it says so, and on a pick collapse into "<question>
 * <summary>". Rejects with PromptCancelled on Ctrl+C, Ctrl+D, Esc, q or
 * SIGINT, and with the error on an input error; raw mode and the cursor are
 * restored first.
 */
function runMenu<T>(
  input: MenuInput,
  output: NodeJS.WritableStream,
  head: { question: string; note?: string; hint: string; columns?: () => number | undefined },
  rows: () => string[],
  onKey: (text: string | undefined, name: string | undefined) => KeyResult<T>
): Promise<T> {
  const { question, note, hint } = head
  const width = () => head.columns?.()
  // Screen lines above the rows (the question and the note), and of the rows and hint as last drawn.
  let headLines = 0
  let drawn = 0
  const frame = () => {
    const cols = width()
    const lines = [...rows(), ...fitHint(hint, cols)]
    drawn = lines.reduce((n, line) => n + screenLines(line, cols), 0)
    return lines.map((line) => `${CLEAR_LINE}\r${line}\n`).join('')
  }
  const wasRaw = input.isRaw === true

  return new Promise<T>((resolve, reject) => {
    let done = false
    const finish = (outcome: { pick: T; summary: string } | { error: Error }) => {
      if (done) return
      done = true
      input.removeListener('keypress', onKeypress)
      input.removeListener('error', onError)
      process.removeListener('SIGINT', onSigint)
      try {
        input.setRawMode?.(wasRaw)
      } catch {
        // The terminal is already gone; nothing to restore.
      }
      input.pause()
      if ('pick' in outcome) {
        // Collapse the question, the rows and the hint into one line.
        output.write(`\r${up(headLines + drawn)}${CLEAR_DOWN}${question} ${outcome.summary}\n${SHOW_CURSOR}`)
        resolve(outcome.pick)
      } else {
        // Leave the question alone on screen; the caller says it stopped.
        output.write(`\r${up(headLines + drawn)}${CLEAR_DOWN}${question}\n${SHOW_CURSOR}`)
        reject(outcome.error)
      }
    }
    const onKeypress = (text: string | undefined, key: Key | undefined) => {
      const name = key?.name ?? text
      if ((key?.ctrl && (name === 'c' || name === 'd')) || name === 'escape' || (name === 'q' && !key?.ctrl)) {
        return finish({ error: new PromptCancelled() })
      }
      const result = onKey(text, name)
      if (result === 'redraw') output.write(`\r${up(drawn)}${CLEAR_DOWN}${frame()}`)
      else if (result) finish(result)
    }
    const onError = (err: Error) => finish({ error: err })
    const onSigint = () => finish({ error: new PromptCancelled() })

    try {
      emitKeypressEvents(input)
      input.setRawMode?.(true)
      const cols = width()
      const top = [question, ...(note ? note.split('\n').flatMap((line) => wrapWords(line, cols)) : [])]
      headLines = top.reduce((n, line) => n + screenLines(line, cols), 0)
      output.write(`${HIDE_CURSOR}${top.map((line) => `${line}\n`).join('')}${frame()}`)
      input.on('keypress', onKeypress)
      input.on('error', onError)
      process.on('SIGINT', onSigint)
      input.resume()
    } catch (err) {
      finish({ error: err instanceof Error ? err : new Error(String(err)) })
    }
  })
}

/**
 * The hint as lines that fit `columns`: split at its " · " separators when it
 * is wider than the terminal, so it never breaks mid-word.
 */
function fitHint(hint: string, columns: number | undefined): string[] {
  if (!columns || [...hint].length <= columns) return [hint]
  const lines: string[] = []
  for (const part of hint.split(' · ')) {
    const last = lines[lines.length - 1]
    if (last !== undefined && [...`${last} · ${part}`].length <= columns) lines[lines.length - 1] = `${last} · ${part}`
    else lines.push(part)
  }
  return lines
}

/** `text` as lines that fit `columns`, broken at spaces (a word longer than a line stays whole). */
function wrapWords(text: string, columns: number | undefined): string[] {
  if (!columns || [...text].length <= columns) return [text]
  const lines: string[] = []
  for (const word of text.split(' ')) {
    const last = lines[lines.length - 1]
    if (last !== undefined && [...`${last} ${word}`].length <= columns) lines[lines.length - 1] = `${last} ${word}`
    else lines.push(word)
  }
  return lines
}

/** The marker's escape codes: the brand colour, or bold. */
function marker(options: MenuOptions): string {
  // #fd4b03, the brand primary; 202 is its nearest 256-colour code.
  return options.color ? (options.trueColor ? '\u001b[1;38;2;253;75;3m' : '\u001b[1;38;5;202m') : '\u001b[1m'
}

/** Up and Down (also k and j) wrap around; a digit jumps to that row. Null for any other key. */
function move(current: number, count: number, text: string | undefined, name: string | undefined): number | null {
  if (name === 'up' || name === 'k') return (current - 1 + count) % count
  if (name === 'down' || name === 'j') return (current + 1) % count
  if (text && /^[1-9]$/.test(text) && Number(text) <= count) return Number(text) - 1
  return null
}

/**
 * Show the menu on `output`, read keys from `input`, and resolve the picked
 * row. Rejects with PromptCancelled on Ctrl+C, Ctrl+D or SIGINT, and with the
 * error on an input error; raw mode and the cursor are restored first.
 */
export function selectMenu(
  input: MenuInput,
  output: NodeJS.WritableStream,
  question: string,
  choices: string[],
  options: MenuOptions = {}
): Promise<number> {
  let current = Math.min(Math.max(options.initial ?? 0, 0), choices.length - 1)
  const on = marker(options)
  const rows = () => choices.map((c, i) => (i === current ? `${on}> ${c}${OFF}` : `  ${c}`))
  return runMenu(input, output, { question, hint: HINT, columns: options.columns }, rows, (text, name) => {
    if (name === 'return' || name === 'enter') return { pick: current, summary: choices[current] ?? '' }
    const next = move(current, choices.length, text, name)
    if (next === null || next === current) return null
    current = next
    return 'redraw'
  })
}

/**
 * A menu where each row is ticked or not: Up and Down (also k and j) move
 * the marker, Space ticks or unticks its row, a digit ticks or unticks that
 * row, Enter accepts. Resolves the ticked rows in order, which may be none.
 * `ticked` says which rows start ticked, and the marker starts on the first
 * of them (with none ticked, on `initial`). Only the marker is coloured: a coloured row would look picked
 * when it is not ticked. Cancels and restores the terminal like
 * {@link selectMenu}.
 */
export function multiSelectMenu(
  input: MenuInput,
  output: NodeJS.WritableStream,
  question: string,
  choices: string[],
  options: TickMenuOptions = {}
): Promise<number[]> {
  const ticked = choices.map((_, i) => options.ticked?.[i] === true)
  const start = Math.min(Math.max(options.initial ?? 0, 0), choices.length - 1)
  let current = ticked.includes(true) ? ticked.indexOf(true) : start
  const pointer = `${marker(options)}>${OFF}`
  const pad = Math.max(...choices.map((c) => c.length))
  // In a narrow window the tag moves closer, then goes, rather than break mid-word.
  const label = (i: number) => {
    const tag = options.tags?.[i]
    const name = choices[i] ?? ''
    if (!tag) return name
    const cols = options.columns?.() ?? Infinity
    const grey = options.color ? `${GREY}${tag}${GREY_OFF}` : tag
    if (6 + pad + 3 + tag.length <= cols) return `${name.padEnd(pad)}   ${grey}`
    if (6 + name.length + 1 + tag.length <= cols) return `${name} ${grey}`
    return name
  }
  const rows = () => choices.map((_, i) => `${i === current ? pointer : ' '} [${ticked[i] ? 'x' : ' '}] ${label(i)}`)
  const head = { question, note: options.note, hint: options.hint ?? MULTI_HINT, columns: options.columns }
  return runMenu(input, output, head, rows, (text, name) => {
    if (name === 'return' || name === 'enter') {
      const picks = choices.flatMap((_, i) => (ticked[i] ? [i] : []))
      return { pick: picks, summary: picks.map((i) => choices[i]).join(', ') || 'none' }
    }
    if (name === 'space') {
      ticked[current] = !ticked[current]
      return 'redraw'
    }
    if (text && /^[1-9]$/.test(text) && Number(text) <= choices.length) {
      current = Number(text) - 1
      ticked[current] = !ticked[current]
      return 'redraw'
    }
    const next = move(current, choices.length, text, name)
    if (next === null || next === current) return null
    current = next
    return 'redraw'
  })
}

/**
 * Call `onEnter` at each Enter on `input` until the returned function is
 * called. Other keys do nothing and do not echo. Ctrl+C, or a SIGINT sent to
 * the process, stops listening and calls `onCancel`. Raw mode and the
 * keypress listener are restored on every way out.
 */
export function listenForEnter(input: MenuInput, onEnter: () => void, onCancel: () => void): () => void {
  const wasRaw = input.isRaw === true
  let done = false
  const stop = () => {
    if (done) return
    done = true
    input.removeListener('keypress', onKeypress)
    input.removeListener('error', stop)
    process.removeListener('SIGINT', cancel)
    try {
      input.setRawMode?.(wasRaw)
    } catch {
      // The terminal is already gone; nothing to restore.
    }
    input.pause()
  }
  const cancel = () => {
    if (done) return
    stop()
    onCancel()
  }
  const onKeypress = (_text: string | undefined, key: Key | undefined) => {
    if (key?.ctrl && key.name === 'c') cancel()
    else if (key?.name === 'return' || key?.name === 'enter') onEnter()
  }
  try {
    emitKeypressEvents(input)
    input.setRawMode?.(true)
    input.on('keypress', onKeypress)
    input.on('error', stop)
    process.on('SIGINT', cancel)
    input.resume()
  } catch {
    stop()
  }
  return stop
}

// Bracketed paste: the terminal wraps a paste in ESC[200~ and ESC[201~, so an
// empty line inside a pasted email does not end it.
const PASTE_ON = '\u001b[?2004h'
const PASTE_OFF = '\u001b[?2004l'
/** How long an empty line waits for more input: a paste in a terminal without bracketed paste arrives at once. */
const PASTE_SETTLE_MS = 150

/**
 * Print `question`, then read a pasted message from `input` up to an empty
 * line the person types (or Ctrl+D); readline echoes and edits the lines.
 * Leading empty lines are skipped. An empty line inside a paste is kept: the
 * terminal marks the paste, and where it does not, more input arriving right
 * after the empty line means it was pasted too.
 *
 * `emptyEnds`: for a question that can be skipped ("press Enter if not"), an
 * empty line typed before anything else ends it with an empty answer, instead
 * of waiting for text.
 */
export function readPaste(input: MenuInput, output: NodeJS.WritableStream, question: string, options: { emptyEnds?: boolean } = {}): Promise<string> {
  output.write(`${question}\n`)
  // No prompt: readline's default "> " would show up again on lines it redraws.
  const rl = createInterface({ input, output, terminal: true, prompt: '' })
  output.write(PASTE_ON)
  return new Promise((resolve, reject) => {
    const lines: string[] = []
    let pasting = false
    let settle: NodeJS.Timeout | undefined
    let settled = false
    const finish = (outcome: { text: string } | { error: Error }) => {
      if (settled) return
      settled = true
      clearTimeout(settle)
      input.removeListener('keypress', onKeypress)
      output.write(PASTE_OFF)
      rl.close()
      if ('text' in outcome) resolve(outcome.text)
      else reject(outcome.error)
    }
    const done = () => finish({ text: lines.join('\n').trim() })
    const onKeypress = (_text: string | undefined, key: { name?: string } | undefined) => {
      if (key?.name === 'paste-start') pasting = true
      else if (key?.name === 'paste-end') pasting = false
      else if (settle && key?.name !== 'return' && key?.name !== 'enter') {
        // More came right after the empty line: it was part of a paste.
        clearTimeout(settle)
        settle = undefined
      }
    }
    input.on('keypress', onKeypress)
    rl.on('line', (line) => {
      if (line.trim() || pasting) {
        lines.push(line)
        return
      }
      if (lines.length === 0) {
        if (options.emptyEnds) done()
        return
      }
      lines.push(line)
      clearTimeout(settle)
      settle = setTimeout(done, PASTE_SETTLE_MS)
    })
    rl.on('SIGINT', () => {
      output.write('\n')
      finish({ error: new PromptCancelled() })
    })
    rl.on('close', done)
  })
}
