// src/files.ts
//
// Reading a file a person named on the command line (a draft, a list, a
// context file, the text that was sent). A file that is not there is the
// common mistake, so it says "Can't find <file>." and nothing about the
// system call that failed. Any other failure says what it was in one line.

import { readFileSync } from 'node:fs'
import { usageError } from './errors'

/**
 * `bytes` as text: UTF-8 (a BOM is kept for the caller to drop), or UTF-16 when
 * the file starts with its BOM (Excel's "Unicode Text"). Null when the bytes
 * are not valid UTF-8: most often Excel's plain "CSV", saved as Windows-1252.
 */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return null
  }
}

/**
 * Read `path` as text: UTF-8, or UTF-16 with a BOM. A file that is neither is
 * refused before anything is sent, since its accented letters would reach
 * Amdahl as "�" and be paid for as written.
 *
 * @throws a usage error (exit 2): `Can't find <path>.` for a missing file,
 *   `<path> is a folder, not a file.`, `Can't read <path>: permission denied.`,
 *   `<path> isn't UTF-8 text…`, or `Can't read <path>: <reason>.`
 */
export function readTextFile(path: string): string {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch (err) {
    const code = (err as { code?: string } | null)?.code
    if (code === 'ENOENT') throw usageError(`Can't find ${path}.`)
    if (code === 'EISDIR') throw usageError(`${path} is a folder, not a file.`)
    if (code === 'EACCES' || code === 'EPERM') throw usageError(`Can't read ${path}: permission denied.`)
    throw usageError(`Can't read ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const text = decodeText(bytes)
  if (text === null) {
    throw usageError(
      `${path} isn't UTF-8 text, so names like José or Zoë would arrive garbled. Nothing was sent.`,
      'Save it as UTF-8 (in Excel: File > Save As > "CSV UTF-8"), then run the same command again.'
    )
  }
  return text
}
