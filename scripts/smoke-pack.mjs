#!/usr/bin/env node
// scripts/smoke-pack.mjs
//
// Prove the packed tarball is self-contained: build, `pnpm pack`, install the
// tarball into a throwaway npm prefix with no network, and run
// `amdahl --version` from the installed bin. Exits non-zero on any failure.
//
//   node scripts/smoke-pack.mjs
//   pnpm smoke:pack

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = resolve(fileURLToPath(new URL('..', import.meta.url)))
const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
const work = mkdtempSync(join(tmpdir(), 'amdahl-cli-smoke-'))
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts })

try {
  run('pnpm', ['build'], { cwd: pkgDir })
  run('pnpm', ['pack', '--pack-destination', work], { cwd: pkgDir })
  const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'))
  if (tgz !== `amdahl-cli-${version}.tgz`) throw new Error(`unexpected tarball name: ${tgz}`)

  const prefix = join(work, 'prefix')
  run('npm', ['install', '-g', '--prefix', prefix, '--offline', '--no-audit', '--no-fund', join(work, tgz)])
  const bin = process.platform === 'win32' ? join(prefix, 'amdahl.cmd') : join(prefix, 'bin', 'amdahl')
  const out = run(bin, ['--version']).trim()
  if (out !== version) throw new Error(`amdahl --version printed "${out}", expected "${version}"`)
  console.log(`ok: ${tgz} installs and runs (amdahl --version = ${out})`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
