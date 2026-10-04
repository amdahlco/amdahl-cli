#!/usr/bin/env node
// scripts/sync-skill.mjs
//
// Refresh the bundled capability map, skill/SKILL.md, from the published copy.
// Refuses anything that is not a SKILL.md with `name: amdahl` frontmatter (an
// HTML error page, for example) and leaves the bundled file alone.
//
//   node scripts/sync-skill.mjs
//   pnpm sync:skill

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const URL_ = 'https://docs.amdahl.ai/skills/amdahl/SKILL.md'
const path = join(resolve(fileURLToPath(new URL('..', import.meta.url))), 'skill', 'SKILL.md')

const res = await fetch(URL_)
if (!res.ok) {
  console.error(`GET ${URL_} returned ${res.status}; skill/SKILL.md unchanged.`)
  process.exit(1)
}
const text = await res.text()
if (!/^---\nname: amdahl\ndescription: .+\n---\n/.test(text)) {
  console.error(`${URL_} is not the amdahl SKILL.md (no frontmatter); skill/SKILL.md unchanged.`)
  process.exit(1)
}
if (readFileSync(path, 'utf8') === text) {
  console.log('skill/SKILL.md is already up to date.')
} else {
  writeFileSync(path, text)
  console.log('Updated skill/SKILL.md. Review the diff and commit it.')
}
