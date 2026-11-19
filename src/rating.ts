// src/rating.ts
//
// A thumbs up or down on something Amdahl returned: `POST /feedback` (the `feedback.record`
// operation). The row is for the key's own owner; the CLI says it is the CLI (`client: 'cli'`) and
// which version. `amdahl feedback --rating` sends one, and the opt-in prompt after `optimize` and
// `search` sends one too. Never the message or the question: only the id of what was rated, the
// rating, and the comment a person typed.

import { apiClient, call, toCliError, type Credential, type Ctx } from './context'
import { CliError, EXIT } from './errors'
import { PromptCancelled } from './io'
import { feedbackPromptOn } from './config'
import { canAsk } from './terminal'
import { VERSION } from './version'

export const RATINGS = ['up', 'down'] as const
export const RATING_SURFACES = ['optimize', 'search', 'research', 'grade', 'lead_list', 'other'] as const
export type Rating = (typeof RATINGS)[number]
export type RatingSurface = (typeof RATING_SURFACES)[number]

/** The longest comment the server takes, in characters. */
export const MAX_RATING_COMMENT_CHARS = 2_000

/** How long a rating may take to save before the CLI gives up on it. */
export const RATING_TIMEOUT_MS = 10_000

/**
 * What a CLI sign-in is told when the server refuses it (403 `credential_not_allowed`): until the
 * server takes the CLI's own OAuth client, only an API key can rate. The request is always sent, so a
 * server that accepts the sign-in needs no new CLI.
 */
export function ratingNeedsKey(): CliError {
  return new CliError(
    'credential_not_allowed',
    'A rating needs an API key for now. A browser sign-in cannot send one yet.',
    EXIT.forbidden,
    'Make a key with `amdahl keys create --name rating`, then run this with AMDAHL_KEY=<key> or --api-key <key>.'
  )
}

export interface RatingInput {
  /** The id of what was rated: an optimize run id, a search query id, or a research id. */
  id: string
  surface: RatingSurface
  rating: Rating
  comment?: string
  /** true: the team may email the person. false: said no. Absent: not said. */
  emailOk?: boolean
}

/** Send one rating. Resolves the server's answer; throws the CLI's usual error on a refusal. */
export async function postRating(ctx: Ctx, credential: Credential, input: RatingInput): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    answer_id: input.id,
    subject_id: input.id,
    surface: input.surface,
    rating: input.rating,
    client: 'cli',
    client_version: VERSION,
  }
  if (input.comment?.trim()) body.comment = input.comment
  if (input.emailOk !== undefined) body.email_ok = input.emailOk
  try {
    return await call(() =>
      apiClient(ctx, credential).request<Record<string, unknown>>('/api/platform/v1/feedback', { method: 'POST', body, signal: AbortSignal.timeout(RATING_TIMEOUT_MS) })
    )
  } catch (err) {
    if (err instanceof CliError && err.code === 'credential_not_allowed') throw ratingNeedsKey()
    throw err
  }
}

/** What the one-line prompt reads: y, yes, up (a thumbs up) or n, no, down (a thumbs down). */
export function ratingFromAnswer(answer: string): Rating | null {
  const a = answer.trim().toLowerCase()
  if (a === 'y' || a === 'yes' || a === 'up') return 'up'
  if (a === 'n' || a === 'no' || a === 'down') return 'down'
  return null
}

/**
 * After a result at a terminal: one line, "Was this useful?". Off unless `feedbackPrompt` (or
 * AMDAHL_FEEDBACK_PROMPT) is on, and never for --json, a pipe, CI or AMDAHL_NO_PROMPT. Enter skips.
 * A no asks one more question for what went wrong. A refusal or a failure to save prints one quiet
 * line and never changes the command's exit code: the result was already printed.
 */
export async function askRating(ctx: Ctx, credential: Credential, target: { id: string; surface: RatingSurface }): Promise<void> {
  if (!feedbackPromptOn(ctx.io, ctx.config) || !canAsk(ctx) || !target.id) return
  try {
    const rating = ratingFromAnswer(await ctx.io.prompt('Was this useful? [y/n, Enter to skip] '))
    if (!rating) return
    const comment = rating === 'down' ? (await ctx.io.prompt('What went wrong? (Enter to skip) ')).trim() : ''
    await postRating(ctx, credential, { id: target.id, surface: target.surface, rating, ...(comment ? { comment: comment.slice(0, MAX_RATING_COMMENT_CHARS) } : {}) })
    ctx.io.stderr('Thanks, saved.\n')
  } catch (err) {
    if (err instanceof PromptCancelled) return
    const failure = toCliError(err)
    ctx.io.stderr(`Could not save your rating: ${failure.message}\n${failure.hint ? `${failure.hint}\n` : ''}`)
  }
}
