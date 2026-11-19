// src/commands/search-offer.ts
//
// What search says about the server's routing (`routing`, `research_offer`,
// `query_id`). When the server starts research for a question it says why,
// in one plain line before the wait. When a search could be answered better
// by research and the server only offers it, a person at a terminal with a
// key that can research is asked once; a sign-in is told which key can; an
// agent, CI or a pipe is given the command. Under `--json` the server's
// fields pass through and nothing is added (search.ts).

import { amdahlCommand } from '../command-name'
import { apiClient, type Credential, type Ctx } from '../context'
import { canAsk } from '../terminal'
import { field, record, wrap } from '../text'
import { shellWord } from './recipes'

/** Why the server started research, by its reason code, said after "Amdahl is researching this:". */
const ROUTED_REASON: Record<string, string> = {
  deal_facts: 'it needs your deal records.',
  counts: 'it asks for counts across your deals.',
  statistical: 'it tests what leads to wins.',
  comparison: 'it compares groups.',
  cause: 'it asks why.',
  multi_step: 'it takes several steps.',
  long_query: 'it is longer than a search reads.',
  recipe: 'it is a ready-made question that needs research.',
  written_answer: 'it asks for a written answer.',
}

/**
 * The line that says why the server started research for this question, or
 * null when the person asked for research themselves (`explicit`) or the
 * server sent no routing. A reason this version does not know gets a plain line.
 */
export function routedLine(result: Record<string, unknown>): string | null {
  const routing = record(result.routing)
  const route = field(routing?.route)
  const reason = field(routing?.reason)
  if ((route !== 'research' && route !== 'both') || reason === 'explicit') return null
  const why = ROUTED_REASON[reason]
  return why ? `Amdahl is researching this: ${why}` : 'Amdahl is researching this.'
}

/** The server's offer, as a sentence, or '' when it made none. */
export function offerReason(result: Record<string, unknown>): string {
  const reason = field(record(result.research_offer)?.reason)
  return reason && !/[.?!]$/.test(reason) ? `${reason}.` : reason
}

/** Whether a credential can start research: an API key can, a sign-in or an access token cannot (no `conversations:write`). */
export function canStartResearch(credential: Credential): boolean {
  return credential.source === 'flag' || credential.source === 'env:AMDAHL_KEY' || credential.source === 'env:AMDAHL_API_KEY'
}

/** How long the scope read may take before the offer falls back to the key line. */
const SCOPE_CHECK_MS = 4000

/**
 * Whether this API key holds `conversations:write`, which starts research: a key made with
 * `--preset optimize`, or a read-only one, does not. Never rejects: a read that fails or
 * runs past the cap says no, so the key line is shown and nothing is asked.
 */
async function keyCanResearch(ctx: Ctx, credential: Credential): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const cap = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), SCOPE_CHECK_MS)
    timer.unref?.()
  })
  const read = apiClient(ctx, credential)
    .cli.whoami()
    .then((me) => Array.isArray(me.scopes) && me.scopes.includes('conversations:write'))
    .catch(() => false)
  return Promise.race([read, cap]).finally(() => clearTimeout(timer))
}

/** The longest command line printed for a question: a longer one is told to repeat the search with --research instead. */
const COMMAND_MAX = 300

/** The command that asks the same question as research, or the way to say it when the question is too long to print. */
export function researchCommandLine(question: string): string {
  const quoted = shellWord(question)
  return quoted.length > COMMAND_MAX ? 'Run the same search again with --research.' : `Run it as research: ${amdahlCommand(`search ${quoted} --research`)}`
}

/**
 * Say what the server offered after a search, and return whether to start
 * research now. Only a person at a terminal with a key that holds
 * `conversations:write` is asked (`Research it? [y/N]`); everyone else gets
 * lines, and the scopes are read only when a question is about to be asked.
 * Nothing is said when the server made no offer.
 *
 * @param keyLine what a sign-in is told it needs (search.ts `researchKeyLine`).
 */
export async function offerResearch(ctx: Ctx, credential: Credential, result: Record<string, unknown>, question: string, keyLine: string): Promise<boolean> {
  const reason = offerReason(result)
  if (!reason) return false
  if (!canStartResearch(credential)) {
    // The command is not wrapped: a break inside it would paste as a different one.
    ctx.out.info([...wrap(reason), keyLine].join('\n'))
    return false
  }
  if (!canAsk(ctx)) {
    ctx.out.info([...wrap(reason), researchCommandLine(question)].join('\n'))
    return false
  }
  if (!(await keyCanResearch(ctx, credential))) {
    ctx.out.info([...wrap(reason), keyLine].join('\n'))
    return false
  }
  const answer = (await ctx.io.prompt(`${reason} Research it? [y/N] `)).trim().toLowerCase()
  return answer === 'y' || answer === 'yes'
}
