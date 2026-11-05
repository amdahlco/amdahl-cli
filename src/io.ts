// src/io.ts
//
// Everything the CLI reads from or does to the outside world, behind one
// injectable object. `bin.ts` builds the real one; tests build a fake with
// captured output, a temp home directory and a spy on spawned processes.

import { spawn } from 'node:child_process'
import { homedir, hostname } from 'node:os'
import { createInterface } from 'node:readline'
import { multiSelectMenu, selectMenu } from './select'

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
   * start ticked. Rejects with PromptCancelled on Ctrl+C or Ctrl+D.
   */
  multiSelect: (question: string, choices: string[], options?: { ticked?: boolean[]; color?: boolean }) => Promise<number[]>
  /** Run synchronous file writes that Ctrl+C must not cut off half way. */
  uninterruptible: <T>(fn: () => T) => T
  run: RunProcess
  /** Open a URL in the default browser. Never throws. */
  openUrl: (url: string) => Promise<void>
  homedir: string
  /** The working directory: where a project's skills go. */
  cwd: string
  platform: NodeJS.Platform
  hostname: string
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** How long `login` waits for the browser callback. */
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

/** The browser opener for each platform. The URL is not a secret. */
function openerFor(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === 'darwin') return ['open', [url]]
  if (platform === 'win32') return ['cmd', ['/c', 'start', '""', url]]
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
    prompt: promptLine,
    select: (question, choices, options) =>
      selectMenu(process.stdin, process.stderr, question, choices, {
        ...options,
        trueColor: /^(truecolor|24bit)$/i.test(process.env.COLORTERM ?? ''),
      }),
    multiSelect: (question, choices, options) =>
      multiSelectMenu(process.stdin, process.stderr, question, choices, {
        ...options,
        trueColor: /^(truecolor|24bit)$/i.test(process.env.COLORTERM ?? ''),
      }),
    uninterruptible,
    run: runProcess,
    openUrl: async (url) => {
      const [cmd, args] = openerFor(process.platform, url)
      await runProcess(cmd, args)
    },
    homedir: homedir(),
    cwd: process.cwd(),
    platform: process.platform,
    hostname: hostname(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    loginTimeoutMs: 300_000,
    fetchTimeoutMs: 15_000,
  }
}
