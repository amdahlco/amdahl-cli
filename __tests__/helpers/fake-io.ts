// A fake process boundary: captured output, a temp config home, a spy on
// spawned processes, and a "browser" that follows the authorize redirect to
// the CLI's loopback listener the way a signed-in browser would.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { Io, ProcessResult } from '../../src/io'
import { runCli } from '../../src/main'

export interface FakeIo extends Io {
  out: string[]
  err: string[]
  opened: string[]
  stdinText: string
  answers: string[]
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
  const io: FakeIo = {
    out: [],
    err: [],
    opened: [],
    stdinText: '',
    answers: [],
    env: { XDG_CONFIG_HOME: join(dir, 'config'), AMDAHL_CREDENTIAL_STORE: 'file', ...env },
    stdout: (t) => void io.out.push(t),
    stderr: (t) => void io.err.push(t),
    stdinIsTTY: true,
    stderrIsTTY: false,
    readStdin: async () => io.stdinText,
    prompt: async () => io.answers.shift() ?? '',
    run: vi.fn(async (): Promise<ProcessResult> => ({ code: -1, stdout: '', stderr: 'not found' })),
    openUrl: async (url) => {
      io.opened.push(url)
      await followAuthorize(url)
    },
    homedir: dir,
    platform: 'linux',
    hostname: 'test-host',
    now: () => Date.now(),
    sleep: async () => {},
    loginTimeoutMs: 3000,
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
