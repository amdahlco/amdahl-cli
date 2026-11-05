// src/commands/install.ts
//
// `amdahl install claude-code|codex|cursor [--print] [--force]`: point an MCP
// client at `<api>/mcp` and put the Amdahl skill (the capability map) in the
// client's user skills folder. NEVER writes a token: every client signs in over
// OAuth on first use. A client that already points at Amdahl is left as it is
// (for Claude Code, `claude mcp add` is skipped), and the skill still goes in. `--print` only prints what it would run or write. An
// existing skill file that an earlier release wrote is upgraded; one the user
// edited is kept unless `--force`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Ctx } from '../context'
import { CliError, EXIT, usageError } from '../errors'
import { SKILL_TEXT, SKILL_URL, isShippedSkill, skillPath } from '../skill'

/** The clients `install` sets up. */
export const CLIENTS = ['claude-code', 'codex', 'cursor'] as const
/** One of {@link CLIENTS}. */
export type Client = (typeof CLIENTS)[number]

/** Where Codex keeps its MCP servers. */
function codexConfigPath(home: string): string {
  return join(home, '.codex', 'config.toml')
}

/** Where Cursor keeps its user MCP servers. */
function cursorConfigPath(home: string): string {
  return join(home, '.cursor', 'mcp.json')
}

/** The Codex config block. `required = true` makes Codex wait for Amdahl. */
export function codexBlock(mcpUrl: string): string {
  return `[mcp_servers.amdahl]\nurl = "${mcpUrl}"\nrequired = true\n`
}

/** True when a Codex config already has an `[mcp_servers.amdahl]` table. */
export function codexHasAmdahl(toml: string): boolean {
  return /^\s*\[\s*mcp_servers\.amdahl\s*\]\s*(#.*)?$/m.test(toml)
}

/** True when `command` resolves on PATH. */
export async function onPath(ctx: Ctx, command: string): Promise<boolean> {
  const probe = ctx.io.platform === 'win32' ? 'where' : 'which'
  const res = await ctx.io.run(probe, [command])
  return res.code === 0
}

/** Each client's command on PATH and its folder in the home directory: either one means it is on this machine. */
const CLIENT_SIGNS: Record<Client, { command: string; dir: string }> = {
  'claude-code': { command: 'claude', dir: '.claude' },
  codex: { command: 'codex', dir: '.codex' },
  cursor: { command: 'cursor', dir: '.cursor' },
}

/** Which clients this machine has: the client's command on PATH, or its folder in the home directory. */
export async function detectClients(ctx: Ctx): Promise<Record<Client, boolean>> {
  const found = await Promise.all(
    CLIENTS.map(async (client) => {
      const { command, dir } = CLIENT_SIGNS[client]
      return existsSync(join(ctx.io.homedir, dir)) || (await onPath(ctx, command))
    })
  )
  return Object.fromEntries(CLIENTS.map((client, i) => [client, found[i]])) as Record<Client, boolean>
}

/**
 * True when Claude Code already has an `amdahl` server at `mcpUrl`, by the
 * `URL:` line of `claude mcp get amdahl`. Its output is never printed: it can
 * hold the server's headers, an API key among them.
 */
async function claudeHasAmdahl(ctx: Ctx, mcpUrl: string): Promise<boolean> {
  const res = await ctx.io.run('claude', ['mcp', 'get', 'amdahl'])
  return res.code === 0 && res.stdout.split('\n').some((line) => line.trim() === `URL: ${mcpUrl}`)
}

/**
 * Run the file reads and writes of one config update. A failure that is not
 * already a CliError (EACCES, ENOTDIR, a folder where the file should be)
 * becomes `write_failed` (exit 1) that names the file, not a network error.
 */
function updateConfig<T>(path: string, fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof CliError) throw err
    const reason = err instanceof Error ? err.message : String(err)
    throw new CliError('write_failed', `Could not update ${path} (${reason}).`, EXIT.general)
  }
}

/**
 * True when `install <client>` would change nothing: the client already
 * points at Amdahl and its skill is current (or is the person's own edit,
 * which `install` keeps). Writes nothing and never prints what it ran: the
 * output of `claude mcp get` can hold another server's headers.
 */
export async function isInstalled(ctx: Ctx, client: Client): Promise<boolean> {
  const skill = skillPath(client, ctx.io.homedir)
  const current = existsSync(skill) ? readFileSync(skill, 'utf8') : null
  if (current === null || (current !== SKILL_TEXT && isShippedSkill(current))) return false
  const mcpUrl = `${ctx.apiUrl}/mcp`
  if (client === 'claude-code') return (await onPath(ctx, 'claude')) && (await claudeHasAmdahl(ctx, mcpUrl))
  if (client === 'codex') {
    const path = codexConfigPath(ctx.io.homedir)
    return existsSync(path) && codexHasAmdahl(readFileSync(path, 'utf8'))
  }
  try {
    const config = JSON.parse(readFileSync(cursorConfigPath(ctx.io.homedir), 'utf8')) as { mcpServers?: { amdahl?: unknown } }
    return JSON.stringify(config.mcpServers?.amdahl) === JSON.stringify({ url: mcpUrl })
  } catch {
    return false
  }
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
 * Write the bundled skill to the client's user skills folder. Replaces a copy
 * an earlier release wrote, but never a file the user edited without
 * `--force`, and never fails the install: a write error becomes a note with
 * the map's URL.
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
  if (current !== null && !isShippedSkill(current) && ctx.flags.force !== true) {
    return {
      data: { action: 'kept', path },
      human: '',
      notes: [`Kept ${path}: it differs from every Amdahl skill this CLI has shipped, so it may have your edits. Run again with --force to replace it with the current Amdahl skill.`],
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
    // User scope: Amdahl works in every project, not only the folder the
    // command ran from (the default local scope ties it to that one folder).
    const args = ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'amdahl', mcpUrl]
    const command = `claude ${args.join(' ')}`
    if (print || !(await onPath(ctx, 'claude'))) {
      const notes = print ? [] : ['`claude` is not on your PATH. Run the command above once it is installed.']
      return { data: { ok: true, client, action: 'printed', command }, human: command, notes }
    }
    // `claude mcp add` fails when the server is already there, so check first:
    // otherwise someone with Amdahl in Claude Code but no skill would never get it.
    if (await claudeHasAmdahl(ctx, mcpUrl)) {
      return { data: { ok: true, client, action: 'unchanged', command }, human: `Claude Code already has Amdahl at ${mcpUrl}; nothing changed.`, notes: [] }
    }
    const res = await io.run('claude', args)
    if (res.code !== 0) {
      throw new CliError('install_failed', `\`${command}\` failed: ${res.stderr.trim() || `exit ${res.code}`}`, EXIT.general)
    }
    return { data: { ok: true, client, action: 'ran', command }, human: `Added Amdahl to Claude Code for all your projects. Run /mcp in Claude Code to sign in. If amdahl is not listed there, restart Claude Code first.`, notes: [] }
  }

  if (client === 'codex') {
    const path = codexConfigPath(io.homedir)
    const block = codexBlock(mcpUrl)
    if (print) {
      return { data: { ok: true, client, action: 'printed', path }, human: `# ${path}\n${block}`, notes: [] }
    }
    return updateConfig(path, (): Step => {
      const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
      if (codexHasAmdahl(current)) {
        return { data: { ok: true, client, action: 'unchanged', path }, human: `${path} already has [mcp_servers.amdahl]; nothing changed.`, notes: [] }
      }
      mkdirSync(dirname(path), { recursive: true })
      const sep = current.length === 0 ? '' : current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n'
      writeFileSync(path, `${current}${sep}${block}`)
      return { data: { ok: true, client, action: 'wrote', path }, human: `Added Amdahl to ${path}. Run \`codex mcp login amdahl\` to sign in.`, notes: [] }
    })
  }

  // cursor
  const path = cursorConfigPath(io.homedir)
  const entry = { url: mcpUrl }
  if (print) {
    return { data: { ok: true, client, action: 'printed', path }, human: `# ${path}\n${JSON.stringify({ mcpServers: { amdahl: entry } }, null, 2)}`, notes: [] }
  }
  return updateConfig(path, (): Step => {
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
  })
}
