// A tar.gz writer for the tests, built the way amdahl.ai builds a folder
// skill's archive: ustar
// headers, entries sorted by their UTF-8 bytes, an explicit entry for each
// folder, mode 0644 / 0755, two zero blocks at the end, and gzip of STORED
// deflate blocks with a fixed header. `rawTar` writes any entry at all, so a
// test can build each archive the CLI must refuse.

import { deflateRawSync } from 'node:zlib'
import { crc32 } from '../../src/tar-gz'

const BLOCK = 512

/** One tar entry, written as given: no checks, so it can be a bad one. */
export interface RawEntry {
  path: string
  /** The typeflag: '0' file (default), '5' folder, '2' symlink, ... */
  type?: string
  mode?: number
  body?: Buffer | string
  /** The size field, when it should differ from the body. */
  size?: number
  linkname?: string
  /** Called on the finished header, after the checksum. */
  tamper?: (header: Buffer) => void
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

/** The ustar name and prefix for a path, split at a slash the way the site does. */
function splitPath(path: string): { name: Buffer; prefix: Buffer } {
  const bytes = Buffer.from(path, 'utf8')
  if (bytes.length <= 100) return { name: bytes, prefix: Buffer.alloc(0) }
  for (let i = Math.min(155, bytes.length - 2); i > 0; i -= 1) {
    if (bytes[i] === 0x2f && bytes.length - i - 1 <= 100) return { name: bytes.subarray(i + 1), prefix: bytes.subarray(0, i) }
  }
  throw new Error(`path does not fit ustar: ${path}`)
}

function header(e: RawEntry, size: number): Buffer {
  const { name, prefix } = splitPath(e.path)
  const type = e.type ?? '0'
  const h = Buffer.alloc(BLOCK)
  name.copy(h, 0)
  h.write(octal(e.mode ?? (type === '5' ? 0o755 : 0o644), 8), 100, 'ascii')
  h.write(octal(0, 8), 108, 'ascii')
  h.write(octal(0, 8), 116, 'ascii')
  h.write(octal(e.size ?? size, 12), 124, 'ascii')
  h.write(octal(1761170940, 12), 136, 'ascii')
  h.write('        ', 148, 'ascii')
  h.write(type, 156, 'latin1')
  if (e.linkname) h.write(e.linkname, 157, 'utf8')
  h.write('ustar\0', 257, 'ascii')
  h.write('00', 263, 'ascii')
  h.write(octal(0, 8), 329, 'ascii')
  h.write(octal(0, 8), 337, 'ascii')
  prefix.copy(h, 345)
  let sum = 0
  for (const byte of h) sum += byte
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  e.tamper?.(h)
  return h
}

/** The tar bytes for these entries, in this order, ended by two zero blocks unless `end` is false. */
export function rawTar(entries: RawEntry[], end = true): Buffer {
  const parts: Buffer[] = []
  for (const e of entries) {
    const body = Buffer.from(e.body ?? '')
    parts.push(header(e, body.length), body, Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK))
  }
  if (end) parts.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(parts)
}

/** A file for `skillTar`: its bytes, or its bytes and mode. */
export type TarFileSpec = string | Buffer | { body: string | Buffer; mode: number }

/** The site's tar for a folder: sorted entries, an explicit entry for every folder. */
export function skillTar(files: Record<string, TarFileSpec>): Buffer {
  const dirs = new Set<string>()
  for (const path of Object.keys(files)) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i += 1) dirs.add(`${parts.slice(0, i).join('/')}/`)
  }
  const paths = [...Object.keys(files), ...dirs].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  return rawTar(
    paths.map((path) => {
      const spec = files[path]
      if (spec === undefined) return { path, type: '5' }
      return typeof spec === 'object' && !Buffer.isBuffer(spec) ? { path, body: spec.body, mode: spec.mode } : { path, body: spec }
    })
  )
}

/** Raw deflate of STORED blocks: the site's encoding. */
function deflateStored(data: Buffer): Buffer {
  const blocks = Math.max(1, Math.ceil(data.length / 65535))
  const out = Buffer.alloc(data.length + blocks * 5)
  let at = 0
  for (let b = 0; b < blocks; b += 1) {
    const start = b * 65535
    const length = Math.min(65535, data.length - start)
    out[at] = b === blocks - 1 ? 1 : 0
    out.writeUInt16LE(length, at + 1)
    out.writeUInt16LE(~length & 0xffff, at + 3)
    data.copy(out, at + 5, start, start + length)
    at += 5 + length
  }
  return out
}

/**
 * gzip around `data` with the site's fixed header. `compress` uses zlib's
 * deflate instead of stored blocks (a small download that unpacks large).
 */
export function gzip(data: Buffer, compress = false): Buffer {
  const trailer = Buffer.alloc(8)
  trailer.writeUInt32LE(crc32(data), 0)
  trailer.writeUInt32LE(data.length % 2 ** 32, 4)
  const header = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff])
  return Buffer.concat([header, compress ? deflateRawSync(data) : deflateStored(data), trailer])
}

/** skillTar, then gzip: the archive amdahl.ai serves for a folder skill. */
export function skillTarGz(files: Record<string, TarFileSpec>): Buffer {
  return gzip(skillTar(files))
}
