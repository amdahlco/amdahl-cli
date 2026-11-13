// src/history.ts
//
// The runs this computer made, for `amdahl runs`. The API has no read that
// lists a person's optimize runs (only `GET /messages/optimize/runs/:id`, one
// run by its id), and the console keeps its own "recent" list in the browser.
// So the CLI keeps the same thing: `runs.json` beside `config.json`, holding
// each run's id, when it was made, what kind it was and its channel. Never the
// message, the draft or the prompt: the text is read back from the server by
// id (`amdahl run <id>`), which only the person who made the run may do.
//
// Writing it is best effort. A full disk or a read-only home never fails the
// command that made the run. The newest runs are kept, up to {@link MAX_KEPT}.
// The file is owner-only (0600, in a 0700 folder), like config.json.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configDir, writePrivateJson } from './config'
import type { Credential, Ctx } from './context'
import { field, records } from './text'

/** What made the run. */
export type RunKind = 'optimize' | 'grade' | 'prompt'

/** One remembered run. */
export interface RunRecord {
  run_id: string
  /** When the CLI saw it start (ISO time). */
  created_at: string
  kind: RunKind
  /** `email` or `linkedin`, when the run was told. */
  channel?: string
  /** The API host the run was made on. */
  api_url: string
  /** The profile that made it, for a run made with a sign-in. */
  profile?: string
  /** The workspace's slug, for a run made with a sign-in. */
  workspace?: string
  /**
   * The key's display prefix (`amdhl_1a2b3c`, the first 14 characters `keys list` shows, not
   * the secret), for a run made with an API key: a key belongs to one workspace, and the
   * prefix keeps one key's runs apart from another's and from a sign-in's.
   */
  key?: string
}

/** Who made a run: a sign-in's profile, or an API key's display prefix; neither for a run made with a bare access token. */
export interface RunOwner {
  profile?: string
  key?: string
}

/** How many characters of a key are its display prefix (`keygen.ts` sends the same to the server). */
const KEY_PREFIX_CHARS = 14

/** The owner a credential's runs are kept under. */
export function ownerOf(credential: Credential): RunOwner {
  if (credential.profile) return { profile: credential.profile }
  if (credential.source === 'flag' || credential.source === 'env:AMDAHL_KEY' || credential.source === 'env:AMDAHL_API_KEY') {
    return { key: credential.token.slice(0, KEY_PREFIX_CHARS) }
  }
  return {}
}

/** How many runs the file keeps. */
export const MAX_KEPT = 50

const KINDS: RunKind[] = ['optimize', 'grade', 'prompt']

/** Where the file lives. */
export function historyPath(ctx: Ctx): string {
  return join(configDir(ctx.io), 'runs.json')
}

function readAll(ctx: Ctx): RunRecord[] {
  const path = historyPath(ctx)
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { runs?: unknown }
    return records(parsed.runs).flatMap((r) => {
      const run_id = field(r.run_id)
      const created_at = field(r.created_at)
      const kind = KINDS.find((k) => k === r.kind)
      const api_url = field(r.api_url)
      if (!run_id || !kind || !api_url || !Number.isFinite(Date.parse(created_at))) return []
      const channel = field(r.channel)
      const profile = field(r.profile)
      const workspace = field(r.workspace)
      const key = field(r.key)
      return [{ run_id, created_at, kind, api_url, ...(channel ? { channel } : {}), ...(profile ? { profile } : {}), ...(workspace ? { workspace } : {}), ...(key ? { key } : {}) }]
    })
  } catch {
    return []
  }
}

/**
 * Remember a run this command started. Never throws: a run that was made is
 * the result, and the list is only a convenience.
 *
 * @param credential - what made the run: a sign-in's profile, or an API key (kept by its display prefix).
 */
export function rememberRun(ctx: Ctx, run: { run_id: unknown; kind: RunKind; channel?: string }, credential: Credential): void {
  const run_id = field(run.run_id)
  if (!run_id) return
  try {
    const owner = ownerOf(credential)
    const record: RunRecord = {
      run_id,
      created_at: new Date(ctx.io.now()).toISOString(),
      kind: run.kind,
      api_url: ctx.apiUrl,
      ...(run.channel ? { channel: run.channel } : {}),
      ...(owner.profile ? { profile: owner.profile } : {}),
      ...(owner.profile && ctx.profile?.workspace.slug ? { workspace: ctx.profile.workspace.slug } : {}),
      ...(owner.key ? { key: owner.key } : {}),
    }
    const kept = readAll(ctx).filter((r) => r.run_id !== run_id)
    writePrivateJson(historyPath(ctx), { version: 1, runs: [...kept, record].slice(-MAX_KEPT) })
  } catch {
    // Best effort.
  }
}

/**
 * THE one place `amdahl runs` reads its list from. It is the local list, a
 * fallback: when the server has a read that lists a person's runs (a
 * `messages.list_runs` op is planned), swap this function for it and nothing
 * else changes.
 *
 * The runs made from this computer on this API host by this owner, newest
 * first: a sign-in sees its profile's runs, and a key sees its own (a run
 * kept before 0.5.0 carries no key, so a key also sees those: they cannot be told apart).
 *
 * @param owner - who is asking; see {@link currentOwner}.
 */
export function recentRuns(ctx: Ctx, owner: RunOwner = currentOwner(ctx)): RunRecord[] {
  return readAll(ctx)
    .filter((r) => r.api_url === ctx.apiUrl && sameOwner(r, owner))
    .reverse()
}

function sameOwner(r: RunRecord, owner: RunOwner): boolean {
  if (owner.profile) return r.profile === owner.profile
  if (owner.key) return !r.profile && (r.key === owner.key || r.key === undefined)
  return !r.profile && r.key === undefined
}

/** The remembered record of one run, when this computer made it. */
export function findRun(ctx: Ctx, runId: string, owner: RunOwner = currentOwner(ctx)): RunRecord | undefined {
  return recentRuns(ctx, owner).find((r) => r.run_id.toLowerCase() === runId.toLowerCase())
}

/**
 * Who a command's credential would be, without resolving it (no refresh, no
 * network): a key from `--api-key` or the environment is its display prefix, a
 * bare access token is nobody's, a sign-in is the selected profile.
 */
export function currentOwner(ctx: Ctx): RunOwner {
  const flag = ctx.flags['api-key']
  if (typeof flag === 'string' && flag) return { key: flag.slice(0, KEY_PREFIX_CHARS) }
  const env = ctx.io.env
  if (env.AMDAHL_KEY) return { key: env.AMDAHL_KEY.slice(0, KEY_PREFIX_CHARS) }
  if (env.AMDAHL_API_KEY) return { key: env.AMDAHL_API_KEY.slice(0, KEY_PREFIX_CHARS) }
  if (env.AMDAHL_ACCESS_TOKEN) return {}
  return ctx.profileName ? { profile: ctx.profileName } : {}
}
