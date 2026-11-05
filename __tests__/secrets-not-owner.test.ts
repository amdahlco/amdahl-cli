// A credentials.json other users can read that this user cannot chmod (one
// `sudo npx amdahl` left behind, say): every command still reads the sign-in
// and warns, instead of failing on the chmod. `node:fs` is mocked so that
// chmod fails for that one file, as it does for a file someone else owns.

import * as fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createSecretStore, credentialsPath } from '../src/secrets'
import { fakeIo } from './helpers/fake-io'

const notOwned = new Set<string>()
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    chmodSync: (path: fs.PathLike, mode: fs.Mode) => {
      if (notOwned.has(String(path))) throw Object.assign(new Error(`EPERM: operation not permitted, chmod '${String(path)}'`), { code: 'EPERM' })
      return real.chmodSync(path, mode)
    },
  }
})

const SECRETS = { access_token: 'at', refresh_token: 'rt', access_expires_at: '2099-01-01T00:00:00.000Z' }

describe('a loose credentials file this user cannot chmod', () => {
  it('is still read, with a warning that says what to run', async () => {
    const io = fakeIo({ AMDAHL_CREDENTIAL_STORE: 'file' })
    await createSecretStore(io).set('h/a', SECRETS)
    const path = credentialsPath(io)
    fs.chmodSync(path, 0o644)
    notOwned.add(path)
    expect(await createSecretStore(io).get('h/a')).toEqual(SECRETS)
    expect(io.err.join('')).toBe(
      `Warning: ${path} can be read by other users on this machine, and this CLI cannot change that. Run \`chmod 600 ${path}\` as its owner.\n`
    )
    notOwned.delete(path)
  })
})
