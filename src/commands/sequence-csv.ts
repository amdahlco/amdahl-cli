// src/commands/sequence-csv.ts
//
// The file `amdahl sequence --csv` writes and `--from` reads back: where it
// goes, the checks made before anything is sent, and the write after the run.
// The CSV is the one place an email's text reaches disk, and only because the
// person asked for it (`--csv`) or said yes to "Save as ...?".

import { accessSync, constants, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { Ctx } from '../context'
import { str } from '../context'
import { usageError } from '../errors'
import { ownCsvEmails, sequenceCsv, sequenceFileName, type FinalEmail } from '../sequence-parse'
import { csvDelimiter, parseCsv } from './batch'

const USAGE = 'Usage: amdahl sequence <file> | -   or   amdahl sequence --write "<goal>"'

/** The path the CSV goes to when no name is given: next to the file, else here. */
export function defaultTarget(ctx: Ctx, file: string | null): string {
  return file && file !== '-' ? join(dirname(file), sequenceFileName(basename(file))) : join(ctx.io.cwd, sequenceFileName(null))
}

/** Where `--csv` writes: the path given, else next to the file, else here. Null without `--csv`. */
export function csvTarget(ctx: Ctx, file: string | null): string | null {
  const flag = ctx.flags.csv
  if (typeof flag !== 'string') return null
  return flag || defaultTarget(ctx, file)
}

/** True when two paths name the same file: the same resolved path, or the same file on disk (a link, or a different case). */
function sameFile(cwd: string, a: string, b: string): boolean {
  if (resolve(cwd, a) === resolve(cwd, b)) return true
  try {
    const x = statSync(resolve(cwd, a))
    const y = statSync(resolve(cwd, b))
    return x.ino !== 0 && x.ino === y.ino && x.dev === y.dev
  } catch {
    return false
  }
}

/**
 * Refuse a `--csv` that would replace one of the files the run reads, that has
 * no emails to go with it, or that is not a .csv name. A bare `--csv` followed
 * by another word (`--csv out.txt`) reaches here as a second argument.
 */
export function checkCsvTarget(ctx: Ctx, args: string[], writing: boolean): void {
  const flag = ctx.flags.csv
  if (typeof flag !== 'string') return
  if (flag === '' && args.length > 1 && !/\.csv$/i.test(args[1] ?? '')) throw usageError('--csv takes a name ending in .csv.', `Got ${args[1]}. Put --csv after the file, with a name like emails.csv.`)
  if (flag && !/\.csv$/i.test(flag)) throw usageError('--csv takes a name ending in .csv.', `Got ${flag}.`)
  if (!flag) return
  const file = args[0]
  if (file === undefined && !writing) throw usageError(`--csv ${flag} says where to save, but there are no emails to improve.`, USAGE)
  const inputs = [file, str(ctx.flags.plan), str(ctx.flags.context)]
  const clash = inputs.find((p) => p && p !== '-' && sameFile(ctx.io.cwd, flag, p))
  if (clash) throw usageError(`--csv would replace your input file ${clash}. Name another file, or leave the name out.`)
}

/**
 * Refuse, before anything is sent, a file that exists (unless `--force`), a
 * folder that is not there and a folder that cannot be written to. With
 * `replace`, a file that is there is the one `--from` continues.
 */
export function assertFree(ctx: Ctx, path: string, force: boolean, replace = false): void {
  const folder = dirname(resolve(ctx.io.cwd, path))
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw usageError(`The folder ${folder} does not exist, so ${path} cannot be saved there.`, 'Create the folder, or name a file in one that is there.')
  try {
    accessSync(folder, constants.W_OK)
  } catch {
    throw usageError(`The folder ${folder} cannot be written to, so ${path} cannot be saved there.`)
  }
  if (!force && !replace && existsSync(path)) throw usageError(`${path} already exists.`, 'Move it, or add --force to replace it.')
}

/** Why a save failed, in words. */
function reason(err: unknown): string {
  const code = (err as { code?: string } | null)?.code
  if (code === 'EEXIST') return 'it already exists (add --force to replace it)'
  if (code === 'ENOENT') return 'the folder is not there'
  if (code === 'EACCES' || code === 'EPERM') return 'it cannot be written to'
  return err instanceof Error ? err.message : String(err)
}

/**
 * Write the emails as a CSV, with a UTF-8 byte order mark so a spreadsheet reads
 * accents right. A file that appeared since the check is not replaced without
 * `force`. Returns null when saved, else the sentence that says why not: the
 * emails are already on screen, so a failed save never loses them.
 */
export function saveCsv(path: string, finals: FinalEmail[], force: boolean): string | null {
  try {
    writeFileSync(path, `\uFEFF${sequenceCsv(finals)}`, { flag: force ? 'w' : 'wx' })
    return null
  } catch (err) {
    return `Could not save ${path}: ${reason(err)}.`
  }
}

/** The emails an earlier run saved, for `--from`: the sentence that says why not, or the emails. */
export function readSaved(ctx: Ctx, path: string, needed: number): { error: string } | { finals: FinalEmail[] } {
  const full = resolve(ctx.io.cwd, path)
  if (!existsSync(full)) return { error: `--from needs ${path}, the CSV an earlier run saved with --csv. It is not there.` }
  const emails = ownCsvEmails(parseCsv(readFileSync(full, 'utf8'), csvDelimiter(readFileSync(full, 'utf8'))).rows)
  if (!emails) return { error: `${path} is not a CSV this command saved (Email, Subject, Message).` }
  if (emails.length < needed) return { error: `${path} has ${emails.length === 1 ? '1 email' : `${emails.length} emails`}, and --from needs the ${needed} before it.` }
  return { finals: emails.slice(0, needed) }
}
