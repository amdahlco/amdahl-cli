// Bare `amdahl` when every tool already points at Amdahl: it brings an old
// skill up to date quietly. node:fs is wrapped so the refresh can fail, to
// check that the run's exit code says so even though it asks nothing.

import * as fs from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { skillPath } from '../src/skill'
import { cli, fakeIo } from './helpers/fake-io'

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, default: real, readFileSync: vi.fn(real.readFileSync) }
})

const realRead = (await vi.importActual<typeof import('node:fs')>('node:fs')).readFileSync
const OLD_SKILL = realRead(join(__dirname, 'fixtures', 'skill-0.1.3.md'), 'utf8')
const API = 'http://127.0.0.1:9'

afterEach(() => {
  vi.mocked(fs.readFileSync).mockImplementation(realRead)
})

describe('bare amdahl: already set up, the skill refresh fails', () => {
  it('still says all set and asks nothing, but exits with the failure', async () => {
    const io = fakeIo({ NO_COLOR: '1', AMDAHL_API_URL: API })
    io.stdoutIsTTY = true
    io.stderrIsTTY = true
    const skill = skillPath('cursor', io.homedir)
    fs.mkdirSync(join(io.homedir, '.cursor', 'skills', 'amdahl'), { recursive: true })
    fs.writeFileSync(join(io.homedir, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { amdahl: { url: `${API}/mcp` } } }))
    fs.writeFileSync(skill, OLD_SKILL)
    // The check that the skill is stale reads it; the refresh's own read then fails.
    let reads = 0
    vi.mocked(fs.readFileSync).mockImplementation(((...args: Parameters<typeof realRead>) => {
      if (String(args[0]) === skill && ++reads === 2) throw new Error('EACCES: permission denied')
      return realRead(...args)
    }) as typeof realRead)
    const r = await cli(io)
    expect(io.prompts).toEqual([])
    expect(r.stdout).toContain("Amdahl is in Cursor. You're all set.\n")
    expect(r.stderr).toContain('EACCES: permission denied')
    expect(r.code).toBe(1)
  })
})
