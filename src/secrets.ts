// src/secrets.ts
//
// Where OAuth tokens live. The OS keychain first (service `amdahl-cli`,
// account `<api_host>/<profile>`): macOS through `security`, Linux through
// `secret-tool`. Without one, an owner-only `credentials.json`, announced by a
// one-time warning when that file is first created. AMDAHL_CREDENTIAL_STORE
// (`keychain` or `file`) forces either.
//
// THE SECRET NEVER GOES ON ARGV. Any local user can read another process's
// arguments (`ps`), so a store passes the token on the child's stdin only:
// `security -i` reads its whole command from stdin, and `secret-tool store`
// reads the secret from stdin. Pinned by __tests__/secrets.test.ts, which spies
// on every spawn.

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { configDir, writePrivateJson } from './config'
import { CliError, EXIT } from './errors'
import type { Io, RunProcess } from './io'

/** The keychain service name. */
export const KEYCHAIN_SERVICE = 'amdahl-cli'

/** The secrets kept per profile. */
export interface Secrets {
  access_token: string
  refresh_token: string
  /** ISO-8601 time the access token expires. */
  access_expires_at: string
}

/** A place to keep {@link Secrets}, keyed by account. */
export interface SecretStore {
  get: (account: string) => Promise<Secrets | null>
  set: (account: string, secrets: Secrets) => Promise<void>
  delete: (account: string) => Promise<void>
}

/** The keychain account for a profile: `<api_host>/<profile>`. */
export function keychainAccount(apiUrl: string, profile: string): string {
  return `${new URL(apiUrl).host}/${profile}`
}

/** Encode secrets for a keychain entry (base64 needs no shell quoting). */
function encode(secrets: Secrets): string {
  return Buffer.from(JSON.stringify(secrets), 'utf8').toString('base64')
}

/**
 * The value as {@link Secrets}, or null when any field is missing or wrong.
 * An expiry that is not a parseable date reads as missing, so the caller asks
 * for a new sign-in instead of sending a token it cannot date.
 */
function asSecrets(value: unknown): Secrets | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.access_token !== 'string' || typeof v.refresh_token !== 'string') return null
  if (typeof v.access_expires_at !== 'string' || !Number.isFinite(Date.parse(v.access_expires_at))) {
    return null
  }
  return {
    access_token: v.access_token,
    refresh_token: v.refresh_token,
    access_expires_at: v.access_expires_at,
  }
}

/** Decode a keychain entry, or null when it is not ours. */
function decode(raw: string): Secrets | null {
  try {
    return asSecrets(JSON.parse(Buffer.from(raw.trim(), 'base64').toString('utf8')))
  } catch {
    // Not ours.
    return null
  }
}

/** Quote one argument for the `security -i` command line. */
function q(value: string): string {
  return `"${value.replace(/["\\]/g, '\\$&')}"`
}

/** The macOS keychain, through `/usr/bin/security`. */
export function macKeychain(run: RunProcess): SecretStore {
  return {
    async get(account) {
      const res = await run('security', [
        'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w',
      ])
      return res.code === 0 ? decode(res.stdout) : null
    },
    async set(account, secrets) {
      // The whole command, secret included, goes on stdin.
      const command = `add-generic-password -U -s ${q(KEYCHAIN_SERVICE)} -a ${q(account)} -w ${encode(secrets)}\n`
      const res = await run('security', ['-i'], { input: command })
      if (res.code !== 0) throw new Error(`security exited ${res.code}`)
    },
    async delete(account) {
      await run('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account])
    },
  }
}

/** The freedesktop Secret Service, through `secret-tool`. */
export function linuxSecretTool(run: RunProcess): SecretStore {
  return {
    async get(account) {
      const res = await run('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'account', account])
      return res.code === 0 ? decode(res.stdout) : null
    },
    async set(account, secrets) {
      const res = await run(
        'secret-tool',
        ['store', '--label', `Amdahl CLI (${account})`, 'service', KEYCHAIN_SERVICE, 'account', account],
        { input: encode(secrets) }
      )
      if (res.code !== 0) throw new Error(`secret-tool exited ${res.code}`)
    },
    async delete(account) {
      await run('secret-tool', ['clear', 'service', KEYCHAIN_SERVICE, 'account', account])
    },
  }
}

/** Path of the fallback `credentials.json`. */
export function credentialsPath(io: Io): string {
  return join(configDir(io), 'credentials.json')
}

interface CredentialsFile {
  version: 1
  accounts: Record<string, Secrets>
}

function readCredentials(path: string): CredentialsFile {
  if (!existsSync(path)) return { version: 1, accounts: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CredentialsFile>
    return { version: 1, accounts: parsed.accounts ?? {} }
  } catch {
    return { version: 1, accounts: {} }
  }
}

/**
 * The owner-only file store.
 *
 * @param io - the process boundary.
 * @param warn - whether creating the file prints the one-time warning.
 */
export function fileStore(io: Io, warn: boolean): SecretStore {
  const path = credentialsPath(io)
  return {
    async get(account) {
      return asSecrets(readCredentials(path).accounts[account])
    },
    async set(account, secrets) {
      const existed = existsSync(path)
      const file = readCredentials(path)
      file.accounts[account] = secrets
      writePrivateJson(path, file)
      if (!existed && warn) {
        io.stderr(
          `Warning: no OS keychain is available, so your sign-in is stored in ${path} (readable only by you).\n`
        )
      }
    },
    async delete(account) {
      if (!existsSync(path)) return
      const file = readCredentials(path)
      delete file.accounts[account]
      if (Object.keys(file.accounts).length === 0) rmSync(path, { force: true })
      else writePrivateJson(path, file)
    },
  }
}

/**
 * The store for this machine. With a keychain, writes go to the keychain and
 * fall back to the file (with the warning) when the keychain refuses; reads
 * and deletes cover both, so a token written during a fallback is still found
 * and still removed.
 */
export function createSecretStore(io: Io): SecretStore {
  const forced = io.env.AMDAHL_CREDENTIAL_STORE
  if (forced && forced !== 'keychain' && forced !== 'file') {
    throw new CliError(
      'usage',
      'AMDAHL_CREDENTIAL_STORE must be `keychain` or `file`.',
      EXIT.usage
    )
  }
  const keychain =
    io.platform === 'darwin'
      ? macKeychain(io.run)
      : io.platform === 'linux'
        ? linuxSecretTool(io.run)
        : null

  if (forced === 'file') return fileStore(io, false)
  if (forced === 'keychain') {
    if (!keychain) {
      throw new CliError('keychain_unavailable', 'No OS keychain on this platform.', EXIT.general)
    }
    return {
      get: keychain.get,
      delete: keychain.delete,
      async set(account, secrets) {
        try {
          await keychain.set(account, secrets)
        } catch {
          throw new CliError('keychain_unavailable', 'Could not write to the OS keychain.', EXIT.general)
        }
      },
    }
  }

  const file = fileStore(io, true)
  if (!keychain) return file
  return {
    async get(account) {
      return (await keychain.get(account)) ?? (await file.get(account))
    },
    async set(account, secrets) {
      try {
        await keychain.set(account, secrets)
        // A keychain that "succeeds" without storing (a locked or missing
        // secret service) is caught by reading the entry back.
        const back = await keychain.get(account)
        if (back?.access_token !== secrets.access_token) throw new Error('keychain read-back failed')
        await file.delete(account)
      } catch {
        await file.set(account, secrets)
      }
    },
    async delete(account) {
      await keychain.delete(account)
      await file.delete(account)
    },
  }
}
