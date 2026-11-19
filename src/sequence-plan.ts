// src/sequence-plan.ts
//
// `amdahl sequence --write`: the plan for a sequence Amdahl writes, one named
// email at a time, and the rules each email is written from. The console's
// "Plan your sequence" does the same, so the starters, the email names, their
// one-line jobs and the words that pick the first email are copied BY HAND from
// amdahl-frontend (apps/universal-ui/lib/optimizer/sequence-plan.ts) at commit
// 9d1d55216 (#2277). A change in the console is not caught here: make it in both
// places. The plan is made by this code, never by a model.

import { usageError } from './errors'

export const MIN_STEPS = 2
export const MAX_STEPS = 6
export const GOAL_CHARS = 300

/** The console's plan screen starts at 3 emails. */
export const DEFAULT_STEPS = 3

/** The server takes at most this many characters in a rule. */
const MAX_RULE_CHARS = 500

/** The server takes at most this many rules in `context.rules`. */
export const MAX_RULES = 20

export interface PlanStep {
  name: string
  job: string
}

export interface Starter {
  name: string
  line: string
  goal: string
}

export const STARTERS: readonly Starter[] = [
  { name: 'Cold outbound', line: 'New prospects, first touch', goal: 'Book a first meeting with prospects who have never heard from us.' },
  { name: 'Event follow-up', line: 'Attendees and booth visitors', goal: 'Follow up with everyone who came to our event and book a meeting to keep the conversation going.' },
  { name: 'Inbound follow-up', line: 'Demo requests and form fills', goal: 'Follow up with people who requested a demo or signed up, and book a call.' },
  { name: 'Trial follow-up', line: 'Free trial users not paying yet', goal: 'Follow up with people on a free trial who have not paid yet and book a call.' },
  { name: 'No-reply follow-up', line: 'Opened, never answered', goal: 'Get a reply from people who opened our emails but never answered.' },
  { name: 'Closed-lost', line: 'Reopen deals you lost', goal: 'Restart the conversation with deals we lost.' },
  { name: 'Champion job change', line: 'A past buyer at a new company', goal: 'Reach out to past champions who moved to a new company.' },
  { name: 'Customer expansion', line: 'Upsell existing accounts', goal: 'Grow existing customers: offer the next product or more seats to accounts that already use us.' },
]

const JOBS: Record<string, string> = {
  Opener: 'Why now, and one easy question',
  'Follow-up': 'A new reason to reply, not a bump',
  Proof: 'One result from a team like theirs',
  'Another angle': 'A different reason to talk, in one line',
  'Last try': 'Close politely and leave a way back in',
  Thanks: 'Thank them and pick up where you left off',
  'What changed': 'Say what is new since you last spoke',
}

type Kind = 'event' | 'winback' | 'meeting'

const EVENT_WORDS = /\b(?:dinner|event|webinar|conference|meetup|booth|attend\w*)\b/i
const LOST_WORDS = /\b(?:closed|lost|quiet|win back|churn\w*)\b/i

const kindOf = (goal: string): Kind => (EVENT_WORDS.test(goal) ? 'event' : LOST_WORDS.test(goal) ? 'winback' : 'meeting')

const MIDDLE = ['Follow-up', 'Proof', 'Follow-up', 'Another angle']
const LEAD: Record<Kind, string> = { event: 'Thanks', winback: 'What changed', meeting: 'Opener' }

/** The plan for `goal` with `n` emails (2 to 6): event words lead with Thanks, lost-deal words with What changed, else Opener; the last is always Last try. */
export function suggestPlan(goal: string, n: number): PlanStep[] {
  const count = Math.max(MIN_STEPS, Math.min(MAX_STEPS, n))
  const names = [LEAD[kindOf(goal)], ...MIDDLE].slice(0, count - 1).concat('Last try')
  return names.map((name) => ({ name, job: JOBS[name] ?? '' }))
}

const lowerFirst = (text: string) => (text ? text[0]!.toLowerCase() + text.slice(1) : text)

/** The most rules a written email gets from the plan: the goal, its place, the greeting, the thread rule and the date rule. */
export const MAX_PLAN_RULES = 5

export const FIRST_NAME_RULE = 'Greet the reader with {{first_name}} so the sequencer fills it in.'
export const NO_DATE_RULE = 'Do not name the date or day of an earlier email: the send dates are not set yet.'
export const threadRule = (n: number) => `Email ${n} replies in the same thread as email 1, so it has no subject line.`

/**
 * The rules email `index` (from 0) is written from: the goal, its place and
 * job in the plan, the greeting (a template is one set of emails for anyone;
 * a sequence written for one person does not greet with a fill-in field), and
 * for an email after the first, the thread rule and the date rule. The same
 * order as the console's planRules.
 */
export function planRules(goal: string, steps: PlanStep[], index: number, template = true): string[] {
  const step = steps[index] as PlanStep
  const job = step.job.trim().replace(/[.\s]+$/, '')
  const line = `This is email ${index + 1} of ${steps.length}: ${step.name.trim() || `Email ${index + 1}`}.${job ? ` Its job: ${lowerFirst(job)}.` : ''}`
  const rules = [`This sequence: ${goal.trim()}`, line]
  if (template) rules.push(FIRST_NAME_RULE)
  if (index > 0) rules.push(threadRule(index + 1), NO_DATE_RULE)
  return rules.map((rule) => rule.slice(0, MAX_RULE_CHARS))
}

/** A step as one line: `Name: job`, or the name alone. */
export const stepLine = (step: PlanStep) => (step.job.trim() ? `${step.name.trim()}: ${step.job.trim()}` : step.name.trim())

/**
 * Read a plan file: one email for each line, `Name: job` or `Name` alone. Blank
 * lines are skipped. 2 to 6 lines.
 *
 * @throws a usage error (exit 2) naming the file when the count is wrong.
 */
export function parsePlan(text: string, path: string): PlanStep[] {
  const steps = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(':')
      return at < 0 ? { name: line, job: '' } : { name: line.slice(0, at).trim(), job: line.slice(at + 1).trim() }
    })
  if (steps.length < MIN_STEPS || steps.length > MAX_STEPS) {
    throw usageError(`${path} has ${steps.length} ${steps.length === 1 ? 'line' : 'lines'}. A plan is 2 to 6 emails, one on each line.`, 'Each line is the email name, then a colon, then its job: Proof: One result from a team like theirs')
  }
  const blank = steps.findIndex((s) => !s.name)
  if (blank >= 0) throw usageError(`Line ${blank + 1} of ${path} has no email name.`)
  return steps
}
