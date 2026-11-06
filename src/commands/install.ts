// src/commands/install.ts
//
// `amdahl install claude-code|codex|cursor [--print] [--force]`: point an MCP
// client at `<api>/mcp` and put the Amdahl skill (the capability map) in the
// client's user skills folder. NEVER writes a token: every client signs in over
// OAuth on first use. A client that already points at Amdahl is left as it is
// (for Claude Code, `claude mcp add` is skipped), and the skill still goes in. `--print` only prints what it would run or write. An
// existing skill file that an earlier release wrote is upgraded; one the user
// edited is kept unless `--force`.
//
// Claude Code is set up with its own `claude mcp add --scope user`. When
// `claude` is not on PATH (the desktop app or an IDE extension often leaves
// none), the usual install folders are tried; when none has it, the CLI
// writes the same user-scope entry into Claude Code's settings file itself,
// after a backup. Every config file is written whole to a temp file and
// renamed into place, so a crash never leaves half a file.

import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
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

/** Each client's command on PATH and its files in the home directory: any one means it is on this machine. */
const CLIENT_SIGNS: Record<Client, { command: string; paths: string[] }> = {
  'claude-code': { command: 'claude', paths: ['.claude', '.claude.json'] },
  codex: { command: 'codex', paths: ['.codex'] },
  cursor: { command: 'cursor', paths: ['.cursor'] },
}

/** Which clients this machine has: the client's command on PATH, or its folder (or settings file) in the home directory. */
export async function detectClients(ctx: Ctx): Promise<Record<Client, boolean>> {
  const found = await Promise.all(
    CLIENTS.map(async (client) => {
      const { command, paths } = CLIENT_SIGNS[client]
      return paths.some((p) => existsSync(join(ctx.io.homedir, p))) || (await onPath(ctx, command))
    })
  )
  return Object.fromEntries(CLIENTS.map((client, i) => [client, found[i]])) as Record<Client, boolean>
}

/**
 * The file Claude Code keeps its user settings in, user-scope MCP servers
 * among them: `.claude.json` in CLAUDE_CONFIG_DIR when that is set, else in
 * the home directory. `claude mcp add --scope user` writes there.
 */
export function claudeConfigPath(ctx: Ctx): string {
  return join(ctx.io.env.CLAUDE_CONFIG_DIR || ctx.io.homedir, '.claude.json')
}

/** How this run sets up Claude Code: with its `claude` command, or by writing its settings file. */
export type ClaudeRoute = { kind: 'command'; command: string } | { kind: 'file'; path: string }

const routes = new WeakMap<Ctx, Promise<ClaudeRoute>>()

/**
 * How to reach Claude Code, worked out once per run: `claude` on PATH; else
 * the first `claude` in the folders its installers use (its own installer's
 * `~/.local/bin` and `~/.claude/local`, Homebrew, /usr/local/bin, npm's
 * global bin); else its settings file. The setup asks before the sign-in, so
 * a person never signs in only to hear Claude Code cannot be set up.
 */
export function claudeRoute(ctx: Ctx): Promise<ClaudeRoute> {
  let route = routes.get(ctx)
  if (!route) {
    route = findClaude(ctx).then((command): ClaudeRoute => (command ? { kind: 'command', command } : { kind: 'file', path: claudeConfigPath(ctx) }))
    routes.set(ctx, route)
  }
  return route
}

async function findClaude(ctx: Ctx): Promise<string | null> {
  const { io } = ctx
  if (await onPath(ctx, 'claude')) return 'claude'
  const win = io.platform === 'win32'
  const local = [join(io.homedir, '.local', 'bin', win ? 'claude.exe' : 'claude'), join(io.homedir, '.claude', 'local', win ? 'claude.exe' : 'claude')]
  const system = win ? [] : ['/opt/homebrew/bin/claude', '/usr/local/bin/claude']
  const found = [...local, ...system].find((path) => io.isExecutable(path))
  if (found) return found
  // npm's global bin last: finding it may mean running npm. A `.cmd` shim on Windows cannot be spawned without a shell, so not there.
  if (win) return null
  const prefix = io.env.npm_config_global_prefix || (await npmGlobalPrefix(ctx))
  const npmClaude = prefix ? join(prefix, 'bin', 'claude') : null
  return npmClaude && io.isExecutable(npmClaude) ? npmClaude : null
}

async function npmGlobalPrefix(ctx: Ctx): Promise<string | null> {
  const res = await ctx.io.run('npm', ['prefix', '-g'])
  const prefix = res.code === 0 ? res.stdout.trim() : ''
  return prefix || null
}

/**
 * True when Claude Code already has an `amdahl` server at `mcpUrl`, by the
 * `URL:` line of `claude mcp get amdahl`. Its output is never printed: it can
 * hold the server's headers, an API key among them.
 */
async function claudeHasAmdahl(ctx: Ctx, command: string, mcpUrl: string): Promise<boolean> {
  // Asked once a run (the setup asks before it installs): `claude mcp get` is slow. `claude mcp add` forgets the answer.
  let answer = claudeAnswers.get(ctx)
  if (!answer) {
    answer = ctx.io.run(command, ['mcp', 'get', 'amdahl']).then((res) => res.code === 0 && res.stdout.split('\n').some((line) => line.trim() === `URL: ${mcpUrl}`))
    claudeAnswers.set(ctx, answer)
  }
  return answer
}

const claudeAnswers = new WeakMap<Ctx, Promise<boolean>>()

/** What to do about a settings file the CLI will not change. */
const CONFIG_HINT = 'Fix the file, or move it away, then run the same command again.'

/** Parse a JSON settings file that must hold an object. Empty or missing is `{}`; anything else is `invalid_config`. */
function readJsonObject(path: string): { config: Record<string, unknown>; existed: boolean } {
  if (!existsSync(path)) return { config: {}, existed: false }
  const raw = readFileSync(path, 'utf8')
  if (!raw.trim()) return { config: {}, existed: true }
  let config: unknown
  try {
    config = JSON.parse(raw)
  } catch {
    throw new CliError('invalid_config', `${path} is not valid JSON; not changing it.`, EXIT.general, CONFIG_HINT)
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new CliError('invalid_config', `${path} does not hold a JSON object; not changing it.`, EXIT.general, CONFIG_HINT)
  }
  return { config: config as Record<string, unknown>, existed: true }
}

/**
 * A settings file that keeps MCP servers under `mcpServers` (Claude Code's,
 * Cursor's): the parsed file and its servers. An `mcpServers` that is there
 * but not an object (an array, a string, null) is `invalid_config`: replacing
 * it would drop whatever the person keeps there.
 */
function readMcpConfig(path: string): { config: Record<string, unknown>; servers: Record<string, unknown>; existed: boolean } {
  const { config, existed } = readJsonObject(path)
  const servers = config.mcpServers
  if (servers === undefined) return { config, servers: {}, existed }
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new CliError('invalid_config', `The "mcpServers" in ${path} is not a JSON object; not changing it.`, EXIT.general, CONFIG_HINT)
  }
  return { config, servers: servers as Record<string, unknown>, existed }
}

/** The `amdahl` user-scope entry in Claude Code's settings file, when it points at `mcpUrl`. Never throws. */
function claudeFileHasAmdahl(path: string, mcpUrl: string): boolean {
  try {
    const servers = readMcpConfig(path).servers as Record<string, { url?: unknown } | undefined>
    return servers.amdahl?.url === mcpUrl
  } catch {
    return false
  }
}

/**
 * The file a write to `path` should land in: `path` itself, or, when it is a
 * symbolic link, the file at the end of the links, even one that does not
 * exist yet (a dotfiles link whose target was never created). Renaming onto
 * the link itself would replace it with a plain file.
 */
function writeTarget(path: string): string {
  let target = path
  for (let hops = 0; hops < 40; hops++) {
    let link: boolean
    try {
      link = lstatSync(target).isSymbolicLink()
    } catch {
      return target
    }
    if (!link) return existsSync(target) ? realpathSync(target) : target
    target = resolve(dirname(target), readlinkSync(target))
  }
  throw new CliError('invalid_config', `${path} is a chain of more than 40 symbolic links; not changing it.`, EXIT.general, CONFIG_HINT)
}

/**
 * Write `text` to `path` whole: to a temp file beside it, then a rename, so a
 * crash leaves the old file or the new one and never half of one. A symbolic
 * link (a dotfiles repo, say) is followed, also to a target not created yet,
 * and stays a link. Keeps the file's mode; a new file is owner-only.
 */
function writeFileAtomic(path: string, text: string): void {
  const target = writeTarget(path)
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600
  mkdirSync(dirname(target), { recursive: true })
  const tmp = join(dirname(target), `.${basename(target)}.amdahl-${process.pid}.tmp`)
  try {
    writeFileSync(tmp, text, { mode })
    chmodSync(tmp, mode)
    renameSync(tmp, target)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/** Claude Code's settings file with the `amdahl` user-scope entry, as `claude mcp add --scope user --transport http` writes it. */
function writeClaudeConfig(ctx: Ctx, path: string, mcpUrl: string, command: string): Step {
  return updateConfig(path, (): Step => {
    const { config, servers, existed } = readMcpConfig(path)
    const data = { ok: true, client: 'claude-code', action: 'unchanged', path, command }
    if ((servers.amdahl as { url?: unknown } | undefined)?.url === mcpUrl) {
      return { data, human: `${path} already points Claude Code at ${mcpUrl}; nothing changed.`, notes: [] }
    }
    config.mcpServers = { ...servers, amdahl: { type: 'http', url: mcpUrl } }
    const backup = `${writeTarget(path)}.amdahl-backup`
    ctx.io.uninterruptible(() => {
      if (existed) copyFileSync(writeTarget(path), backup)
      writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`)
    })
    const saved = existed ? ` The file as it was is saved at ${backup}.` : ''
    return {
      data: { ...data, action: 'wrote', ...(existed ? { backup } : {}) },
      human: `Added Amdahl to Claude Code for all your projects, in ${path} (\`claude\` was not found).${saved} Run /mcp in Claude Code to sign in. If amdahl is not listed there, restart Claude Code first.`,
      notes: [],
    }
  })
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
 * True when `client` already points at Amdahl: its MCP entry is there, at
 * this API's URL. Writes nothing and never prints what it ran: the output of
 * `claude mcp get` can hold another server's headers.
 */
export async function hasAmdahl(ctx: Ctx, client: Client): Promise<boolean> {
  const mcpUrl = `${ctx.apiUrl}/mcp`
  if (client === 'claude-code') {
    if (claudeFileHasAmdahl(claudeConfigPath(ctx), mcpUrl)) return true
    const route = await claudeRoute(ctx)
    return route.kind === 'command' && (await claudeHasAmdahl(ctx, route.command, mcpUrl))
  }
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

/**
 * True when `install <client>` would change nothing: the client already
 * points at Amdahl ({@link hasAmdahl}) and its skill is current (or is the
 * person's own edit, which `install` keeps).
 */
export async function isInstalled(ctx: Ctx, client: Client): Promise<boolean> {
  const skill = skillPath(client, ctx.io.homedir)
  const current = existsSync(skill) ? readFileSync(skill, 'utf8') : null
  if (current === null || (current !== SKILL_TEXT && isShippedSkill(current))) return false
  return hasAmdahl(ctx, client)
}

/** What one install step did: its JSON, its human lines, and stderr notes. */
export interface Step {
  data: Record<string, unknown>
  human: string
  notes: string[]
}

/** Point `client` at Amdahl and add the skill, printing nothing: the caller reports both steps. */
export async function installClient(ctx: Ctx, client: Client, print: boolean): Promise<{ mcp: Step; skill: Step }> {
  const mcp = await installMcp(ctx, client, print)
  return { mcp, skill: installSkill(ctx, client, print) }
}

/** `amdahl install <client>`. */
export async function install(ctx: Ctx, args: string[]): Promise<number> {
  const client = args[0] as Client | undefined
  if (!client || args.length > 1 || !CLIENTS.includes(client)) {
    throw usageError(`Usage: amdahl install ${CLIENTS.join('|')} [--print] [--force]`)
  }
  const { mcp, skill } = await installClient(ctx, client, ctx.flags.print === true)
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
    if (print) return { data: { ok: true, client, action: 'printed', command }, human: command, notes: [] }
    const route = await claudeRoute(ctx)
    if (route.kind === 'file') return writeClaudeConfig(ctx, route.path, mcpUrl, command)
    // `claude mcp add` fails when the server is already there, so check first:
    // otherwise someone with Amdahl in Claude Code but no skill would never get it.
    if (claudeFileHasAmdahl(claudeConfigPath(ctx), mcpUrl) || (await claudeHasAmdahl(ctx, route.command, mcpUrl))) {
      return { data: { ok: true, client, action: 'unchanged', command }, human: `Claude Code already has Amdahl at ${mcpUrl}; nothing changed.`, notes: [] }
    }
    claudeAnswers.delete(ctx)
    const res = await io.run(route.command, args)
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
      const sep = current.length === 0 ? '' : current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n'
      writeFileAtomic(path, `${current}${sep}${block}`)
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
    const { config, servers } = readMcpConfig(path)
    if (JSON.stringify(servers.amdahl) === JSON.stringify(entry)) {
      return { data: { ok: true, client, action: 'unchanged', path }, human: `${path} already points at ${mcpUrl}; nothing changed.`, notes: [] }
    }
    config.mcpServers = { ...servers, amdahl: entry }
    writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`)
    return { data: { ok: true, client, action: 'wrote', path }, human: `Added Amdahl to ${path}. Cursor asks you to sign in on first use.`, notes: [] }
  })
}

/**
 * Why `client` cannot be set up, found without writing anything, or null:
 * a settings file the install would have to change is not a JSON object,
 * or its `mcpServers` is not one.
 * The setup asks this before the sign-in.
 */
export async function preflight(ctx: Ctx, client: Client): Promise<CliError | null> {
  let path: string | null = null
  if (client === 'cursor') path = cursorConfigPath(ctx.io.homedir)
  if (client === 'claude-code') {
    const route = await claudeRoute(ctx)
    if (route.kind === 'file') path = route.path
  }
  if (!path) return null
  try {
    readMcpConfig(path)
    return null
  } catch (err) {
    if (err instanceof CliError) return err
    const reason = err instanceof Error ? err.message : String(err)
    return new CliError('write_failed', `Could not read ${path} (${reason}).`, EXIT.general)
  }
}
