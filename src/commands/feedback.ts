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
// `amdahl sent <run-id>` posts to POST /messages/report_send: the system that
// sent a message says it went out. The flags are the schema's fields; a report
// from a CLI sign-in is stored as `reported_via: cli`. The server stores a
// report only when it can tell which send it is, so it needs at least one of
// `--provider-send-id` and a recipient (`--recipient` or `--recipient-key-hash`,
// never both): a send id with a recipient is fine (`missing_send_key`
// otherwise), and the CLI says so before it sends anything. It reports one
// send per command; the API takes up to 100 at once.
//
// Every value is checked here against the server's own limits first, so a
// mistake is a usage error (exit 2) that names the flag, not a refusal.

import { amdahlCommand } from '../command-name'
import { apiClient, call, resolveCredential, str, type Ctx } from '../context'
import { EXIT, usageError } from '../errors'
import { readTextFile } from '../files'
import { findRun } from '../history'
import { SEND_TO_PRESETS } from '../send-to'
import { atTerminal, canAsk } from '../terminal'
import { clip, field, records } from '../text'

const PLATFORM = '/api/platform/v1'

export const FEEDBACK_OUTCOMES = ['used', 'used_with_edits', 'not_used', 'unsure']
export const FEEDBACK_EVIDENCE = ['did_it_myself', 'reported_to_me', 'inferred']
/**
 * The `provider` values `messages.report_send` accepts, in the server's order: `SEND_PROVIDERS` in
 * amdahl-app `src/shared/providers/registry.generated.ts`. A provider added there belongs here too.
 */
export const SEND_PROVIDERS = ['lemlist', 'instantly', 'outreach', 'salesloft', 'hubspot', 'salesforce', 'gmail', 'heyreach', 'apollo', 'smartlead', 'reply_io', 'lgm', 'woodpecker', 'linkedin_manual', 'other']
export const SEND_CHANNELS = ['email', 'linkedin_invite', 'linkedin_message', 'linkedin_inmail']
/**
 * `amdahl optimize --channel` says `linkedin`; the server's report names the kind of LinkedIn
 * message. `sent --channel linkedin` is the message, `linkedin_message`, so one word works in both.
 */
export const CHANNEL_ALIASES: Record<string, string> = { linkedin: 'linkedin_message' }

/** What a sent message was: an email, or a LinkedIn message of any kind. */
type Kind = 'email' | 'linkedin'
const kindOf = (channel: string): Kind => (channel === 'email' ? 'email' : 'linkedin')

/**
 * Each provider's name for a person (the menu shows these, not the ids the server takes) and the kinds
 * of message it sends, from the same table the console's import files use. A provider with no entry
 * here (`salesforce`) takes anything; `other` takes both.
 */
const PROVIDER_NAMES: Record<string, string> = {
  ...Object.fromEntries(SEND_TO_PRESETS.map((p) => [p.id, p.label])),
  salesforce: 'Salesforce',
  gmail: 'Gmail',
  linkedin_manual: 'LinkedIn (sent by hand)',
  other: 'Other (any sender not listed)',
}
const PROVIDER_KINDS: Record<string, readonly Kind[]> = {
  ...Object.fromEntries(SEND_TO_PRESETS.map((p) => [p.id, p.channels])),
  gmail: ['email'],
  linkedin_manual: ['linkedin'],
}

/** Refuse a tool and a channel that can't go together: `instantly` sends email only. */
function checkPair(provider: string, channel: string): void {
  const takes = PROVIDER_KINDS[provider]
  if (!takes || takes.includes(kindOf(channel))) return
  const only = takes.length === 1 ? (takes[0] === 'email' ? 'email' : 'LinkedIn') : ''
  throw usageError(
    `${PROVIDER_NAMES[provider] ?? provider} sends ${only} only, and this is ${kindOf(channel) === 'email' ? 'an email' : 'a LinkedIn message'}.`,
    `Check --provider and --channel (or the recipient). A sender that sends both: --provider other.`
  )
}
export const SENT_AS = ['returned', 'edited']

/** The longest message (`--sent-text`) and comment the server takes, in characters. */
const MAX_MESSAGE_CHARS = 10_000
const MAX_COMMENT_CHARS = 2_000

/** A run id is a UUID. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A time with a time zone, as the server reads it: `2026-11-12T09:30:00Z`, an
 * offset, optional fraction. Case matters: the server refuses a lowercase `t`
 * or `z`, so this does too (no `i` flag).
 */
const TIME_WITH_ZONE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d(:?\d\d)?)$/

// What the server refuses in a provider's own id: an email address or a LinkedIn profile.
const EMAIL_WHOLE_VALUE = /^(?:mailto:)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/i
const LINKEDIN_PROFILE = /linkedin\.com\/(?:in|pub|sales\/(?:lead|people))\//i
const BRACKETED_MESSAGE_ID = /^<[^<>\s]+>$/

function oneOf(flag: string, value: string | undefined, allowed: string[]): string | undefined {
  if (value === undefined) return undefined
  if (!allowed.includes(value)) throw usageError(`--${flag} must be one of: ${allowed.join(', ')}.`)
  return value
}

/** The run id the command was given, which must be one `amdahl optimize` printed. */
export function runId(value: string, usage: string): string {
  // A prompt run (`opt_...`) has no message that was sent: say so, rather than "not a run id".
  if (/^opt_[0-9a-f]+$/i.test(value)) {
    throw usageError(`${value.length > 40 ? `${value.slice(0, 37)}...` : value} is a prompt run: a prompt run can't be reported as sent or given feedback.`, `Use the id of a message run, the one \`amdahl optimize\` prints. ${usage}`)
  }
  if (!UUID.test(value)) throw usageError(`"${value.length > 40 ? `${value.slice(0, 37)}...` : value}" is not a run id.`, `A run id looks like 9fd4f2e3-bc8e-436b-86d7-a677a89e8d16; \`amdahl optimize\` prints it after each run. ${usage}`)
  return value
}

/**
 * A flag's text, at most `max` characters, with no NUL character. Characters
 * are counted with `.length` (UTF-16 units), as the server counts them, so an
 * emoji is two: a text the server would refuse is refused here too.
 */
function text(flag: string, value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined
  if (value.length > max) throw usageError(`--${flag} is at most ${max} characters.`)
  if (value.includes('\u0000')) throw usageError(`--${flag} must not contain a NUL character.`)
  return value
}

/** `--sent-text <file>` or `-` for stdin, read whole. */
async function readText(ctx: Ctx, path: string): Promise<string> {
  return path === '-' ? await ctx.io.readStdin() : readTextFile(path)
}

/**
 * Whether a missing value is asked at the terminal instead of refused: a person is at a terminal (stdin
 * and stdout both) and is not reading `--json`. An agent, CI, a pipe on either side (`amdahl sent <id> |
 * tee`) and AMDAHL_NO_PROMPT=1 get the usage error as before.
 */
export function askingAllowed(ctx: Ctx): boolean {
  return canAsk(ctx)
}

/** `amdahl feedback <run-id> --evidence <how> [--sent-text <file>] [--comment <text>] [--outcome <what>]`. */
export async function feedback(ctx: Ctx, args: string[]): Promise<number> {
  const usage = `Usage: ${amdahlCommand('feedback <run-id> --evidence did_it_myself [--outcome used] [--sent-text <file>] [--comment <text>]')}`
  const [rawId, ...rest] = args
  if (!rawId || rest.length > 0) throw usageError('Give one run id: the one `amdahl optimize` printed.', usage)
  const id = runId(rawId, usage)
  const asking = askingAllowed(ctx)
  let evidence = oneOf('evidence', str(ctx.flags.evidence), FEEDBACK_EVIDENCE)
  if (!evidence && !asking) throw usageError(`Say how you know with --evidence: ${FEEDBACK_EVIDENCE.join(', ')}.`, usage)
  let outcome = oneOf('outcome', str(ctx.flags.outcome), FEEDBACK_OUTCOMES)
  const comment = text('comment', str(ctx.flags.comment), MAX_COMMENT_CHARS)
  const sentPath = str(ctx.flags['sent-text'])
  const sentText = sentPath ? text('sent-text', await readText(ctx, sentPath), MAX_MESSAGE_CHARS) : undefined
  // At a terminal, what is missing is asked: how the person knows, then what happened. Two questions at most.
  if (!evidence) {
    evidence = FEEDBACK_EVIDENCE[await ctx.io.select('How do you know what happened to it?', ['I did it myself', 'Someone told me', 'I am guessing from what I can see'])]
  }
  if (asking && !sentText?.trim() && !comment?.trim() && !outcome) {
    outcome = FEEDBACK_OUTCOMES[await ctx.io.select('What happened to it?', ['Used as Amdahl returned it', 'Used, with my edits', 'Not used', 'Not sure yet'])]
  }
  if (!evidence) throw usageError(`Say how you know with --evidence: ${FEEDBACK_EVIDENCE.join(', ')}.`, usage)
  if (!sentText?.trim() && !comment?.trim() && !outcome) {
    throw usageError('Send at least one of --sent-text, --comment or --outcome.', usage)
  }
  const body: Record<string, unknown> = { evidence }
  if (sentText?.trim()) body.sent_text = sentText
  if (comment?.trim()) body.comment = comment
  if (outcome) body.outcome = outcome

  const credential = await resolveCredential(ctx)
  const result = await call(() =>
    apiClient(ctx, credential).request<Record<string, unknown>>(`${PLATFORM}/messages/optimize/runs/${encodeURIComponent(id)}/feedback`, {
      method: 'POST',
      body,
    })
  )
  const learns = body.sent_text !== undefined && evidence !== 'inferred' ? ' Amdahl learns your preferences from the edit.' : ''
  ctx.out.result({ ...result, ok: true }, `Feedback saved for run ${field(result.run_id) || id}.${learns}`)
  return EXIT.ok
}

/** Flags that hold a provider's own id, by their field, with the most characters each may have. */
const PROVIDER_IDS: Record<string, [string, number]> = {
  'provider-send-id': ['provider_send_id', 256],
  'provider-campaign-id': ['provider_campaign_id', 256],
  'provider-variant-id': ['provider_variant_id', 256],
  'provider-lead-id': ['provider_lead_id', 256],
  'thread-id': ['thread_id', 512],
}

/**
 * `amdahl sent <run-id> --provider <p> --channel <c> --sent-as returned|edited
 * (--provider-send-id <id> | --recipient <email|url> | --recipient-key-hash <sha256>)
 * [--sent-at <time>] ...`.
 */
async function buildItem(ctx: Ctx, args: string[], pasted?: string): Promise<Record<string, unknown>> {
  const { flags } = ctx
  const usage = `Usage: ${amdahlCommand('sent <run-id> --provider <provider> --channel <channel> --sent-as returned|edited --provider-send-id <id>')}`
  const [rawId, ...rest] = args
  if (!rawId) throw usageError('Give the run id of the message that was sent.', usage)
  if (rest.length > 0 && rest.every((r) => r.toLowerCase() === rawId.toLowerCase())) {
    throw usageError(`${rawId} is there twice.`, 'Give each run id once. The command reports one send.')
  }
  if (rest.length > 0) {
    throw usageError('Report one send at a time: give one run id.', 'Each send needs its own --provider-send-id or --recipient, so run it once for each. The API takes up to 100 at once (POST /messages/report_send).')
  }
  const id = runId(rawId, usage)
  const rawProvider = str(flags.provider)
  if (rawProvider !== undefined && !SEND_PROVIDERS.includes(rawProvider)) {
    throw usageError(`--provider must be one of: ${SEND_PROVIDERS.join(', ')}.`, `"${clip(rawProvider, 40)}" is not on the list. For a sender that is not, use --provider other.`)
  }
  const provider = rawProvider
  const rawChannel = str(flags.channel)
  const channel = rawChannel === undefined ? undefined : (CHANNEL_ALIASES[rawChannel] ?? oneOf('channel', rawChannel, [...SEND_CHANNELS, ...Object.keys(CHANNEL_ALIASES)]))
  const sentAs = oneOf('sent-as', str(flags['sent-as']), SENT_AS)
  if (!provider) throw usageError(`Say where it went out with --provider: ${SEND_PROVIDERS.join(', ')}.`, usage)
  if (!channel) throw usageError(`Say what was sent with --channel: ${[...SEND_CHANNELS, ...Object.keys(CHANNEL_ALIASES)].join(', ')}.`, usage)
  if (!sentAs) throw usageError('Say whether it was sent as Amdahl returned it with --sent-as: returned, edited.', usage)
  checkPair(provider, channel)
  const sentAt = str(flags['sent-at']) ?? new Date(ctx.io.now()).toISOString()
  if (!TIME_WITH_ZONE.test(sentAt) || !Number.isFinite(Date.parse(sentAt))) {
    throw usageError('--sent-at must be a time with a time zone, for example 2026-11-12T09:30:00Z.')
  }

  const item: Record<string, unknown> = { run_id: id, provider, channel, sent_as: sentAs, sent_at: sentAt }
  for (const [flag, [key, max]] of Object.entries(PROVIDER_IDS)) {
    const value = text(flag, str(flags[flag]), max)
    if (value === undefined) continue
    if (EMAIL_WHOLE_VALUE.test(value.trim()) || LINKEDIN_PROFILE.test(value.trim())) {
      throw usageError(`--${flag} is the provider's own id, not an email address or a LinkedIn profile URL.`, 'Amdahl stores a person only as a hash: give the address with --recipient.')
    }
    item[key] = value
  }
  const sendId = typeof item.provider_send_id === 'string' ? item.provider_send_id : undefined
  if (provider === 'gmail' && sendId !== undefined && !BRACKETED_MESSAGE_ID.test(sendId.trim())) {
    throw usageError('For gmail, --provider-send-id is the Message-ID header with its angle brackets, such as <abc@mail.gmail.com>.')
  }
  const step = str(flags['sequence-step'])
  if (step !== undefined) {
    const n = Number(step)
    if (!Number.isInteger(n) || n < 0 || n > 1000) throw usageError('--sequence-step must be a whole number from 0 to 1000.')
    item.sequence_step = n
  }
  const recipient = text('recipient', str(flags.recipient), 512)
  if (recipient !== undefined) item.recipient = recipient
  const hash = str(flags['recipient-key-hash'])
  if (recipient?.trim() && hash?.trim()) {
    throw usageError('Give --recipient or --recipient-key-hash, not both.', 'Amdahl hashes the recipient itself. --recipient-key-hash is for a SHA-256 you already made.')
  }
  if (hash !== undefined) {
    if (!/^[0-9a-f]{64}$/i.test(hash)) throw usageError('--recipient-key-hash is 64 hexadecimal characters: a SHA-256.')
    item.recipient_key_hash = hash
  }
  const sentPath = pasted !== undefined ? '-' : str(flags['sent-text'])
  if (pasted !== undefined) item.sent_text = text('sent-text', pasted, MAX_MESSAGE_CHARS)
  else if (sentPath !== undefined) item.sent_text = text('sent-text', await readText(ctx, sentPath), MAX_MESSAGE_CHARS)
  // The server takes an edited send with no text, but a report of an edit that does not say what it
  // became is of little use: the text is the point of `edited`, and only its hash is kept.
  if (sentAs === 'edited' && sentPath === undefined) {
    throw usageError('--sent-as edited needs --sent-text <file>: the message as you sent it.', 'Amdahl keeps only a hash of the text. Use - to read it from standard input.')
  }
  if (sentAs === 'edited' && !(typeof item.sent_text === 'string' && item.sent_text.trim())) {
    throw usageError(`${sentPath === '-' ? 'Standard input' : `--sent-text ${sentPath}`} is empty. An edited send needs the message as you sent it.`)
  }
  // The server stores a report only when it can tell which send it is: at least one of a send id and
  // a recipient. It takes both together, and refuses a recipient with a hash. Refuse here, before any request.
  if (!sendId?.trim() && !recipient?.trim() && !hash?.trim()) {
    throw usageError('Say which send this is: give --provider-send-id, a recipient (--recipient or --recipient-key-hash), or both.', "Amdahl matches a report to a send by its provider's own id, by the recipient (stored only as a hash), or both.")
  }
  return item
}

/**
 * At a terminal, ask for what a report still needs: where it went out, who it
 * went to, and whether it was changed first. At most three questions, each
 * with a default; a value the command line gave is never asked again. The
 * channel is never asked: when something else is asked and `--channel` is not
 * given, it is the recipient's (an email address is email, a LinkedIn profile
 * LinkedIn), else the run's, else the provider's, and is printed. When only
 * `--channel` is missing, nothing is asked and the usage error stands. Flags that are given are checked first, so a typo costs no
 * answers. Returns the flags to send with, and the pasted text of an edit.
 */
async function askSent(ctx: Ctx, args: string[]): Promise<{ flags: Ctx['flags']; pasted?: string }> {
  const { io, flags } = ctx
  const usage = `Usage: ${amdahlCommand('sent <run-id> --provider <provider> --channel <channel> --sent-as returned|edited --provider-send-id <id>')}`
  const [rawId] = args
  const needProvider = str(flags.provider) === undefined
  const needKey = ![flags['provider-send-id'], flags.recipient, flags['recipient-key-hash']].some((v) => typeof v === 'string' && v.trim())
  const needHow = str(flags['sent-as']) === undefined
  if (!rawId || !(needProvider || needKey || needHow)) return { flags }
  runId(rawId, usage)
  // What is given is checked now, with stand-ins for what is asked.
  // The stand-in channel is one the given provider can send, so it is not refused for a pair it was never asked.
  const standIn = PROVIDER_KINDS[str(flags.provider) ?? 'other']?.[0] === 'linkedin' ? 'linkedin_message' : 'email'
  await buildItem({ ...ctx, flags: { ...flags, provider: str(flags.provider) ?? 'other', channel: str(flags.channel) ?? standIn, 'sent-as': str(flags['sent-as']) ?? 'returned', ...(needKey ? { recipient: 'check@example.com' } : {}) } }, args)

  const answered: Ctx['flags'] = { ...flags }
  let pasted: string | undefined
  if (needProvider) {
    const choices = SEND_PROVIDERS.map((p) => PROVIDER_NAMES[p] ?? p)
    answered.provider = SEND_PROVIDERS[await io.select('Where did it go out?', choices)]
  }
  if (needKey) {
    const ask = 'Who was it sent to? An email address, or a LinkedIn profile URL: '
    let who = (await io.prompt(ask)).trim()
    if (!who) throw usageError('Say which send this is: give a recipient, or --provider-send-id.', usage)
    // A name ("priya") is not a recipient the server can match to a send: ask once more, then stop.
    if (!isRecipient(who)) {
      io.stderr(`"${who.slice(0, 60)}" is not an email address or a LinkedIn profile URL.\n`)
      who = (await io.prompt(ask)).trim()
      if (!isRecipient(who)) throw usageError('A recipient is an email address or a LinkedIn profile URL.', usage)
    }
    answered.recipient = who
  }
  if (needHow) {
    if (str(flags['sent-text']) !== undefined) {
      answered['sent-as'] = (await io.select('Was it sent as Amdahl returned it?', ['Yes, as returned', 'No, I changed it'])) === 0 ? 'returned' : 'edited'
    } else {
      const text = await io.readPaste('If you changed it before sending, paste it as sent, then press Enter on an empty line. If not, press Enter:', { emptyEnds: true })
      if (text.trim()) {
        pasted = text
        answered['sent-as'] = 'edited'
      } else answered['sent-as'] = 'returned'
    }
  }
  if (str(flags.channel) === undefined) answered.channel = inferChannel(ctx, rawId, answered)
  // A tool and a channel that can't go together are refused before anything is sent.
  checkPair(String(answered.provider), String(answered.channel))
  io.stderr(`Reporting: ${String(answered.provider)}, ${String(answered.channel)}, sent as ${String(answered['sent-as'])}.\n`)
  return { flags: answered, ...(pasted !== undefined ? { pasted } : {}) }
}

/** Whether `text` is a recipient the server can match: an email address, or a LinkedIn profile URL. */
function isRecipient(text: string): boolean {
  return EMAIL_WHOLE_VALUE.test(text) || LINKEDIN_PROFILE.test(text)
}

/** The channel a report is for, when `--channel` was not given: the recipient, then the run, then the provider. */
function inferChannel(ctx: Ctx, runIdValue: string, flags: Ctx['flags']): string {
  // The recipient says what was sent: an email address is an email, a LinkedIn profile is a LinkedIn message.
  // It comes before the run's channel and the provider, which can be wrong (a LinkedIn run sent by lemlist as email).
  const recipient = str(flags.recipient)?.trim()
  if (recipient && EMAIL_WHOLE_VALUE.test(recipient)) return 'email'
  if (recipient && LINKEDIN_PROFILE.test(recipient)) return 'linkedin_message'
  const takes = PROVIDER_KINDS[String(flags.provider)]
  const remembered = findRun(ctx, runIdValue)?.channel
  const runChannel = remembered ? (CHANNEL_ALIASES[remembered] ?? remembered) : undefined
  // The run's channel, unless the provider cannot send it (a LinkedIn run reported from an email-only tool).
  if (runChannel && (!takes || takes.includes(kindOf(runChannel)))) return runChannel
  return takes?.[0] === 'linkedin' && takes.length === 1 ? 'linkedin_message' : 'email'
}

/**
 * `amdahl sent <run-id> --provider <p> --channel <c> --sent-as returned|edited
 * (--provider-send-id <id> | --recipient <email|url> | --recipient-key-hash <sha256>)
 * [--sent-at <time>] ...`. At a terminal, what is missing is asked (see {@link askSent}).
 */
export async function sent(ctx: Ctx, args: string[]): Promise<number> {
  const asked = askingAllowed(ctx) ? await askSent(ctx, args) : { flags: ctx.flags, pasted: undefined }
  const send = asked.flags === ctx.flags ? ctx : { ...ctx, flags: asked.flags }
  const item = await buildItem(send, args, asked.pasted)

  const credential = await resolveCredential(ctx)
  const result = await call(() =>
    apiClient(ctx, credential).request<Record<string, unknown>>(`${PLATFORM}/messages/report_send`, { method: 'POST', body: { items: [item] } })
  )
  const [outcome] = records(result.items)
  const rejected = outcome?.status === 'rejected'
  const human = rejected
    ? `Not stored: ${field(outcome?.message) || field(outcome?.reason) || 'rejected'}`
    : outcome?.result === 'updated'
      ? 'Updated the earlier report of this send.'
      : 'Reported the send.'
  ctx.out.result({ ...result, ok: !rejected }, human)
  return rejected ? EXIT.general : EXIT.ok
}
