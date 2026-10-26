// src/commands/skills.ts
//
// `amdahl skills add <publisher>/<skill> [-g] [--agents] [--force] [--accept-warning] [--site <origin>]`:
// install one skill from the library at amdahl.ai/skills. Reads the skill's
// one-entry index (Agent Skills Discovery v0.2.0) at
// `<site>/skills/<publisher>/<skill>/.well-known/agent-skills/index.json`,
// then fetches what the entry names: a SKILL.md (`type: skill-md`) or a
// tar.gz of the skill's folder (`type: archive`). It refuses the download
// unless its sha256 matches the entry's digest (from the same site, so this
// catches a corrupted download, not a changed one), and refuses an archive that
// our own reader (src/tar-gz.ts) does not pass. Either way the SKILL.md must
// have YAML front matter with a string `name` (the index's) and
// `description`. Needs no sign-in. Makes exactly these two requests, both to
// the site, and follows no redirect: no telemetry, no other host. Each
// request has a deadline and a size cap. Writes `./.claude/skills/<name>/`
// (`-g`: under the home folder; `--agents`: `.agents/skills` too), never
// replaces a different skill of the same name without `--force`, and writes
// nothing on a refusal. A skill amdahl.ai's security review flagged carries a
// warning in its index entry: it is printed before anything is written, and
// the install goes on only with `--accept-warning` or a person's "Install
// anyway" at a terminal (./skills-warning.ts).

import { createHash } from 'node:crypto'
import { parseDocument } from 'yaml'
import { str, type Ctx } from '../context'
import { CliError, EXIT, exitForHttp, usageError } from '../errors'
import { printable } from '../output'
import { ArchiveError, readSkillArchive, type SkillArchive } from '../tar-gz'
import { agentsInUse, guide, nextStep, runningAgent, shouldGuide, skillsFolders, type SkillSummary } from './skills-guide'
import { planInstall, refuseClashes, skillDirs, writeInstall, type FilePlan, type Payload, type Targets } from './skills-install'
import { WARNING_FIELD, confirmWarning, readWarning, warningJson, type SkillWarning } from './skills-warning'

/** Where the skills library is published. */
export const DEFAULT_SKILLS_SITE = 'https://amdahl.ai'

/** The only hosts `--site` may name over plain http. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** A publisher slug as amdahl.ai allows it: 1-40 characters, never `--`. */
const PUBLISHER_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

/** A skill name as the Agent Skills spec and amdahl.ai allow it: 1-64 characters, single hyphens. */
const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/

/** The most `skills add` reads of an index: far more than one entry needs. */
export const MAX_INDEX_BYTES = 256 * 1024

/** The most it reads of a SKILL.md: amdahl.ai refuses a bigger one (its SKILL_MAX_BYTES). */
export const MAX_SKILL_BYTES = 64 * 1024

/** The most it downloads of a folder skill's archive (4 MB). */
export const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024

const DIGEST_RE = /^sha256:([0-9a-f]{64})$/i
const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
const USAGE = 'Usage: amdahl skills add <publisher>/<skill> [-y] [-g] [--agents] [--force] [--accept-warning] [--site <origin>]'

/** One skill in the library. */
export interface SkillRef {
  publisher: string
  skill: string
}

/**
 * Validate `--site` and return its origin: https, or http for localhost only,
 * with no path, query or credentials.
 */
export function normaliseSite(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw usageError(`Not a valid --site origin: ${raw}`)
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw usageError(`--site must be https (http only for localhost): ${raw}`)
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw usageError(`--site takes an origin only, like ${DEFAULT_SKILLS_SITE}: ${raw}`)
  }
  return url.origin
}

/**
 * Read `<publisher>/<skill>`, or the skill's page or `.md` URL on the site.
 *
 * @throws a usage CliError for anything else, including a URL on another site.
 */
export function parseSkillRef(raw: string, site: string): SkillRef {
  let path = raw
  if (/^https?:\/\//i.test(raw)) {
    let url: URL | null = null
    try {
      url = new URL(raw)
    } catch {
      // Reported below as not a skill.
    }
    if (url && url.origin !== site) {
      throw usageError(`${raw} is not on ${site}.`, 'Pass --site <origin> to install from another site.')
    }
    const m = url ? /^\/skills\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname) : null
    path = m ? `${m[1]}/${m[2]}` : ''
  }
  const [publisher = '', skill = '', ...rest] = path.replace(/\.md$/, '').split('/')
  if (rest.length > 0 || !PUBLISHER_RE.test(publisher) || publisher.includes('--') || !SKILL_NAME_RE.test(skill)) {
    throw usageError(`Not a skill: ${raw}`, `Name it as <publisher>/<skill>, or paste its link from ${site}/skills.`)
  }
  return { publisher, skill }
}

/**
 * GET one URL, following no redirect, and return the body's bytes. Gives up
 * after `io.fetchTimeoutMs`, headers and body together, and refuses a body
 * over `maxBytes`: by its Content-Length when it sends one, else as it reads.
 */
async function get(ctx: Ctx, url: string, what: string, site: string, maxBytes: number, notFound?: CliError): Promise<Buffer> {
  const timeoutMs = ctx.io.fetchTimeoutMs
  const signal = AbortSignal.timeout(timeoutMs)
  // Rejects when the time is up, so a stalled body is cut off too, whatever
  // fetch does with the signal once the headers are in.
  const timedOut = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  timedOut.catch(() => {})
  const retry = 'Nothing was written. Check your internet connection, then run the same command again.'
  const unreachable = () => {
    if (signal.aborted) return new CliError('network_error', `No answer from ${url} within ${timeoutMs / 1000} seconds.`, EXIT.network, retry)
    return new CliError('network_error', `Could not reach ${new URL(site).host}.`, EXIT.network, retry)
  }
  const limit = maxBytes >= 1024 * 1024 ? `${maxBytes / 1024 / 1024} MB` : `${maxBytes / 1024} KB`
  const tooLarge = () =>
    new CliError('too_large', `${url} is over ${limit}, the most skills add reads for a ${what}.`, EXIT.general, 'Nothing was written.')

  let res: Response
  try {
    res = await Promise.race([fetch(url, { redirect: 'manual', signal }), timedOut])
  } catch (err) {
    throw unreachable()
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    if (res.status >= 300 && res.status < 400) {
      throw new CliError('skill_redirect', `${url} answered with a redirect, and skills add follows none.`, EXIT.general)
    }
    if (res.status === 404) {
      if (notFound) throw notFound
      throw new CliError('skill_not_found', `No ${what} at ${url}.`, EXIT.general, `Check the publisher and skill name at ${site}/skills.`)
    }
    throw new CliError(`http_${res.status}`, `${url} answered HTTP ${res.status}.`, exitForHttp(res.status))
  }
  if (Number(res.headers.get('content-length')) > maxBytes) {
    await res.body?.cancel().catch(() => {})
    throw tooLarge()
  }
  const reader = res.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (reader) {
      const { done, value } = await Promise.race([reader.read(), timedOut])
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw tooLarge()
      chunks.push(value)
    }
  } catch (err) {
    await reader?.cancel().catch(() => {})
    throw err instanceof CliError ? err : unreachable()
  }
  return Buffer.concat(chunks)
}

/** A skill's entry in its index: what to download, from where, and the sha256 hex it must match. */
export interface IndexEntry {
  type: 'skill-md' | 'archive'
  url: string
  sha256: string
  description: string
  version?: string
  /** The security review's warning, checked (UNREADABLE_WARNING when the field is there but could not be read). */
  warning?: SkillWarning
}

/**
 * Find the skill's entry in its index and return its type, the URL of its
 * SKILL.md or archive (on the site), the sha256 hex the download must match
 * and the security warning, when it carries one.
 */
export function readIndex(body: Buffer, indexUrl: string, ref: SkillRef, site: string): IndexEntry {
  const bad = (why: string) => new CliError('invalid_index', `The index at ${indexUrl} ${why}.`, EXIT.general)
  let index: unknown
  try {
    index = JSON.parse(body.toString('utf8'))
  } catch {
    throw bad('is not JSON')
  }
  const skills = index && typeof index === 'object' ? (index as { skills?: unknown }).skills : undefined
  if (!Array.isArray(skills)) throw bad('has no skills list')
  const entry = skills.find((s) => s && typeof s === 'object' && (s as { name?: unknown }).name === ref.skill) as
    | Record<string, unknown>
    | undefined
  if (!entry) throw bad(`does not list ${ref.skill}`)
  const type = entry.type
  if (type !== 'skill-md' && type !== 'archive') throw bad(`lists ${ref.skill} as a type other than skill-md or archive`)
  const digest = typeof entry.digest === 'string' ? DIGEST_RE.exec(entry.digest) : null
  if (!digest?.[1]) throw bad(`gives ${ref.skill} no sha256 digest`)
  let url: URL | null = null
  try {
    url = typeof entry.url === 'string' ? new URL(entry.url, indexUrl) : null
  } catch {
    url = null
  }
  if (!url) throw bad(`gives ${ref.skill} no file URL`)
  if (url.origin !== site) throw bad(`points ${ref.skill} at ${url.origin}, not ${site}`)
  const version = typeof entry.version === 'string' ? printable(entry.version) : ''
  const warning = readWarning(entry[WARNING_FIELD])
  return {
    type,
    url: url.href,
    sha256: digest[1].toLowerCase(),
    description: typeof entry.description === 'string' ? entry.description : '',
    ...(version ? { version } : {}),
    ...(warning ? { warning } : {}),
  }
}

/** Refuse downloaded bytes whose sha256 differs from the index digest. The hashes go to `--json` only. */
export function checkDigest(body: Buffer, fileUrl: string, sha256: string): void {
  const actual = createHash('sha256').update(body).digest('hex')
  if (actual !== sha256) {
    throw new CliError(
      'digest_mismatch',
      `The download did not match what ${new URL(fileUrl).host} lists, so nothing was written.`,
      EXIT.general,
      'Try again.',
      `${fileUrl} has sha256 ${actual}; the index says ${sha256}.`
    )
  }
}

/**
 * Refuse a SKILL.md that is not one for `ref.skill`: UTF-8, YAML front
 * matter, a string `name` equal to the index's and a non-empty string
 * `description`. `what` names the file in the message.
 */
export function checkSkillMd(body: Buffer, what: string, ref: SkillRef): { description: string; version?: string } {
  const bad = (why: string) => new CliError('invalid_skill', `${what} is not a valid skill: ${why}.`, EXIT.general)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw bad('it is not UTF-8 text')
  }
  const fm = FRONT_MATTER_RE.exec(text)
  if (!fm) throw bad('it has no front matter')
  const doc = parseDocument(fm[1] ?? '', { uniqueKeys: true })
  const yamlError = doc.errors[0]
  if (yamlError) {
    // +1 for the opening `---` line, so the number is the file's own line.
    const line = yamlError.linePos ? `line ${yamlError.linePos[0].line + 1}: ` : ''
    throw bad(`its front matter is not valid YAML (${line}${printable(yamlError.message.split(' at line')[0] ?? '')})`)
  }
  let meta: unknown
  try {
    meta = doc.toJS()
  } catch (err) {
    throw bad(`its front matter could not be read (${printable(err instanceof Error ? err.message : String(err))})`)
  }
  const { name, description, version, metadata } = (meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}) as Record<string, unknown>
  if (typeof name !== 'string') throw bad('its front matter has no string name')
  if (typeof description !== 'string' || description.trim() === '') throw bad('its front matter has no string description')
  if (name !== ref.skill) throw bad(`its front matter names it "${printable(name)}", but the index lists ${ref.skill}`)
  const nested = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).version : undefined
  const v = printable(typeof version === 'string' ? version : typeof nested === 'string' ? nested : '')
  return { description, ...(v ? { version: v } : {}) }
}

/**
 * Unpack a folder skill's archive with our own reader and check its SKILL.md.
 * Call only after checkDigest: the bytes are then the ones the index promised.
 */
export function readArchive(body: Buffer, url: string, ref: SkillRef): { archive: SkillArchive; meta: { description: string; version?: string } } {
  let archive: SkillArchive
  try {
    archive = readSkillArchive(body)
  } catch (err) {
    if (!(err instanceof ArchiveError)) throw err
    // Its message can quote a path from the archive.
    const why = printable(err.message)
    if (err.tooLarge) throw new CliError('too_large', `${url} is too large: ${why}.`, EXIT.general, 'Nothing was written.')
    throw new CliError('invalid_archive', `${url} is not a safe skill archive: ${why}.`, EXIT.general, 'Nothing was written.')
  }
  const skillMd = archive.files.find((f) => f.path === 'SKILL.md')
  if (!skillMd) throw new CliError('invalid_skill', `${url} is not a valid skill: it has no SKILL.md at its root.`, EXIT.general)
  return { archive, meta: checkSkillMd(skillMd.bytes, `The SKILL.md in ${url}`, ref) }
}

/** The note for an install that asked nothing and was given no place: where it went, and how to choose. */
function defaultsNote(agent: 'claude' | 'cursor' | null): string {
  if (agent === 'cursor') return 'Added to .agents/skills in this project, for Cursor, which ran this. For every project add -g.'
  const who = agent === 'claude' ? 'Claude Code, which ran this' : 'Claude Code, the default'
  return `Added for ${who}, in this project. For every project add -g; for Codex, Cursor and other agents add --agents.`
}

/** What was downloaded and checked: the index entry, the skill itself, and what its SKILL.md says. */
interface Fetched {
  entry: IndexEntry
  payload: Payload
  meta: { description: string; version?: string }
}

/** Read the index, download the skill and check it all. Writes nothing. */
async function fetchSkill(ctx: Ctx, ref: SkillRef, site: string): Promise<Fetched> {
  const host = new URL(site).host
  const indexUrl = `${site}/skills/${ref.publisher}/${ref.skill}/.well-known/agent-skills/index.json`
  const missing = new CliError('skill_not_found', `${host} has no skill ${ref.publisher}/${ref.skill}.`, EXIT.general, `Find it at ${site}/skills`)
  const entry = readIndex(await get(ctx, indexUrl, 'skill index', site, MAX_INDEX_BYTES, missing), indexUrl, ref, site)
  const { type, url, sha256 } = entry
  if (type === 'archive') {
    const body = await get(ctx, url, 'skill archive', site, MAX_ARCHIVE_BYTES)
    checkDigest(body, url, sha256)
    const read = readArchive(body, url, ref)
    return { entry, payload: { type, archive: read.archive }, meta: read.meta }
  }
  const body = await get(ctx, url, 'SKILL.md', site, MAX_SKILL_BYTES)
  checkDigest(body, url, sha256)
  return { entry, payload: { type, body }, meta: checkSkillMd(body, url, ref) }
}

/** `amdahl skills add <publisher>/<skill>`. */
export async function skillsAdd(ctx: Ctx, args: string[]): Promise<number> {
  if (args.length !== 1 || !args[0]) throw usageError(USAGE)
  const siteFlag = str(ctx.flags.site)
  const site = siteFlag ? normaliseSite(siteFlag) : DEFAULT_SKILLS_SITE
  const ref = parseSkillRef(args[0], site)
  const guided = shouldGuide(ctx)

  // Download and check everything first: nothing is written, and no question is asked, until it passes.
  // A person sees a line while that runs, since a folder skill can take a while.
  if (guided) ctx.io.stderr(`Checking ${ref.publisher}/${ref.skill} on ${new URL(site).host}... `)
  let fetched: Fetched
  try {
    fetched = await fetchSkill(ctx, ref, site)
  } catch (err) {
    if (guided) ctx.io.stderr('\n')
    throw err
  }
  if (guided) ctx.io.stderr('OK\n\n')
  const { entry, payload, meta } = fetched
  const { url, sha256 } = entry

  // A flagged skill: the warning is shown before any question or write, and only a yes goes on.
  const { warning } = entry
  if (warning) {
    if (!(await confirmWarning(ctx, ref, site, warning))) return EXIT.ok
    if (guided) ctx.out.info('')
  }

  const agent = runningAgent(ctx)
  let targets: Targets
  let seen: string[] = []
  let plan: FilePlan[]
  if (guided) {
    const summary: SkillSummary = { name: ref.skill, publisher: ref.publisher, version: entry.version ?? meta.version }
    // The agents in use, read now: the install itself creates the folders they are detected by.
    seen = agentsInUse(ctx).names
    const settled = await guide(ctx, summary, payload)
    targets = settled.targets
    plan = settled.plan
    if (settled.kind === 'kept') {
      ctx.out.info(`Kept your copy of ${ref.skill}. Nothing was written.`)
      return EXIT.ok
    }
    if (settled.kind === 'install') writeInstall(ctx.io, plan, ref.skill, payload)
  } else {
    // No questions: the flags say where; without --agents, the agent that ran this picks its own folder.
    const agentsFlag = ctx.flags.agents === true
    const cursorOnly = !agentsFlag && agent === 'cursor'
    targets = { base: ctx.flags.global === true ? ctx.io.homedir : ctx.io.cwd, claude: !cursorOnly, agents: agentsFlag || cursorOnly }
    plan = planInstall(skillDirs(targets, ref.skill), payload)
    refuseClashes(plan, ref.skill, ctx.flags.force === true)
    writeInstall(ctx.io, plan, ref.skill, payload)
  }

  const contents = payload.type === 'archive' ? payload.archive.files.map((f) => f.path) : undefined
  const count = contents ? ` (${contents.length} file${contents.length === 1 ? '' : 's'})` : ''
  const lines = plan.map((f) =>
    f.action === 'unchanged' ? `Already up to date: ${f.path}` : `${f.action === 'wrote' ? 'Wrote' : 'Replaced'} ${f.path}${count}`
  )
  if (contents && plan.some((f) => f.action !== 'unchanged')) lines.push(...contents.map((p) => `  ${p}`))
  const result = {
    ok: true,
    publisher: ref.publisher,
    skill: ref.skill,
    url,
    digest: `sha256:${sha256}`,
    files: plan,
    ...(warning ? { warning: warningJson(warning, site, ref) } : {}),
  }
  if (guided) {
    // A person gets the skills folders in the short form they would type; the file list is for scripts.
    const changed = plan.filter((f) => f.action !== 'unchanged')
    const done = changed.length > 0 ? `Done. Added to ${skillsFolders(ctx, changed)}.` : `Already up to date in ${skillsFolders(ctx, plan)}.`
    ctx.out.result(result, `\n${done}`)
    ctx.out.info(nextStep(ctx, targets, seen))
    return EXIT.ok
  }
  ctx.out.result(contents ? { ...result, contents } : result, lines.join('\n'))
  if (!ctx.out.json && ctx.flags.global !== true && ctx.flags.agents !== true && ctx.flags.yes !== true) ctx.out.info(defaultsNote(agent))
  return EXIT.ok
}
