// src/io.ts
//
// Everything the CLI reads from or does to the outside world, behind one
// injectable object. `bin.ts` builds the real one; tests build a fake with
// captured output, a temp home directory and a spy on spawned processes.

import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { createInterface } from 'node:readline'
import { listenForEnter, multiSelectMenu, readPaste, selectMenu, type TickMenuOptions } from './select'

/** Result of running a child process to completion. */
export interface ProcessResult {
  /** Exit code; -1 when the process could not start (for example ENOENT). */
  code: number
  stdout: string
  stderr: string
}

/**
 * Run a command with an optional stdin payload. Secrets travel ONLY in
 * `input`, never in `args`: argv is visible to every user on the machine.
 */
export type RunProcess = (
  command: string,
  args: string[],
  options?: { input?: string }
) => Promise<ProcessResult>

/** A prompt the person stopped with Ctrl+C or Ctrl+D: nothing was answered. */
export class PromptCancelled extends Error {
  constructor() {
    super('Cancelled.')
    this.name = 'PromptCancelled'
  }
}

/** The CLI's view of the outside world. */
export interface Io {
  env: Record<string, string | undefined>
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** True when stdin is a terminal (a person can answer prompts). */
  stdinIsTTY: boolean
  /** True when stdout is a terminal (a person is reading, not a pipe). */
  stdoutIsTTY: boolean
  /** True when stderr is a terminal (colour is allowed). */
  stderrIsTTY: boolean
  readStdin: () => Promise<string>
  /**
   * Print `question` on stderr and read a pasted message from the terminal,
   * up to an empty line typed after it (or Ctrl+D). Empty lines inside a paste
   * stay in the message. Rejects with PromptCancelled on Ctrl+C.
   */
  readPaste: (question: string) => Promise<string>
  /** Ask one question on the terminal and return the answer line. Rejects with PromptCancelled on Ctrl+C or Ctrl+D. */
  prompt: (question: string) => Promise<string>
  /**
   * Show an arrow-key menu on the terminal and return the picked row. Rejects
   * with PromptCancelled on Ctrl+C or Ctrl+D. `color` marks the row in the
   * brand colour; without it, bold.
   */
  select: (question: string, choices: string[], options?: { initial?: number; color?: boolean }) => Promise<number>
  /**
   * Show a menu of rows to tick on the terminal (Space ticks, Enter accepts)
   * and return the ticked rows in order, maybe none. `ticked` says which
   * start ticked, `tags` adds dim words after a row, `note` is a line under
   * the question and `hint` the line under the rows. Rejects with
   * PromptCancelled on Ctrl+C, Ctrl+D, Esc or q.
   */
  multiSelect: (question: string, choices: string[], options?: Omit<TickMenuOptions, 'trueColor' | 'columns'>) => Promise<number[]>
  /**
   * Call `onEnter` at each Enter on the terminal until the returned function
   * is called; other keys do nothing. Ctrl+C stops listening and calls
   * `onCancel`. The terminal is restored either way.
   */
  listenForEnter: (onEnter: () => void, onCancel: () => void) => () => void
  /** Run synchronous file writes that Ctrl+C must not cut off half way. */
  uninterruptible: <T>(fn: () => T) => T
  run: RunProcess
  /**
   * Run a command on this terminal (its input and output are the person's)
   * and resolve its exit code, -1 when it could not start. Ctrl+C goes to the
   * command, not to the CLI.
   */
  runInteractive: (command: string, args: string[]) => Promise<number>
  /** Open a URL in the default browser. Never throws; false when the opener failed. */
  openUrl: (url: string) => Promise<boolean>
  homedir: string
  /** The path the CLI was started from (process.argv[1]): under npx it is in npx's `_npx` cache folder. */
  scriptPath?: string
  /** The terminal's width in columns, when stderr is a terminal. */
  columns: () => number | undefined
  /** True when `path` is a file this user may run. */
  isExecutable: (path: string) => boolean
  /** The working directory: where a project's skills go. */
  cwd: string
  platform: NodeJS.Platform
  hostname: string
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** How long `login` waits for the browser callback: long enough to create a workspace on the way. */
  loginTimeoutMs: number
  /** How long `skills add` waits for each request, body included. */
  fetchTimeoutMs: number
}

/** Spawn a process and collect its output. Never rejects. */
export const runProcess: RunProcess = (command, args, options) =>
  new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err) })
      return
    }
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.stdin.on('error', () => {})
    if (options?.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })

/** Read all of stdin as UTF-8. */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** Ask one question on stderr and read one line from stdin. Ctrl+C or Ctrl+D rejects with PromptCancelled. */
function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  return new Promise((resolve, reject) => {
    let settled = false
    const cancel = () => {
      if (settled) return
      settled = true
      process.stderr.write('\n')
      rl.close()
      reject(new PromptCancelled())
    }
    rl.on('SIGINT', cancel)
    rl.on('close', cancel)
    rl.question(question, (answer) => {
      settled = true
      rl.close()
      resolve(answer)
    })
  })
}

/** Run a command on this terminal; the CLI ignores Ctrl+C meanwhile, so it reaches only the command. */
function runOnTerminal(command: string, args: string[]): Promise<number> {
  const hold = () => {}
  process.on('SIGINT', hold)
  return new Promise<number>((resolve) => {
    let child
    try {
      child = spawn(command, args, { stdio: 'inherit' })
    } catch {
      resolve(-1)
      return
    }
    child.on('error', () => resolve(-1))
    child.on('close', (code) => resolve(code ?? -1))
  }).finally(() => process.off('SIGINT', hold))
}

/**
 * Hold Ctrl+C while `fn` runs. `fn` is synchronous, so a SIGINT that arrives
 * meanwhile is handled (and dropped) only after it has finished: an install
 * is never left half written.
 */
function uninterruptible<T>(fn: () => T): T {
  const hold = () => {}
  process.on('SIGINT', hold)
  try {
    return fn()
  } finally {
    // Let a SIGINT queued during fn reach `hold` before the default comes back.
    setImmediate(() => process.off('SIGINT', hold))
  }
}

/** True when `path` is a file (following links) this user may run. */
function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The browser opener for each platform. The URL is not a secret. On Windows
 * it is `rundll32`, which takes the URL whole: `cmd /c start` runs the text
 * after an `&` in the URL as a second command.
 */
export function openerFor(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === 'darwin') return ['open', [url]]
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]]
  return ['xdg-open', [url]]
}

/** Build the real {@link Io} for the running process. */
export function realIo(): Io {
  return {
    env: process.env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stderrIsTTY: Boolean(process.stderr.isTTY),
    readStdin: readAllStdin,
    readPaste: (question) => readPaste(process.stdin, process.stderr, question),
    prompt: promptLine,
    select: (question, choices, options) =>
      selectMenu(process.stdin, process.stderr, question, choices, {
        ...options,
        trueColor: /^(truecolor|24bit)$/i.test(process.env.COLORTERM ?? ''),
        columns: () => process.stderr.columns,
      }),
    multiSelect: (question, choices, options) =>
      multiSelectMenu(process.stdin, process.stderr, question, choices, {
        ...options,
        trueColor: /^(truecolor|24bit)$/i.test(process.env.COLORTERM ?? ''),
        columns: () => process.stderr.columns,
      }),
    listenForEnter: (onEnter, onCancel) => listenForEnter(process.stdin, onEnter, onCancel),
    uninterruptible,
    run: runProcess,
    runInteractive: runOnTerminal,
    openUrl: async (url) => {
      const [cmd, args] = openerFor(process.platform, url)
      return (await runProcess(cmd, args)).code === 0
    },
    homedir: homedir(),
    scriptPath: process.argv[1],
    columns: () => process.stderr.columns,
    isExecutable,
    cwd: process.cwd(),
    platform: process.platform,
    hostname: hostname(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    loginTimeoutMs: 900_000,
    fetchTimeoutMs: 15_000,
  }
}
