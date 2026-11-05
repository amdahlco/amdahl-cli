// A fake process boundary: captured output, a temp config home (with a
// `project` folder as the working directory), a spy on spawned processes, and a "browser" that follows the authorize redirect to
// the CLI's loopback listener the way a signed-in browser would.

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { PromptCancelled, type Io, type ProcessResult } from '../../src/io'
import { runCli } from '../../src/main'

export interface FakeIo extends Io {
  out: string[]
  err: string[]
  opened: string[]
  stdinText: string
  /** What each prompt answers, in order; null stands for Ctrl+C. */
  answers: (string | null)[]
  /** Every question asked; a menu is `<question> [<choice> | <choice>]`. */
  prompts: string[]
  /** Whether each menu was asked for colour. */
  selectColor: boolean[]
  run: Io['run'] & ReturnType<typeof vi.fn>
}

/** A browser that follows one redirect from the authorize URL. */
export async function followAuthorize(url: string): Promise<void> {
  if (!url.includes('/oauth/authorize')) return
  const res = await fetch(url, { redirect: 'manual' })
  const location = res.headers.get('location')
  if (location) await fetch(location).then((r) => r.text())
}

export function fakeIo(env: Record<string, string | undefined> = {}, home?: string): FakeIo {
  const dir = home ?? mkdtempSync(join(tmpdir(), 'amdahl-cli-test-'))
  const cwd = join(dir, 'project')
  mkdirSync(cwd, { recursive: true })
  const io: FakeIo = {
    out: [],
    err: [],
    opened: [],
    stdinText: '',
    answers: [],
    prompts: [],
    env: { XDG_CONFIG_HOME: join(dir, 'config'), AMDAHL_CREDENTIAL_STORE: 'file', ...env },
    stdout: (t) => void io.out.push(t),
    stderr: (t) => void io.err.push(t),
    stdinIsTTY: true,
    stdoutIsTTY: false,
    stderrIsTTY: false,
    readStdin: async () => io.stdinText,
    prompt: async (question) => {
      io.prompts.push(question)
      const answer = io.answers.shift()
      if (answer === null) throw new PromptCancelled()
      return answer ?? ''
    },
    // A menu answers from the same queue: '' picks the start row, a number picks that row, null is Ctrl+C.
    select: async (question, choices, options) => {
      io.prompts.push(`${question} [${choices.join(' | ')}]`)
      io.selectColor.push(options?.color === true)
      const answer = io.answers.shift()
      if (answer === null) throw new PromptCancelled()
      const n = Number(answer)
      return answer && Number.isInteger(n) && n >= 1 && n <= choices.length ? n - 1 : (options?.initial ?? 0)
    },
    // A tick menu answers from the same queue: '' accepts the start ticks, '1,3' ticks those rows, 'none' ticks none, null is Ctrl+C.
    multiSelect: async (question, choices, options) => {
      io.prompts.push(`${question} [${choices.map((c, i) => `${options?.ticked?.[i] ? 'x' : ' '} ${c}`).join(' | ')}]`)
      io.selectColor.push(options?.color === true)
      const answer = io.answers.shift()
      if (answer === null) throw new PromptCancelled()
      if (answer === 'none') return []
      if (!answer) return choices.flatMap((_, i) => (options?.ticked?.[i] ? [i] : []))
      return answer.split(',').map((n) => Number(n) - 1)
    },
    selectColor: [],
    uninterruptible: (fn) => fn(),
    run: vi.fn(async (): Promise<ProcessResult> => ({ code: -1, stdout: '', stderr: 'not found' })),
    openUrl: async (url) => {
      io.opened.push(url)
      await followAuthorize(url)
    },
    homedir: dir,
    cwd,
    platform: 'linux',
    hostname: 'test-host',
    now: () => Date.now(),
    sleep: async () => {},
    loginTimeoutMs: 3000,
    fetchTimeoutMs: 100,
  }
  return io
}

/** Run the CLI and return the exit code plus parsed stdout JSON (when any). */
export async function cli(io: FakeIo, ...argv: string[]) {
  io.out.length = 0
  io.err.length = 0
  const code = await runCli(argv, io)
  const stdout = io.out.join('')
  const stderr = io.err.join('')
  let json: any = null
  try {
    json = stdout.trim() ? JSON.parse(stdout) : null
  } catch {
    json = null
  }
  return { code, stdout, stderr, json }
}
