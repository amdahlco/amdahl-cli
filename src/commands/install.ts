// src/commands/install.ts
//
// `amdahl install claude-code|codex|cursor [--print]`: point an MCP client at
// `<api>/mcp`. NEVER writes a token: every client signs in over OAuth on first
// use. `--print` only prints what it would run or write.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Ctx } from '../context'
import { CliError, EXIT, usageError } from '../errors'

const CLIENTS = ['claude-code', 'codex', 'cursor'] as const

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

/** `amdahl install <client>`. */
export async function install(ctx: Ctx, args: string[]): Promise<number> {
  const client = args[0]
  if (!client || args.length > 1 || !CLIENTS.includes(client as (typeof CLIENTS)[number])) {
    throw usageError(`Usage: amdahl install ${CLIENTS.join('|')} [--print]`)
  }
  const mcpUrl = `${ctx.apiUrl}/mcp`
  const print = ctx.flags.print === true
  const { out, io } = ctx

  if (client === 'claude-code') {
    const args = ['mcp', 'add', '--transport', 'http', 'amdahl', mcpUrl]
    const command = `claude ${args.join(' ')}`
    if (print || !(await onPath(ctx, 'claude'))) {
      out.result({ ok: true, client, action: 'printed', command }, command)
      if (!print) out.info('`claude` is not on your PATH. Run the command above once it is installed.')
      return EXIT.ok
    }
    const res = await io.run('claude', args)
    if (res.code !== 0) {
      throw new CliError('install_failed', `\`${command}\` failed: ${res.stderr.trim() || `exit ${res.code}`}`, EXIT.general)
    }
    out.result({ ok: true, client, action: 'ran', command }, `Added Amdahl to Claude Code. Run /mcp in Claude Code to sign in.`)
    return EXIT.ok
  }

  if (client === 'codex') {
    const path = join(io.homedir, '.codex', 'config.toml')
    const block = codexBlock(mcpUrl)
    if (print) {
      out.result({ ok: true, client, action: 'printed', path }, `# ${path}\n${block}`)
      return EXIT.ok
    }
    const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
    if (codexHasAmdahl(current)) {
      out.result({ ok: true, client, action: 'unchanged', path }, `${path} already has [mcp_servers.amdahl]; nothing changed.`)
      return EXIT.ok
    }
    mkdirSync(dirname(path), { recursive: true })
    const sep = current.length === 0 ? '' : current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n'
    writeFileSync(path, `${current}${sep}${block}`)
    out.result({ ok: true, client, action: 'wrote', path }, `Added Amdahl to ${path}. Run \`codex mcp login amdahl\` to sign in.`)
    return EXIT.ok
  }

  // cursor
  const path = join(io.homedir, '.cursor', 'mcp.json')
  const entry = { url: mcpUrl }
  if (print) {
    out.result(
      { ok: true, client, action: 'printed', path },
      `# ${path}\n${JSON.stringify({ mcpServers: { amdahl: entry } }, null, 2)}`
    )
    return EXIT.ok
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
    out.result({ ok: true, client, action: 'unchanged', path }, `${path} already points at ${mcpUrl}; nothing changed.`)
    return EXIT.ok
  }
  config.mcpServers = { ...servers, amdahl: entry }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
  out.result({ ok: true, client, action: 'wrote', path }, `Added Amdahl to ${path}. Cursor asks you to sign in on first use.`)
  return EXIT.ok
}
