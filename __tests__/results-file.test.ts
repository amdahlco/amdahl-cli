// The results file of `sequence --leads`: the first write links a temp file to the name, and falls back
// to a plain exclusive write where the folder has no hard links (exFAT, some network shares).

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const link = vi.hoisted(() => ({ code: '' }))
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>()
  return {
    ...real,
    linkSync: (a: string, b: string) => {
      if (link.code) throw Object.assign(new Error(link.code), { code: link.code })
      return real.linkSync(a, b)
    },
  }
})

const { writeResultsFile } = await import('../src/results-file')

describe('writeResultsFile', () => {
  for (const code of ['EPERM', 'ENOTSUP', 'EXDEV']) {
    it(`writes the name directly when linking fails with ${code}`, () => {
      link.code = code
      const dir = mkdtempSync(join(tmpdir(), 'results-'))
      const path = join(dir, 'r.csv')
      writeResultsFile(path, 'one', true)
      expect(readFileSync(path, 'utf8')).toBe('one')
      expect(existsSync(join(dir, `.r.csv.${process.pid}.tmp`))).toBe(false)
    })
  }

  it('still refuses a file that is there', () => {
    link.code = 'EPERM'
    const dir = mkdtempSync(join(tmpdir(), 'results-'))
    const path = join(dir, 'r.csv')
    writeFileSync(path, 'mine')
    expect(() => writeResultsFile(path, 'new', true)).toThrow(/already exists/)
    expect(readFileSync(path, 'utf8')).toBe('mine')
  })

  it('another link error is still an error', () => {
    link.code = 'EIO'
    const dir = mkdtempSync(join(tmpdir(), 'results-'))
    expect(() => writeResultsFile(join(dir, 'r.csv'), 'x', true)).toThrow()
  })
})
