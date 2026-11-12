// src/commands/feedback.ts
//
// What happened to a message after `amdahl optimize` returned it.
//
// `amdahl feedback <run-id>` posts to POST /messages/optimize/runs/:id/feedback:
// the text actually sent (`--sent-text <file>`, `-` for stdin), the sender's
// words about it (`--comment`), what happened to it (`--outcome`) and how the
// caller knows (`--evidence`, required). Amdahl learns the sender's preferences
// from an edit, unless the evidence is `inferred`. Each call stores one event,
// so running it twice stores two.
//
// `amdahl sent <run-id>...` posts to POST /messages/report_send: the system
// that sent a message says it went out. The flags are the schema's fields; a
// report from a CLI sign-in is stored as `reported_via: cli`. Several run ids
// report the same send details for each; the fields that name one send
// (`--provider-send-id`, `--recipient` and the like) take one run id.

import { readFileSync } from 'node:fs'
import { amdahlCommand } from '../command-name'
import { apiClient, call, resolveCredential, str, type Ctx } from '../context'
import { EXIT, usageError } from '../errors'
import { count, field, records } from '../text'

const PLATFORM = '/api/platform/v1'

export const FEEDBACK_OUTCOMES = ['used', 'used_with_edits', 'not_used', 'unsure']
export const FEEDBACK_EVIDENCE = ['did_it_myself', 'reported_to_me', 'inferred']
export const SEND_PROVIDERS = ['lemlist', 'instantly', 'outreach', 'salesloft', 'hubspot', 'salesforce', 'gmail', 'heyreach', 'apollo', 'linkedin_manual', 'other']
export const SEND_CHANNELS = ['email', 'linkedin_invite', 'linkedin_message', 'linkedin_inmail']
export const SENT_AS = ['returned', 'edited']

/** The most sends one report may carry (the server's own limit). */
export const MAX_SEND_REPORTS = 100

function oneOf(flag: string, value: string | undefined, allowed: string[]): string | undefined {
  if (value === undefined) return undefined
  if (!allowed.includes(value)) throw usageError(`--${flag} must be one of: ${allowed.join(', ')}.`)
  return value
}

/** `--sent-text <file>` or `-` for stdin, read whole. */
async function readText(ctx: Ctx, path: string): Promise<string> {
  try {
    return path === '-' ? await ctx.io.readStdin() : readFileSync(path, 'utf8')
  } catch (err) {
    throw usageError(`Could not read --sent-text ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** `amdahl feedback <run-id> --evidence <how> [--sent-text <file>] [--comment <text>] [--outcome <what>]`. */
export async function feedback(ctx: Ctx, args: string[]): Promise<number> {
  const usage = `Usage: ${amdahlCommand('feedback <run-id> --evidence did_it_myself [--outcome used] [--sent-text <file>] [--comment <text>]')}`
  const [runId, ...rest] = args
  if (!runId || rest.length > 0) throw usageError('Give one run id: the one `amdahl optimize` printed.', usage)
  const evidence = oneOf('evidence', str(ctx.flags.evidence), FEEDBACK_EVIDENCE)
  if (!evidence) throw usageError(`Say how you know with --evidence: ${FEEDBACK_EVIDENCE.join(', ')}.`, usage)
  const outcome = oneOf('outcome', str(ctx.flags.outcome), FEEDBACK_OUTCOMES)
  const comment = str(ctx.flags.comment)
  const sentPath = str(ctx.flags['sent-text'])
  const sentText = sentPath ? await readText(ctx, sentPath) : undefined
  if (!sentText?.trim() && !comment?.trim() && !outcome) {
    throw usageError('Send at least one of --sent-text, --comment or --outcome.', usage)
  }
  const body: Record<string, unknown> = { evidence }
  if (sentText?.trim()) body.sent_text = sentText
  if (comment?.trim()) body.comment = comment
  if (outcome) body.outcome = outcome

  const credential = await resolveCredential(ctx)
  const result = await call(() =>
    apiClient(ctx, credential).request<Record<string, unknown>>(`${PLATFORM}/messages/optimize/runs/${encodeURIComponent(runId)}/feedback`, {
      method: 'POST',
      body,
    })
  )
  const learns = body.sent_text !== undefined && evidence !== 'inferred' ? ' Amdahl learns your preferences from the edit.' : ''
  ctx.out.result({ ...result, ok: true }, `Feedback saved for run ${field(result.run_id) || runId}.${learns}`)
  return EXIT.ok
}

/** The `sent` flags that name one send, by their field. */
const ONE_SEND: Record<string, string> = {
  'provider-send-id': 'provider_send_id',
  'provider-lead-id': 'provider_lead_id',
  'thread-id': 'thread_id',
  recipient: 'recipient',
  'recipient-key-hash': 'recipient_key_hash',
  'sent-text': 'sent_text',
}

/** The `sent` flags shared by every run id, by their field. */
const SHARED: Record<string, string> = {
  'provider-campaign-id': 'provider_campaign_id',
  'provider-variant-id': 'provider_variant_id',
}

/** `amdahl sent <run-id>... --provider <p> --channel <c> --sent-as returned|edited [--sent-at <time>] ...`. */
export async function sent(ctx: Ctx, args: string[]): Promise<number> {
  const { flags } = ctx
  const usage = `Usage: ${amdahlCommand('sent <run-id>... --provider <provider> --channel <channel> --sent-as returned|edited')}`
  if (args.length === 0) throw usageError('Give the run id of each message that was sent.', usage)
  if (args.length > MAX_SEND_REPORTS) throw usageError(`Report at most ${MAX_SEND_REPORTS} sends at a time.`)
  const provider = oneOf('provider', str(flags.provider), SEND_PROVIDERS)
  const channel = oneOf('channel', str(flags.channel), SEND_CHANNELS)
  const sentAs = oneOf('sent-as', str(flags['sent-as']), SENT_AS)
  if (!provider) throw usageError(`Say where it went out with --provider: ${SEND_PROVIDERS.join(', ')}.`, usage)
  if (!channel) throw usageError(`Say what was sent with --channel: ${SEND_CHANNELS.join(', ')}.`, usage)
  if (!sentAs) throw usageError('Say whether it was sent as Amdahl returned it with --sent-as: returned, edited.', usage)
  const sentAt = str(flags['sent-at']) ?? new Date(ctx.io.now()).toISOString()
  if (!Number.isFinite(Date.parse(sentAt)) || !/(Z|[+-]\d\d:?\d\d)$/i.test(sentAt)) {
    throw usageError('--sent-at must be a time with a time zone, for example 2026-11-12T09:30:00Z.')
  }

  const base: Record<string, unknown> = { provider, channel, sent_as: sentAs, sent_at: sentAt }
  for (const [flag, key] of Object.entries(SHARED)) {
    const value = str(flags[flag])
    if (value !== undefined) base[key] = value
  }
  const step = str(flags['sequence-step'])
  if (step !== undefined) {
    const n = Number(step)
    if (!Number.isInteger(n) || n < 0 || n > 1000) throw usageError('--sequence-step must be a whole number from 0 to 1000.')
    base.sequence_step = n
  }
  for (const [flag, key] of Object.entries(ONE_SEND)) {
    const value = str(flags[flag])
    if (value === undefined) continue
    if (args.length > 1) throw usageError(`--${flag} names one send, so give one run id with it.`)
    base[key] = key === 'sent_text' ? await readText(ctx, value) : value
  }
  const items = args.map((run_id) => ({ run_id, ...base }))

  const credential = await resolveCredential(ctx)
  const result = await call(() =>
    apiClient(ctx, credential).request<Record<string, unknown>>(`${PLATFORM}/messages/report_send`, { method: 'POST', body: { items } })
  )
  const outcomes = records(result.items)
  const rejected = outcomes.filter((i) => i.status === 'rejected')
  const accepted = typeof result.accepted === 'number' ? result.accepted : outcomes.length - rejected.length
  const lines = [accepted > 0 ? `Reported ${count(accepted, 'send')}.` : 'Nothing was reported.']
  for (const r of rejected) {
    lines.push(`Not stored: ${field(r.run_id)}: ${field(r.message) || field(r.reason) || 'rejected'}`)
  }
  ctx.out.result({ ...result, ok: rejected.length === 0 }, lines.join('\n'))
  return rejected.length === 0 ? EXIT.ok : EXIT.general
}
