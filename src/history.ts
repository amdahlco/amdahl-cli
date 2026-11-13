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
import type { Ctx } from './context'
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
      return [{ run_id, created_at, kind, api_url, ...(channel ? { channel } : {}), ...(profile ? { profile } : {}), ...(workspace ? { workspace } : {}) }]
    })
  } catch {
    return []
  }
}

/**
 * Remember a run this command started. Never throws: a run that was made is
 * the result, and the list is only a convenience.
 *
 * @param credentialProfile - the profile name when the run was made with a sign-in.
 */
export function rememberRun(ctx: Ctx, run: { run_id: unknown; kind: RunKind; channel?: string }, credentialProfile?: string): void {
  const run_id = field(run.run_id)
  if (!run_id) return
  try {
    const record: RunRecord = {
      run_id,
      created_at: new Date(ctx.io.now()).toISOString(),
      kind: run.kind,
      api_url: ctx.apiUrl,
      ...(run.channel ? { channel: run.channel } : {}),
      ...(credentialProfile ? { profile: credentialProfile } : {}),
      ...(credentialProfile && ctx.profile?.workspace.slug ? { workspace: ctx.profile.workspace.slug } : {}),
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
 * The runs made from this computer on this API host (and, for a sign-in, this
 * profile), newest first.
 *
 * @param credentialProfile - the profile name when the credential is a sign-in; a key sees the runs made with keys.
 */
export function recentRuns(ctx: Ctx, credentialProfile?: string): RunRecord[] {
  return readAll(ctx)
    .filter((r) => r.api_url === ctx.apiUrl && (r.profile ?? undefined) === credentialProfile)
    .reverse()
}

/** The remembered record of one run, when this computer made it. */
export function findRun(ctx: Ctx, runId: string, credentialProfile?: string): RunRecord | undefined {
  return recentRuns(ctx, credentialProfile).find((r) => r.run_id.toLowerCase() === runId.toLowerCase())
}

/**
 * The profile name a command's credential would carry, without resolving it
 * (no refresh, no network): a key from `--api-key` or the environment carries
 * none, a sign-in carries the selected profile's.
 */
export function currentProfile(ctx: Ctx): string | undefined {
  if (typeof ctx.flags['api-key'] === 'string' && ctx.flags['api-key']) return undefined
  const env = ctx.io.env
  if (env.AMDAHL_KEY || env.AMDAHL_API_KEY || env.AMDAHL_ACCESS_TOKEN) return undefined
  return ctx.profileName ?? undefined
}
