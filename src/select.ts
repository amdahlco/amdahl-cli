// src/select.ts
//
// Arrow-key menus for a terminal, on node:readline alone (no dependency): one
// that picks a row, and one that ticks any number of rows (Space ticks).
// Up and Down (also k and j) move the marker, a digit jumps to that row,
// Enter picks. Ctrl+C or Ctrl+D rejects with PromptCancelled. Raw mode, the
// keypress listener and the cursor are restored on every way out: a pick,
// a cancel, an input error, and a SIGINT sent to the process. After a pick
// the menu collapses into one line, "<question> <choice>", so the scrollback
// stays short.

import { emitKeypressEvents } from 'node:readline'
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
}

/** A key as readline's keypress event reports it. */
interface Key {
  name?: string
  ctrl?: boolean
  sequence?: string
}

const HINT = '(Use the arrow keys, then Enter)'
const MULTI_HINT = '(Use the arrow keys, Space to tick or untick, then Enter)'
const OFF = '\u001b[0m'
const HIDE_CURSOR = '\u001b[?25l'
const SHOW_CURSOR = '\u001b[?25h'
const CLEAR_LINE = '\u001b[2K'
const CLEAR_DOWN = '\u001b[0J'
const up = (n: number) => `\u001b[${n}A`

/** What a key did: settled the menu, changed the drawing, or nothing. */
type KeyResult<T> = { pick: T; summary: string } | 'redraw' | null

/**
 * The menu's life cycle, shared by both menus: draw `rows()` and the hint,
 * hand each key to `onKey`, redraw when it says so, and on a pick collapse
 * into "<question> <summary>". Rejects with PromptCancelled on Ctrl+C,
 * Ctrl+D or SIGINT, and with the error on an input error; raw mode and the
 * cursor are restored first.
 */
function runMenu<T>(
  input: MenuInput,
  output: NodeJS.WritableStream,
  question: string,
  hint: string,
  rows: () => string[],
  onKey: (text: string | undefined, name: string | undefined) => KeyResult<T>
): Promise<T> {
  const draw = () => rows().map((r) => `${CLEAR_LINE}\r${r}\n`).join('') + `${CLEAR_LINE}\r${hint}\n`
  const height = rows().length
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
        output.write(`${up(height + 2)}\r${CLEAR_DOWN}${question} ${outcome.summary}\n${SHOW_CURSOR}`)
        resolve(outcome.pick)
      } else {
        output.write(SHOW_CURSOR)
        reject(outcome.error)
      }
    }
    const onKeypress = (text: string | undefined, key: Key | undefined) => {
      const name = key?.name ?? text
      if (key?.ctrl && (name === 'c' || name === 'd')) return finish({ error: new PromptCancelled() })
      const result = onKey(text, name)
      if (result === 'redraw') output.write(`${up(height + 1)}${draw()}`)
      else if (result) finish(result)
    }
    const onError = (err: Error) => finish({ error: err })
    const onSigint = () => finish({ error: new PromptCancelled() })

    try {
      emitKeypressEvents(input)
      input.setRawMode?.(true)
      output.write(`${HIDE_CURSOR}${question}\n${draw()}`)
      input.on('keypress', onKeypress)
      input.on('error', onError)
      process.on('SIGINT', onSigint)
      input.resume()
    } catch (err) {
      finish({ error: err instanceof Error ? err : new Error(String(err)) })
    }
  })
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
  return runMenu(input, output, question, HINT, rows, (text, name) => {
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
 * `ticked` says which rows start ticked. Cancels and restores the terminal
 * like {@link selectMenu}.
 */
export function multiSelectMenu(
  input: MenuInput,
  output: NodeJS.WritableStream,
  question: string,
  choices: string[],
  options: MenuOptions & { ticked?: boolean[] } = {}
): Promise<number[]> {
  let current = 0
  const ticked = choices.map((_, i) => options.ticked?.[i] === true)
  const on = marker(options)
  const rows = () =>
    choices.map((c, i) => {
      const row = `[${ticked[i] ? 'x' : ' '}] ${c}`
      return i === current ? `${on}> ${row}${OFF}` : `  ${row}`
    })
  return runMenu(input, output, question, MULTI_HINT, rows, (text, name) => {
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
