// src/files.ts
//
// Reading a file a person named on the command line (a draft, a list, a
// context file, the text that was sent). A file that is not there is the
// common mistake, so it says "Can't find <file>." and nothing about the
// system call that failed. Any other failure says what it was in one line.

import { readFileSync } from 'node:fs'
import { usageError } from './errors'

/**
 * Read `path` as UTF-8 text.
 *
 * @throws a usage error (exit 2): `Can't find <path>.` for a missing file,
 *   `<path> is a folder, not a file.`, `Can't read <path>: permission denied.`,
 *   or `Can't read <path>: <reason>.`
 */
export function readTextFile(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    const code = (err as { code?: string } | null)?.code
    if (code === 'ENOENT') throw usageError(`Can't find ${path}.`)
    if (code === 'EISDIR') throw usageError(`${path} is a folder, not a file.`)
    if (code === 'EACCES' || code === 'EPERM') throw usageError(`Can't read ${path}: permission denied.`)
    throw usageError(`Can't read ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
