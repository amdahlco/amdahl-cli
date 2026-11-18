// The `amdahl` package (packages/amdahl) is the short name for @amdahl/cli:
// `npx amdahl ...` must run the same CLI at the same version, with nothing
// else installed. scripts/smoke-pack.mjs packs both and runs it for real.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/version'

const root = join(__dirname, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const cli = JSON.parse(read('package.json'))
const short = JSON.parse(read('packages/amdahl/package.json'))

describe('the amdahl package', () => {
  it('has the CLI version and depends on exactly that version, and nothing else', () => {
    expect(short.name).toBe('amdahl')
    expect(short.version).toBe(cli.version)
    expect(short.version).toBe(VERSION)
    expect(short.dependencies).toEqual({ '@amdahl/cli': cli.version })
    expect(short.devDependencies).toBeUndefined()
    expect(short.optionalDependencies).toBeUndefined()
    expect(short.peerDependencies).toBeUndefined()
    expect(short.scripts).toBeUndefined()
  })

  it('gives the same `amdahl` command, which only loads the CLI bin', () => {
    expect(short.bin).toEqual({ amdahl: 'amdahl.js' })
    expect(cli.bin).toEqual({ amdahl: 'bin/amdahl.js' })
    const shim = read('packages/amdahl/amdahl.js')
    expect(shim.startsWith('#!/usr/bin/env node\n')).toBe(true)
    expect(shim.split('\n').filter((l) => l && !l.startsWith('//') && !l.startsWith('#!'))).toEqual([
      "import '@amdahl/cli/bin/amdahl.js'",
    ])
    expect(statSync(join(root, 'packages/amdahl/amdahl.js')).mode & 0o111).not.toBe(0)
  })

  // No `engines` in either package: npm installs the newest version whose `engines` match, so
  // `>=22` made Node 20 get 0.3.7 silently, and the documented commands said "Unknown command".
  // Without it, every Node gets the latest, and bin/amdahl.js refuses an old Node clearly.
  it('declares no engines, so an old Node gets the latest and its clear Node message', () => {
    expect(cli.engines).toBeUndefined()
    expect(short.engines).toBeUndefined()
  })

  it('ships the same licence and publish settings as the CLI', () => {
    expect(read('packages/amdahl/LICENSE')).toBe(read('LICENSE'))
    expect(short.license).toBe(cli.license)
    expect(short.engines).toEqual(cli.engines)
    expect(short.publishConfig).toEqual(cli.publishConfig)
    expect(short.files).toEqual(['amdahl.js', 'README.md', 'LICENSE'])
  })
})
