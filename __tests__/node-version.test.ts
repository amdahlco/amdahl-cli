// The `amdahl` command on a Node.js older than 22: bin/amdahl.js says what to
// do and exits 1 before the CLI loads (dist/amdahl.js would fail to parse or
// crash there). The old Node is faked with a preload that rewrites
// process.versions.node. scripts/smoke-pack.mjs runs the same check through
// both packed packages.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const launcher = join(root, 'bin', 'amdahl.js')

/** Run the launcher as if on Node `version`. */
function runOn(version: string, ...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'amdahl-node-'))
  const fake = join(dir, 'fake-node-version.cjs')
  writeFileSync(fake, `Object.defineProperty(process, 'versions', { value: Object.assign({}, process.versions, { node: ${JSON.stringify(version)} }) })\n`)
  return spawnSync(process.execPath, ['--require', fake, launcher, ...args], { encoding: 'utf8' })
}

describe('the Node.js version check', () => {
  it.each(['14.21.3', '16.20.2', '18.19.1', '19.9.0', '20.19.0', '21.7.3'])('on Node %s: says what to do, exits 1, loads nothing', (version) => {
    const r = runOn(version, 'skills', 'add', 'amdahl/system-diagram')
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe(
      `amdahl needs Node.js 22 or later. This computer has Node.js ${version}.\n` +
        'Install a newer one from https://nodejs.org/en/download, then run the same command again.\n'
    )
  })

  it.each(['22.0.0', '24.19.0'])('on Node %s: goes on to the CLI', (version) => {
    expect(runOn(version, '--version').stderr).not.toContain('needs Node.js')
  })

  it('uses no syntax newer than Node 14 in the files an old Node runs first', () => {
    for (const file of [launcher, join(root, 'packages', 'amdahl', 'amdahl.js')]) {
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !line.startsWith('//'))
        .join('\n')
      // Logical assignment (Node 15), top-level await (14.8, modules only), class fields and static blocks.
      expect(code, file).not.toMatch(/\?\?=|\|\|=|&&=|\bawait\b|#[A-Za-z_]|\bstatic\s*\{|\bclass\b/)
    }
    // The bundle itself is built for Node 22: only the launcher may be the bin.
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).bin).toEqual({ amdahl: 'bin/amdahl.js' })
  })
})
