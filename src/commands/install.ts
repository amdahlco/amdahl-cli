// src/commands/install.ts
//
// `amdahl install claude-code|codex|cursor [--print] [--force]`: point an MCP
// client at `<api>/mcp` and put the Amdahl skill (the capability map) in the
// client's user skills folder. NEVER writes a token: every client signs in over
// OAuth on first use. `--print` only prints what it would run or write. An
// existing skill file that differs is kept unless `--force`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Ctx } from '../context'
import { CliError, EXIT, usageError } from '../errors'
import { SKILL_TEXT, SKILL_URL, skillPath } from '../skill'

const CLIENTS = ['claude-code', 'codex', 'cursor'] as const
type Client = (typeof CLIENTS)[number]

/** The Codex config block. `required = true` makes Codex wait for Amdahl. */
export function codexBlock(mcpUrl: string): string {
  return `[mcp_servers.amdahl]\nurl = "${mcpUrl}"\nrequired = true\n`
}

/** True when a Codex config already has an `[mcp_servers.amdahl]` table. */
export function codexHasAmdahl(toml: string): boolean {
  return /^\s*\[\s*mcp_servers\.amdahl\s*\]\s*(#.*)?$/m.test(toml)
}

/** True when `command` resolves on PATH. */
async function onPath(ctx: Ctx, command: string): Promise<boolean> {
  const probe = ctx.io.platform === 'win32' ? 'where' : 'which'
  const res = await ctx.io.run(probe, [command])
  return res.code === 0
}

/** What one install step did: its JSON, its human lines, and stderr notes. */
interface Step {
  data: Record<string, unknown>
  human: string
  notes: string[]
}

/** `amdahl install <client>`. */
export async function install(ctx: Ctx, args: string[]): Promise<number> {
  const client = args[0] as Client | undefined
  if (!client || args.length > 1 || !CLIENTS.includes(client)) {
    throw usageError(`Usage: amdahl install ${CLIENTS.join('|')} [--print] [--force]`)
  }
  const print = ctx.flags.print === true
  const mcp = await installMcp(ctx, client, print)
  const skill = installSkill(ctx, client, print)
  const human = [mcp.human.replace(/\n$/, ''), skill.human].filter(Boolean).join('\n')
  ctx.out.result({ ...mcp.data, skill: skill.data }, human)
  for (const note of [...mcp.notes, ...skill.notes]) ctx.out.info(note)
  return EXIT.ok
}

/**
 * Write the bundled skill to the client's user skills folder. Never replaces a
 * file that differs from the bundled one without `--force`, and never fails
 * the install: a write error becomes a note with the map's URL.
 */
function installSkill(ctx: Ctx, client: Client, print: boolean): Step {
  const path = skillPath(client, ctx.io.homedir)
  if (print) {
    return { data: { action: 'printed', path }, human: `# Amdahl skill: ${path}`, notes: [] }
  }
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null
  if (current === SKILL_TEXT) {
    return { data: { action: 'unchanged', path }, human: `The Amdahl skill at ${path} is up to date.`, notes: [] }
  }
  if (current !== null && ctx.flags.force !== true) {
    return {
      data: { action: 'kept', path },
      human: '',
      notes: [`Kept your changed ${path}; run again with --force to replace it with the current Amdahl skill.`],
    }
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, SKILL_TEXT)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { data: { action: 'failed', path }, human: '', notes: [`Could not write ${path} (${reason}). The map is at ${SKILL_URL}.`] }
  }
  return current === null
    ? { data: { action: 'wrote', path }, human: `Added the Amdahl skill (what Amdahl can do) at ${path}.`, notes: [] }
    : { data: { action: 'replaced', path }, human: `Replaced ${path} with the current Amdahl skill.`, notes: [] }
}

/** Point the client at `<api>/mcp`. */
async function installMcp(ctx: Ctx, client: Client, print: boolean): Promise<Step> {
  const mcpUrl = `${ctx.apiUrl}/mcp`
  const { io } = ctx

  if (client === 'claude-code') {
    const args = ['mcp', 'add', '--transport', 'http', 'amdahl', mcpUrl]
    const command = `claude ${args.join(' ')}`
    if (print || !(await onPath(ctx, 'claude'))) {
      const notes = print ? [] : ['`claude` is not on your PATH. Run the command above once it is installed.']
      return { data: { ok: true, client, action: 'printed', command }, human: command, notes }
    }
    const res = await io.run('claude', args)
    if (res.code !== 0) {
      throw new CliError('install_failed', `\`${command}\` failed: ${res.stderr.trim() || `exit ${res.code}`}`, EXIT.general)
    }
    return { data: { ok: true, client, action: 'ran', command }, human: `Added Amdahl to Claude Code. Run /mcp in Claude Code to sign in.`, notes: [] }
  }

  if (client === 'codex') {
    const path = join(io.homedir, '.codex', 'config.toml')
    const block = codexBlock(mcpUrl)
    if (print) {
      return { data: { ok: true, client, action: 'printed', path }, human: `# ${path}\n${block}`, notes: [] }
    }
    const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (codexHasAmdahl(current)) {
      return { data: { ok: true, client, action: 'unchanged', path }, human: `${path} already has [mcp_servers.amdahl]; nothing changed.`, notes: [] }
    }
    mkdirSync(dirname(path), { recursive: true })
    const sep = current.length === 0 ? '' : current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n'
    writeFileSync(path, `${current}${sep}${block}`)
    return { data: { ok: true, client, action: 'wrote', path }, human: `Added Amdahl to ${path}. Run \`codex mcp login amdahl\` to sign in.`, notes: [] }
  }

  // cursor
  const path = join(io.homedir, '.cursor', 'mcp.json')
  const entry = { url: mcpUrl }
  if (print) {
    return { data: { ok: true, client, action: 'printed', path }, human: `# ${path}\n${JSON.stringify({ mcpServers: { amdahl: entry } }, null, 2)}`, notes: [] }
  }
  let config: Record<string, unknown> = {}
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8')
    if (raw.trim()) {
      try {
        config = JSON.parse(raw) as Record<string, unknown>
      } catch {
        throw new CliError('invalid_config', `${path} is not valid JSON; not changing it.`, EXIT.general)
      }
    }
  }
  const servers = (config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}) as Record<string, unknown>
  if (JSON.stringify(servers.amdahl) === JSON.stringify(entry)) {
    return { data: { ok: true, client, action: 'unchanged', path }, human: `${path} already points at ${mcpUrl}; nothing changed.`, notes: [] }
  }
  config.mcpServers = { ...servers, amdahl: entry }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
  return { data: { ok: true, client, action: 'wrote', path }, human: `Added Amdahl to ${path}. Cursor asks you to sign in on first use.`, notes: [] }
}
