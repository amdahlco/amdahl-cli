// src/prompt-guided.ts
//
// The three questions bare `amdahl prompt` asks a person at a terminal, the
// way the console's Prompt tab does: 1 the prompt (pasted, or one of four
// starters), 2 who to test it on (up to 6 companies typed, or none and Amdahl
// picks from the workspace), 3 Improve or Grade. The answers are the same
// fields `amdahl prompt <file>` sends; nothing here reaches the server. The
// starters' titles and text are the console's (lib/optimizer/prompt-starters.ts).

import { amdahlCommand } from './command-name'
import type { Ctx } from './context'
import { recipientFromLine } from './prompt-recipients'
import { wrap } from './text'

interface Starter {
  title: string
  line: string
  prompt: string
}

export const PROMPT_STARTERS: readonly Starter[] = [
  {
    title: 'New signup',
    line: 'Book a call after signup',
    prompt:
      "An agent runs this whenever someone signs up for a free account on our developer platform. Write one personal email to book a 15-minute sales call.\n\nRules:\n- Open with what they signed up from: their company, their role, or the project they named at signup.\n- Say one thing the platform does for a team like theirs. Only use claims a customer call backs.\n- One ask: a 15-minute call this week.\n- Under 90 words. No bullet lists.\n- Sign off as {{sender_first_name}}.",
  },
  {
    title: 'Pricing page visit',
    line: 'Catch them comparing',
    prompt:
      'An agent runs this when a known account visits our pricing page twice in a week. Write a short email to the person who visited.\n\nRules:\n- Do not say we saw the visit. Lead with the problem teams at their size usually have.\n- One customer story in the same segment, only if a call backs it.\n- One ask: a 20-minute call.\n- Under 80 words.',
  },
  {
    title: 'Funding or hiring',
    line: 'Open with the news',
    prompt:
      'An agent runs this when a target account announces a funding round or posts 5 or more roles in one team.\n\nRules:\n- First line names the news and the date.\n- Say what that usually means for their team in one sentence.\n- One ask: a 15-minute call. Under 70 words.\n- Never congratulate. Never guess at their plans.',
  },
  {
    title: 'Champion moved',
    line: 'Reach them at the new job',
    prompt:
      'An agent runs this when someone who used our product at a past company starts a new job.\n\nRules:\n- Open with the new role and what they did with us before.\n- Say what is new since they left, using only facts from our notes.\n- One ask: a 10-minute catch-up. Under 70 words.\n- Warm and brief. No pitch.',
  },
]

/** The most companies a person may type, as the API takes at most 6 recipients. */
const MAX_TYPED = 6

const PASTE = 'Paste my prompt'
const TYPED_QUESTION = 'Type up to 6 companies, one per line:\n  Company\n  Company | Name\n  Company | Name | what you know about them\nThen press Enter on an empty line:'

/** What flags already answered: recipients from a file, and the mode named. */
export interface Skip {
  recipients: boolean
  mode?: string
}

export interface GuidedAnswers {
  prompt: string
  /** Typed recipients, as the API takes them; undefined means Amdahl picks. */
  recipients?: Record<string, unknown>[]
  mode?: 'improve' | 'grade'
}

/**
 * Ask the questions. `skip` names what a flag already answered (recipients, mode). Returns null when
 * nothing was pasted or the person stops, after saying so.
 */
export async function askGuided(ctx: Ctx, skip: Skip): Promise<GuidedAnswers | null> {
  const { io, out } = ctx
  // Only the steps a flag has not answered are shown, and they are numbered as shown.
  const total = 1 + (skip.recipients ? 0 : 1) + (skip.mode ? 0 : 1)
  let shown = 0
  const step = (title: string) => out.info(total === 1 ? `${title[0]?.toUpperCase()}${title.slice(1)}` : `Step ${++shown} of ${total}: ${title}`)

  step('your prompt')
  const source = await io.select('Where does the prompt come from?', [PASTE, ...PROMPT_STARTERS.map((s) => `${s.title}: ${s.line}`)], { initial: 0 })
  let prompt: string
  if (source === 0) {
    prompt = await io.readPaste('Paste the prompt, then press Enter on an empty line (Ctrl+C to stop):')
    if (!prompt.trim()) {
      out.info('Nothing pasted, so nothing was sent.')
      return null
    }
  } else {
    prompt = PROMPT_STARTERS[source - 1]?.prompt ?? ''
    out.info(`${PROMPT_STARTERS[source - 1]?.title}:\n${prompt}`)
  }

  let recipients: Record<string, unknown>[] | undefined
  if (!skip.recipients) {
    step('who to test it on')
    const pick = await io.select('Which companies should the emails be written for?', ['Let Amdahl pick up to 6 accounts from your workspace', 'Type the companies'], { initial: 0 })
    if (pick === 1) recipients = await askCompanies(ctx)
  }

  let mode: 'improve' | 'grade' | undefined
  if (skip.mode !== 'grade') {
    if (!skip.mode) {
      step('what to do with it')
      const choice = await io.select('What should Amdahl do?', ['Improve it', 'Grade it'], { initial: 0 })
      mode = choice === 1 ? 'grade' : 'improve'
    } else mode = 'improve'
    while (mode === 'improve' && recipients && recipients.length === 1) {
      out.info('Improving needs 2 companies or more: Amdahl checks the revised prompt on a company it did not revise on.')
      const next = await io.select('What now?', ['Grade it instead', 'Stop, I will add another company'], { initial: 0 })
      if (next === 0) mode = 'grade'
      // The company already typed stays; the next lines are added to it.
      else recipients = await askCompanies(ctx, recipients)
    }
  }
  return { prompt, ...(recipients ? { recipients } : {}), ...(mode ? { mode } : {}) }
}

/**
 * Read typed companies until there are 1 to 6 good lines, or the person types none (Amdahl picks).
 * With `kept` (companies already typed), the lines are added to them, and none typed keeps them as they are.
 */
async function askCompanies(ctx: Ctx, kept: Record<string, unknown>[] = []): Promise<Record<string, unknown>[] | undefined> {
  const { io, out } = ctx
  const room = MAX_TYPED - kept.length
  for (;;) {
    const question = kept.length > 0 ? `Kept ${kept.length === 1 ? '1 company' : `${kept.length} companies`}. Type up to ${room} more, one per line, then press Enter on an empty line:` : TYPED_QUESTION
    const typed = (await io.readPaste(question, { emptyEnds: true })).split('\n').map((l) => l.trim()).filter(Boolean)
    if (typed.length === 0 && kept.length > 0) return kept
    if (typed.length === 0) {
      out.info('No companies typed, so Amdahl will pick them from your workspace.')
      return undefined
    }
    if (typed.length > room) {
      out.info(kept.length > 0 ? `That is ${typed.length} more, and ${kept.length} kept. A run takes at most ${MAX_TYPED}.` : `That is ${typed.length} companies. A run takes at most ${MAX_TYPED}.`)
      continue
    }
    const items = typed.map(recipientFromLine)
    const bad = items.findIndex((i) => i === null)
    if (bad >= 0) {
      out.info(`Line ${bad + 1} has no company.`)
      continue
    }
    return [...kept, ...(items as Record<string, unknown>[])]
  }
}

/**
 * How to run the same thing without the questions. The CLI writes no file of its own, so
 * this says how to save the prompt and the typed companies, then gives the command.
 */
export function nextTimeLine(answers: GuidedAnswers, skip: Skip): string {
  const parts = ['prompt prompt.md']
  const typed = Boolean(answers.recipients && !skip.recipients)
  if (typed) parts.push('--recipients recipients.csv')
  if (answers.mode === 'grade' && !skip.mode) parts.push('--mode grade')
  const save = typed ? 'the prompt as prompt.md and the companies as recipients.csv (columns company, name, notes)' : 'the prompt as prompt.md'
  return `${wrap(`Next time, save ${save}, then run:`).join('\n')}\n  ${amdahlCommand(parts.join(' '))}`
}
