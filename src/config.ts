// src/config.ts
//
// The non-secret config file: profiles, each bound to one workspace on one
// API host. Tokens never live here (see secrets.ts). The file and its
// directory are owner-only (0600 / 0700) all the same, because the profile
// names the user's email and workspace.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Io } from './io'

/** A workspace as stored in a profile. */
export interface StoredWorkspace {
  id: string
  name: string
  slug: string
}

/** One signed-in profile. */
export interface Profile {
  api_url: string
  user_id: string
  email: string | null
  workspace: StoredWorkspace
  scopes: string[]
  created_at: string
}

/** The whole config file. */
export interface Config {
  version: 1
  default_profile: string | null
  profiles: Record<string, Profile>
  /**
   * Print a feedback link to each optimize run's page in the console. The page
   * is for Amdahl staff, so absent means off. `AMDAHL_FEEDBACK_LINK` overrides
   * it (see {@link feedbackLinkOn}).
   */
  feedbackLink?: boolean
}

/**
 * The config directory: `%APPDATA%\amdahl` on Windows, otherwise
 * `${XDG_CONFIG_HOME:-~/.config}/amdahl`.
 */
export function configDir(io: Io): string {
  if (io.platform === 'win32' && io.env.APPDATA) return join(io.env.APPDATA, 'amdahl')
  const base = io.env.XDG_CONFIG_HOME || join(io.homedir, '.config')
  return join(base, 'amdahl')
}

/** Path of `config.json`. */
export function configPath(io: Io): string {
  return join(configDir(io), 'config.json')
}

/** An empty config. */
export function emptyConfig(): Config {
  return { version: 1, default_profile: null, profiles: {} }
}

/** Read the config, or an empty one when absent or unreadable. */
export function loadConfig(io: Io): Config {
  const path = configPath(io)
  if (!existsSync(path)) return emptyConfig()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>
    return {
      version: 1,
      default_profile: typeof parsed.default_profile === 'string' ? parsed.default_profile : null,
      profiles: parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {},
      ...(typeof parsed.feedbackLink === 'boolean' ? { feedbackLink: parsed.feedbackLink } : {}),
    }
  } catch {
    return emptyConfig()
  }
}

/**
 * Write a JSON file owner-only and atomically (temp file, then rename). The
 * chmod after the write covers a file that already existed with a wider mode.
 *
 * @param path - the destination.
 * @param data - the value to serialise.
 */
export function writePrivateJson(path: string, data: unknown): void {
  const dir = join(path, '..')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
  chmodSync(path, 0o600)
}

/** Persist the config. */
export function saveConfig(io: Io, config: Config): void {
  writePrivateJson(configPath(io), config)
}

/**
 * The profile a command should use: `--profile`, then `AMDAHL_PROFILE`, then
 * the config's `default_profile`. Returns the name even when no such profile
 * exists, so callers can say which one is missing.
 */
export function selectedProfileName(
  io: Io,
  config: Config,
  flag: string | undefined
): string | null {
  return flag || io.env.AMDAHL_PROFILE || config.default_profile || null
}

/**
 * Whether `optimize` prints the feedback link: `AMDAHL_FEEDBACK_LINK`
 * (`0`/`false`/`off` or `1`/`true`/`on`) wins, then the config's `feedbackLink`,
 * then off. The link opens an internal run page, so only Amdahl staff turn it on.
 */
export function feedbackLinkOn(io: Io, config: Config): boolean {
  const env = io.env.AMDAHL_FEEDBACK_LINK?.trim().toLowerCase()
  if (env === '0' || env === 'false' || env === 'off') return false
  if (env === '1' || env === 'true' || env === 'on') return true
  return config.feedbackLink ?? false
}
