// src/commands/optimize.ts
//
// `amdahl optimize`: rewrite messages through POST /api/platform/v1/messages/optimize.
// Each file (or `-` for stdin) runs on its own, one after another, with no
// retry and a 180 s timeout. A result of `ok: false` (the optimizer was
// unreachable or unconfigured) is not a rewrite: it prints the reason and the
// command exits 1.

import { readFileSync } from 'node:fs'
import { apiClient, resolveCredential, toCliError, str, type Ctx } from '../context'
import { CliError, EXIT, usageError } from '../errors'

/** Per-file request timeout. */
export const OPTIMIZE_TIMEOUT_MS = 180_000

const CHANNELS = ['email', 'linkedin']
const EVIDENCE = ['off', 'workspace']
const ON_UNSUPPORTED = ['flag', 'remove']

/** One file's outcome in `--json` output. */
interface FileResult {
  ok: boolean
  file: string
  result: Record<string, unknown>
}

function oneOf(flag: string, value: string | undefined, allowed: string[]): string | undefined {
  if (value === undefined) return undefined
  if (!allowed.includes(value)) throw usageError(`--${flag} must be one of: ${allowed.join(', ')}.`)
  return value
}

/** Read and check the `--context` file: a JSON object. */
function readContext(path: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw usageError(`Could not read --context ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw usageError('--context must be a JSON object with rules, voice_examples and facts.')
  }
  return parsed as Record<string, unknown>
}

/** Reject after `ms`; the request itself is abandoned. */
function withTimeout<T>(promise: Promise<T>, ms: number, file: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CliError('timeout', `Optimizing ${file} timed out after ${ms / 1000} s.`, EXIT.network)),
      ms
    )
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** `amdahl optimize [<file>... | -]`. */
export async function optimize(ctx: Ctx, args: string[]): Promise<number> {
  const { io, out, flags } = ctx
  let files = args
  if (files.length === 0) {
    if (io.stdinIsTTY) {
      throw usageError(
        'Give a file to optimize, or pipe the message on stdin.',
        'Usage: amdahl optimize <file>... | - [--channel email|linkedin]'
      )
    }
    files = ['-']
  }
  if (files.filter((f) => f === '-').length > 1) throw usageError('Stdin (-) can be read only once.')

  const base: Record<string, unknown> = {}
  const channel = oneOf('channel', str(flags.channel), CHANNELS)
  const evidence = oneOf('evidence', str(flags.evidence), EVIDENCE)
  const onUnsupported = oneOf('on-unsupported', str(flags['on-unsupported']), ON_UNSUPPORTED)
  if (channel) base.channel = channel
  if (evidence) base.evidence = evidence
  if (onUnsupported) base.on_unsupported = onUnsupported
  if (flags.tries === true) base.include_tries = true
  const contextPath = str(flags.context)
  if (contextPath) base.context = readContext(contextPath)

  // Read every input before the first request, so a typo in the third file
  // fails before the first one is spent.
  const inputs: { file: string; message: string }[] = []
  for (const file of files) {
    let message: string
    try {
      message = file === '-' ? await io.readStdin() : readFileSync(file, 'utf8')
    } catch (err) {
      throw usageError(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!message.trim()) throw usageError(`${file === '-' ? 'Stdin' : file} is empty.`)
    inputs.push({ file, message })
  }

  const credential = await resolveCredential(ctx)
  const client = apiClient(ctx, credential)
  const results: FileResult[] = []
  let exit: number = EXIT.ok
  for (const { file, message } of inputs) {
    let result: Record<string, unknown>
    try {
      result = await withTimeout(
        client.request<Record<string, unknown>>('/api/platform/v1/messages/optimize', {
          method: 'POST',
          body: { message, ...base },
        }),
        OPTIMIZE_TIMEOUT_MS,
        file
      )
    } catch (err) {
      throw toCliError(err)
    }
    const ok = result.ok !== false
    results.push({ ok, file, result })
    if (!ok) {
      exit = EXIT.general
      out.info(`${file}: not optimized (${String(result.reason ?? 'unknown')}): ${String(result.detail ?? '')}`)
      continue
    }
    if (!out.json) {
      if (inputs.length > 1) out.info(`== ${file} ==`)
      if (result.unchanged === true) out.info('No rewrite beat your draft; it is returned unchanged.')
      else if (typeof result.summary === 'string') out.info(result.summary)
      out.result({}, String(result.message ?? ''))
    }
  }
  if (out.json) out.result(results.length === 1 ? (results[0] as unknown as Record<string, unknown>) : (results as unknown as Record<string, unknown>[]))
  return exit
}
