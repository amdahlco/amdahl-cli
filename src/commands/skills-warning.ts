// src/commands/skills-warning.ts
//
// The security warning amdahl.ai puts on a skill its AI security review
// flagged: an `x-amdahl-warning` field on the skill's entry in its index,
// `{ check, result, flagged, line, flags, more, text }`, where `text` is the
// skill page's own sentence ("Flagged: it may send your data somewhere else
// (line 14), and 2 more. Read it before you install."). The site builds it
// from fixed labels and a line number only. Still, every field is read as
// untrusted: `result` must be `warn` or `fail`; `text` must be a string, and
// is printed only with line breaks turned into spaces, every control and
// format character removed, and cut to 300 characters; `line` is kept only
// as a positive integer.
//
// The site sends the field only for a flagged skill, so a field that is
// there means flagged, even when this version cannot read it (a new
// `result`, the sentence under another key). Such a field FAILS CLOSED: it
// becomes a fixed warning (UNREADABLE_WARNING) that is held exactly like a
// readable one. Only a missing field, or null, means no warning.
//
// A warning is printed before anything is written: the skill, the sentence
// and the skill page. Then `--accept-warning` installs. A person at a
// terminal (no -y, no --json, and no agent that says it ran this) picks in a
// menu that starts on Cancel, which writes nothing and exits 0. Anything
// else stops with exit 9 (EXIT.flagged) and says to show the warning to the
// person first.

import type { Ctx } from '../context'
import { CliError, EXIT } from '../errors'
import { PromptCancelled } from '../io'
import type { SkillRef } from './skills'
import { runningAgent } from './skills-guide'

/** The index entry field that carries the warning. */
export const WARNING_FIELD = 'x-amdahl-warning'

/** The most characters of the site's sentence that are printed. */
export const MAX_WARNING_CHARS = 300

/** A security warning from the index, with every field checked. */
export interface SkillWarning {
  result: 'warn' | 'fail'
  /** The check that flagged it, as a plain id (`data_leaving`), or null. */
  flagged: string | null
  /** The line in the SKILL.md, or null when it names none. */
  line: number | null
  /** The site's sentence, safe to print. */
  text: string
}

// Line breaks and tabs, which become a space.
const BREAK_RE = /[\t\n\v\f\r\u0085\u2028\u2029]/g
// Every other control character (C0 with ESC, DEL, C1), every format
// character (bidi overrides, zero-width) and any lone surrogate.
const UNSAFE_RE = /[\p{Cc}\p{Cf}\p{Cs}]/gu
const CHECK_ID_RE = /^[a-z][a-z0-9_]{0,39}$/

/**
 * The site's sentence made safe to print: line breaks as spaces, every
 * control and format character removed, spaces collapsed, and at most
 * {@link MAX_WARNING_CHARS} characters (a cut one ends in "...").
 */
export function warningText(raw: string): string {
  const clean = raw.replace(BREAK_RE, ' ').replace(UNSAFE_RE, '').replace(/ {2,}/g, ' ').trim()
  const chars = Array.from(clean)
  if (chars.length <= MAX_WARNING_CHARS) return clean
  return `${chars.slice(0, MAX_WARNING_CHARS - 3).join('').trimEnd()}...`
}

/** The warning for a field that is there but that this version cannot read: still a warning, held the same way. */
export const UNREADABLE_WARNING: Readonly<SkillWarning> = Object.freeze({
  result: 'warn',
  flagged: null,
  line: null,
  text: 'amdahl.ai flagged this skill. This version of the CLI could not read why.',
})

/**
 * Read the entry's warning field: undefined when there is none (missing,
 * or null), else the checked warning. A field that is not a warning this
 * can show (not an object, a `result` other than warn or fail, or no
 * sentence left to print) is UNREADABLE_WARNING, never no warning.
 */
export function readWarning(raw: unknown): SkillWarning | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ...UNREADABLE_WARNING }
  const { result, flagged, line, text } = raw as Record<string, unknown>
  if (result !== 'warn' && result !== 'fail') return { ...UNREADABLE_WARNING }
  const sentence = typeof text === 'string' ? warningText(text) : ''
  if (!sentence) return { ...UNREADABLE_WARNING }
  return {
    result,
    flagged: typeof flagged === 'string' && CHECK_ID_RE.test(flagged) ? flagged : null,
    line: typeof line === 'number' && Number.isSafeInteger(line) && line > 0 ? line : null,
    text: sentence,
  }
}

/** The skill's page on the site, where a person reads what was flagged. Built from the checked name, never from the index. */
export function skillPage(site: string, ref: SkillRef): string {
  return `${site}/skills/${ref.publisher}/${ref.skill}`
}

/** The warning for `--json`: the checked fields and the skill page. */
export function warningJson(warning: SkillWarning, site: string, ref: SkillRef): Record<string, unknown> {
  return { ...warning, page: skillPage(site, ref) }
}

/**
 * True when a person can answer the menu: a terminal, no -y or --json, and
 * no agent that says it ran this (an agent's own terminal can be a TTY, and
 * an agent must not pick "Install anyway" for the person).
 */
function canAsk(ctx: Ctx): boolean {
  return !ctx.nonInteractive && ctx.io.stdoutIsTTY && !ctx.out.json && ctx.flags.yes !== true && runningAgent(ctx) === null
}

/**
 * Print the warning, then settle whether to install: true to go on, false
 * when the person picked Cancel. Writes nothing.
 *
 * @throws a `skill_flagged` CliError (exit 9) when no one can be asked and
 *   `--accept-warning` was not given; a `cancelled` one (exit 130) on Ctrl+C.
 */
export async function confirmWarning(ctx: Ctx, ref: SkillRef, site: string, warning: SkillWarning): Promise<boolean> {
  const { out } = ctx
  const host = new URL(site).host
  const name = `${ref.publisher}/${ref.skill}`
  const head = warning.result === 'fail' ? `${name} failed ${host}'s security review.` : `${host}'s security review flagged ${name}.`
  out.info([out.bold(`Warning: ${head}`), `  ${warning.text}`, `  See what was flagged: ${skillPage(site, ref)}`].join('\n'))

  if (ctx.flags['accept-warning'] === true) {
    out.info('Installing it anyway, because of --accept-warning.')
    return true
  }
  if (!canAsk(ctx)) {
    throw new CliError(
      'skill_flagged',
      `Did not install ${name}, because the security review flagged it. Nothing was written.`,
      EXIT.flagged,
      'Show this warning to the person you are working for. Once they agree, run the same command again with --accept-warning.',
      undefined,
      { warning: warningJson(warning, site, ref) }
    )
  }
  out.info('')
  let pick: number
  try {
    pick = await ctx.io.select('Install this skill?', ['Cancel', 'Install anyway'], { initial: 0, color: out.color })
  } catch (err) {
    if (err instanceof PromptCancelled) throw new CliError('cancelled', 'Stopped. Nothing was written.', EXIT.cancelled)
    throw err
  }
  if (pick === 1) return true
  out.info('Cancelled. Nothing was written.')
  return false
}
