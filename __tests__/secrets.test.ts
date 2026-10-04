// The keychain adapters never put the secret on argv (spy on every spawn),
// and the file fallback is owner-only with a one-time warning.

import { statSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '../src/io'
import {
  createSecretStore,
  credentialsPath,
  linuxSecretTool,
  macKeychain,
  type Secrets,
} from '../src/secrets'
import { fakeIo } from './helpers/fake-io'

const SECRETS: Secrets = {
  access_token: 'at_SUPERSECRET_access',
  refresh_token: 'rt_SUPERSECRET_refresh',
  access_expires_at: '2030-01-01T00:00:00.000Z',
}

/** A keychain that remembers what it was fed on stdin. */
function fakeKeychain() {
  let stored = ''
  const run = vi.fn(async (cmd: string, args: string[], opts?: { input?: string }): Promise<ProcessResult> => {
    if (args.includes('-i') || args[0] === 'store') {
      const input = opts?.input ?? ''
      stored = args[0] === 'store' ? input : (input.match(/-w (\S+)/)?.[1] ?? '')
      return { code: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'find-generic-password' || args[0] === 'lookup') {
      return stored ? { code: 0, stdout: `${stored}\n`, stderr: '' } : { code: 44, stdout: '', stderr: '' }
    }
    stored = ''
    return { code: 0, stdout: '', stderr: '' }
  })
  return run
}

function assertNoSecretOnArgv(run: ReturnType<typeof vi.fn>) {
  for (const call of run.mock.calls) {
    const argv = JSON.stringify([call[0], call[1]])
    expect(argv).not.toContain('SUPERSECRET')
    expect(argv).not.toContain(Buffer.from(JSON.stringify(SECRETS)).toString('base64'))
  }
}

describe('keychain adapters', () => {
  it('macOS: `security -i` gets the whole command on stdin, never argv', async () => {
    const run = fakeKeychain()
    const store = macKeychain(run)
    await store.set('app.amdahl.ai/acme', SECRETS)
    expect(await store.get('app.amdahl.ai/acme')).toEqual(SECRETS)
    await store.delete('app.amdahl.ai/acme')
    const setCall = run.mock.calls[0]
    expect(setCall?.[0]).toBe('security')
    expect(setCall?.[1]).toEqual(['-i'])
    expect(String(setCall?.[2]?.input)).toContain('add-generic-password -U -s "amdahl-cli" -a "app.amdahl.ai/acme" -w ')
    assertNoSecretOnArgv(run)
  })

  it('Linux: `secret-tool store` reads the secret from stdin', async () => {
    const run = fakeKeychain()
    const store = linuxSecretTool(run)
    await store.set('app.amdahl.ai/acme', SECRETS)
    expect(await store.get('app.amdahl.ai/acme')).toEqual(SECRETS)
    expect(run.mock.calls[0]?.[1]).toEqual([
      'store', '--label', 'Amdahl CLI (app.amdahl.ai/acme)', 'service', 'amdahl-cli', 'account', 'app.amdahl.ai/acme',
    ])
    assertNoSecretOnArgv(run)
  })

  it('the auto store uses the keychain when it works, with no file', async () => {
    const io = fakeIo({ AMDAHL_CREDENTIAL_STORE: undefined })
    io.platform = 'darwin'
    const run = fakeKeychain()
    io.run = run as typeof io.run
    const store = createSecretStore(io)
    await store.set('h/p', SECRETS)
    expect(await store.get('h/p')).toEqual(SECRETS)
    expect(() => statSync(credentialsPath(io))).toThrow()
    expect(io.err.join('')).toBe('')
    assertNoSecretOnArgv(run)
  })
})

describe('stored entries with a bad expiry read as signed out', () => {
  // A token with no usable expiry used to come back as valid secrets, so the
  // CLI could neither refresh it on time nor ask for a new sign-in.
  const BAD_EXPIRIES: unknown[] = [undefined, 1893456000000, 'not a date', '']

  it('keychain: decode refuses an entry whose access_expires_at is missing, not a string or not a date', async () => {
    for (const access_expires_at of BAD_EXPIRIES) {
      const store = macKeychain(fakeKeychain())
      await store.set('h/p', { ...SECRETS, access_expires_at } as unknown as Secrets)
      expect(await store.get('h/p')).toBeNull()
    }
  })

  it('file: the same entries read as missing', async () => {
    for (const access_expires_at of BAD_EXPIRIES) {
      const store = createSecretStore(fakeIo({ AMDAHL_CREDENTIAL_STORE: 'file' }))
      await store.set('h/p', { ...SECRETS, access_expires_at } as unknown as Secrets)
      expect(await store.get('h/p')).toBeNull()
    }
  })

  it('keeps an entry with a valid ISO expiry (nearest miss)', async () => {
    const store = macKeychain(fakeKeychain())
    await store.set('h/p', SECRETS)
    expect(await store.get('h/p')).toEqual(SECRETS)
  })
})

describe('file fallback', () => {
  it('falls back to an owner-only file with a one-time warning', async () => {
    const io = fakeIo({ AMDAHL_CREDENTIAL_STORE: undefined })
    io.platform = 'linux' // the default fake run fails like a missing secret-tool
    const store = createSecretStore(io)
    await store.set('h/a', SECRETS)
    await store.set('h/b', SECRETS)
    expect(statSync(credentialsPath(io)).mode & 0o777).toBe(0o600)
    const warnings = io.err.join('').match(/Warning: no OS keychain/g) ?? []
    expect(warnings).toHaveLength(1)
    expect(await store.get('h/a')).toEqual(SECRETS)
    await store.delete('h/a')
    expect(await store.get('h/a')).toBeNull()
  })

  it('AMDAHL_CREDENTIAL_STORE=file skips the keychain and the warning', async () => {
    const io = fakeIo({ AMDAHL_CREDENTIAL_STORE: 'file' })
    io.platform = 'darwin'
    await createSecretStore(io).set('h/a', SECRETS)
    expect(io.run).not.toHaveBeenCalled()
    expect(io.err.join('')).toBe('')
  })

  it('rejects an unknown AMDAHL_CREDENTIAL_STORE', () => {
    const io = fakeIo({ AMDAHL_CREDENTIAL_STORE: 'vault' })
    expect(() => createSecretStore(io)).toThrow(/keychain` or `file/)
  })
})
