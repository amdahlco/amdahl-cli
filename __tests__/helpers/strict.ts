// What the real server refuses, for the mock server to refuse too. The mock
// used to accept any body, so a request production rejects passed the tests
// (`amdahl sent r1 r2` has no send key, and the real report_send refuses it).
// Each rule below names the server rule it copies (2026-11-12); a change
// there belongs here too.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** zod's message for a strict object with keys it does not know. */
function unknownKeys(path: string, value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const extra = Object.keys(value).filter((k) => !allowed.includes(k))
  return extra.length ? [`${path}: Unrecognized key(s) in object: ${extra.map((k) => `'${k}'`).join(', ')}`] : []
}

// ── messages.optimize_batch: messages/_batchInput.ts, messageOptimizer/context.ts ──────────────

export const MAX_BATCH_ITEMS = 500
const BATCH_KEYS = ['items', 'webhook_url', 'idempotency_key']
const BATCH_ITEM_KEYS = ['item_id', 'message', 'channel', 'context', 'on_unsupported', 'evidence', 'on_missing_input', 'include_tries', 'recipient', 'recipient_notes', 'message_type', 'sender']
const CONTEXT_KEYS = ['rules', 'voice_examples', 'facts', 'keep_cta', 'max_words', 'banned_phrases', 'banned_punctuation']
const CONTEXT_LIMITS: Record<string, { maxItems: number; maxChars: number }> = {
  rules: { maxItems: 20, maxChars: 500 },
  voice_examples: { maxItems: 5, maxChars: 4000 },
  facts: { maxItems: 10, maxChars: 1000 },
  banned_phrases: { maxItems: 30, maxChars: 60 },
}

/** The refusals of a `context` block (messageOptimizer/context.ts): unknown keys, counts and lengths. `triggers` is not a key here. */
export function contextProblems(at: string, context: unknown, extraKeys: readonly string[] = []): string[] {
  if (!isObject(context)) return [`${at}: Expected object`]
  const errors = unknownKeys(at, context, [...CONTEXT_KEYS, ...extraKeys])
  for (const [key, limit] of Object.entries(CONTEXT_LIMITS)) {
    const list = context[key]
    if (list === undefined) continue
    if (!Array.isArray(list)) {
      errors.push(`${at}.${key}: Expected array`)
      continue
    }
    if (list.length > limit.maxItems) errors.push(`${at}.${key}: Array must contain at most ${limit.maxItems} element(s)`)
    list.forEach((entry, j) => {
      const text = key === 'rules' && isObject(entry) ? entry.text : entry
      if (typeof text !== 'string') errors.push(`${at}.${key}[${j}]: Expected string`)
      else if (text.trim().length > limit.maxChars) errors.push(`${at}.${key}[${j}]: String must contain at most ${limit.maxChars} character(s)`)
    })
  }
  return errors
}

// messageOptimizer/relationship.ts: priorTouchesSchema (2026-11-19).
const PRIOR_TOUCH_CHANNELS = ['email', 'linkedin', 'call', 'meeting', 'other']
const PRIOR_TOUCH_KEYS = ['on', 'channel', 'summary']

/** The refusals of `context.prior_touches`: at most 10 strict objects of a day, an optional channel and a summary of 1 to 500 characters once trimmed. */
function priorTouchProblems(at: string, touches: unknown): string[] {
  if (!Array.isArray(touches)) return [`${at}: Expected array`]
  const errors = touches.length > 10 ? [`${at}: Array must contain at most 10 element(s)`] : []
  touches.forEach((touch, j) => {
    const here = `${at}[${j}]`
    if (!isObject(touch)) return void errors.push(`${here}: Expected object`)
    errors.push(...unknownKeys(here, touch, PRIOR_TOUCH_KEYS))
    if (typeof touch.on !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(touch.on)) errors.push(`${here}.on: must be a day, YYYY-MM-DD`)
    if (touch.channel !== undefined && !PRIOR_TOUCH_CHANNELS.includes(String(touch.channel))) errors.push(`${here}.channel: Invalid enum value. Expected ${PRIOR_TOUCH_CHANNELS.map((c) => `'${c}'`).join(' | ')}, received '${String(touch.channel)}'`)
    const summary = typeof touch.summary === 'string' ? touch.summary.trim() : null
    if (summary === null) errors.push(`${here}.summary: Required`)
    else if (summary.length < 1) errors.push(`${here}.summary: String must contain at least 1 character(s)`)
    else if (summary.length > 500) errors.push(`${here}.summary: String must contain at most 500 character(s)`)
  })
  return errors
}

/** The refusals of the `context` of messages.optimize (optimizerContextSchema): the batch's keys, and `prior_touches`, `stage`, `offer`, `thread`, `triggers`. */
export function optimizeContextProblems(context: unknown, at = '$.context'): string[] {
  const errors = contextProblems(at, context, ['triggers', 'offer', 'thread', 'stage', 'prior_touches'])
  if (isObject(context) && context.prior_touches !== undefined) errors.push(...priorTouchProblems(`${at}.prior_touches`, context.prior_touches))
  return errors
}

// messageOptimizer/recipient.ts: recipientSchema (strict; attributes at most 100 string values of 1000 characters, keys of 100).
const RECIPIENT_KEYS = ['email', 'name', 'company', 'domain', 'linkedin_url', 'attributes']
const RECIPIENT_LIMITS: Record<string, number> = { email: 320, name: 200, company: 200, domain: 253, linkedin_url: 300 }

/** The refusals of an item's `recipient`: unknown keys, string lengths and the attributes. */
function recipientProblems(at: string, recipient: unknown): string[] {
  if (!isObject(recipient)) return [`${at}: Expected object`]
  const errors = unknownKeys(at, recipient, RECIPIENT_KEYS)
  for (const [key, max] of Object.entries(RECIPIENT_LIMITS)) {
    const value = recipient[key]
    if (value === undefined) continue
    if (typeof value !== 'string') errors.push(`${at}.${key}: Expected string`)
    else if (value.length > max) errors.push(`${at}.${key}: String must contain at most ${max} character(s)`)
  }
  const attributes = recipient.attributes
  if (attributes !== undefined) {
    if (!isObject(attributes)) errors.push(`${at}.attributes: Expected object`)
    else {
      if (Object.keys(attributes).length > 100) errors.push(`${at}.attributes: must have at most 100 entries`)
      for (const [key, value] of Object.entries(attributes)) {
        if (key.length > 100) errors.push(`${at}.attributes.${key.slice(0, 20)}: key must be at most 100 characters`)
        if (typeof value !== 'string') errors.push(`${at}.attributes.${key}: Expected string`)
        else if (value.length > 1000) errors.push(`${at}.attributes.${key}: String must contain at most 1000 character(s)`)
      }
    }
  }
  return errors
}

/** True when `context` holds something a message can be written from (contextFirst.hasWritableContext): facts, rules, voice examples or earlier touches. */
function writable(context: unknown): boolean {
  if (!isObject(context)) return false
  return ['facts', 'rules', 'voice_examples', 'prior_touches'].some((key) => {
    const list = context[key]
    return Array.isArray(list) && list.some((entry) => (typeof entry === 'string' ? entry.trim() : entry) !== '')
  })
}

/** The refusals of a batch body, as paths (`$.items[3].channel: ...`), at most 20. */
export function batchProblems(input: unknown): string[] {
  if (!isObject(input)) return ['$: Expected object']
  const errors = unknownKeys('$', input, BATCH_KEYS)
  const items = input.items
  if (!Array.isArray(items)) return [...errors, '$.items: Required']
  if (items.length < 1) errors.push('$.items: Array must contain at least 1 element(s)')
  if (items.length > MAX_BATCH_ITEMS) errors.push(`$.items: Array must contain at most ${MAX_BATCH_ITEMS} element(s)`)
  const seen = new Map<string, number>()
  items.forEach((item, i) => {
    const at = `$.items[${i}]`
    if (!isObject(item)) return void errors.push(`${at}: Expected object`)
    errors.push(...unknownKeys(at, item, BATCH_ITEM_KEYS))
    // An item needs a draft, or something to write from (messageOptimizer/contextFirst.missingInput; _batchInput.refuseMissingInput): facts, rules, voice examples, earlier touches or a recipient.
    if (item.message === undefined) {
      if (!writable(item.context) && !(isObject(item.recipient) && Object.keys(item.recipient).length > 0)) errors.push(`${at}.message: Required`)
    } else if (typeof item.message !== 'string') errors.push(`${at}.message: Expected string`)
    else if (item.message.length > 10_000) errors.push(`${at}.message: String must contain at most 10000 character(s)`)
    if (item.item_id !== undefined) {
      if (typeof item.item_id !== 'string' || item.item_id.trim().length < 1 || item.item_id.trim().length > 200) errors.push(`${at}.item_id: String must contain 1 to 200 character(s)`)
      else if (seen.has(item.item_id.trim())) errors.push(`${at}.item_id: is also the item_id of $.items[${seen.get(item.item_id.trim())}]`)
      else seen.set(item.item_id.trim(), i)
    }
    const enums: [string, string[]][] = [['channel', ['email', 'linkedin']], ['evidence', ['workspace', 'off']], ['on_unsupported', ['flag', 'remove']], ['on_missing_input', ['best_effort', 'ask']]]
    for (const [key, allowed] of enums) {
      if (item[key] !== undefined && !allowed.includes(String(item[key]))) errors.push(`${at}.${key}: Invalid enum value. Expected ${allowed.map((a) => `'${a}'`).join(' | ')}, received '${String(item[key])}'`)
    }
    if (item.include_tries !== undefined && typeof item.include_tries !== 'boolean') errors.push(`${at}.include_tries: Expected boolean`)
    if (item.context !== undefined) errors.push(...optimizeContextProblems(item.context, `${at}.context`))
    if (item.recipient !== undefined) errors.push(...recipientProblems(`${at}.recipient`, item.recipient))
  })
  return errors.slice(0, 20)
}

// ── messages.record_feedback: messages/recordFeedback.ts ─────────────────────────────────────

/** The refusal of a feedback body, or null. */
export function feedbackProblem(input: unknown): string | null {
  if (!isObject(input)) return 'Invalid input.'
  if (!['did_it_myself', 'reported_to_me', 'inferred'].includes(String(input.evidence))) return 'evidence: Invalid enum value.'
  if (input.outcome !== undefined && !['used', 'used_with_edits', 'not_used', 'unsure'].includes(String(input.outcome))) return 'outcome: Invalid enum value.'
  if (input.comment !== undefined && (typeof input.comment !== 'string' || input.comment.length > 2000)) return 'comment: String must contain at most 2000 character(s)'
  if (input.sent_text !== undefined && (typeof input.sent_text !== 'string' || input.sent_text.length > 10_000)) return 'sent_text: String must contain at most 10000 character(s)'
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)
  if (!text(input.sent_text) && !text(input.comment) && !input.outcome) return 'Send at least one of sent_text, comment or outcome.'
  return null
}

// ── feedback.record: operations/implementations/feedback/recordFeedback.ts (2026-11-19) ────────

const RATING_KEYS = ['answer_id', 'surface', 'rating', 'comment', 'email_ok', 'subject_id', 'research_id', 'search_query_id', 'client', 'client_version', 'question', 'route']

/** The strict-schema refusal of a feedback.record body (a 400), or null. */
export function ratingProblem(input: unknown): string | null {
  if (!isObject(input)) return 'body: Invalid input.'
  const extra = Object.keys(input).find((k) => !RATING_KEYS.includes(k))
  if (extra) return `${extra}: Unrecognized key`
  if (typeof input.answer_id !== 'string' || !input.answer_id.trim() || input.answer_id.length > 80) return 'answer_id: Invalid'
  if (!['search', 'research', 'optimize', 'grade', 'lead_list', 'other'].includes(String(input.surface))) return 'surface: Invalid enum value.'
  if (!['up', 'down'].includes(String(input.rating))) return 'rating: Invalid enum value.'
  if (input.comment !== undefined && (typeof input.comment !== 'string' || input.comment.length > 2000)) return 'comment: String must contain at most 2000 character(s)'
  if (input.email_ok !== undefined && typeof input.email_ok !== 'boolean') return 'email_ok: Expected boolean'
  if (input.client !== undefined && !['cli', 'api'].includes(String(input.client))) return 'client: Invalid enum value.'
  if (input.client_version !== undefined && (typeof input.client_version !== 'string' || input.client_version.length > 64)) return 'client_version: Invalid'
  return null
}

// ── messages.report_send: messages/_reportSendSchema.ts, messageOptimizer/sendReports ────────

// The server's send providers (2026-11-13).
export const SEND_PROVIDERS = ['lemlist', 'instantly', 'outreach', 'salesloft', 'hubspot', 'salesforce', 'gmail', 'heyreach', 'apollo', 'smartlead', 'reply_io', 'lgm', 'woodpecker', 'amplemarket', 'linkedin_manual', 'other']
export const SEND_CHANNELS = ['email', 'linkedin_invite', 'linkedin_message', 'linkedin_inmail']
const REPORT_KEYS = ['run_id', 'provider', 'channel', 'sent_as', 'sent_at', 'provider_send_id', 'provider_campaign_id', 'sequence_step', 'provider_variant_id', 'provider_lead_id', 'thread_id', 'recipient', 'recipient_key_hash', 'sent_text']
const TEXT_LIMITS: Record<string, number> = { provider_send_id: 256, provider_campaign_id: 256, provider_variant_id: 256, provider_lead_id: 256, thread_id: 512, recipient: 512, sent_text: 10_000 }
const SENT_AT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d(:?\d\d)?)$/
const EMAIL = /^(?:mailto:)?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/i
const LINKEDIN = /linkedin\.com\/(?:in|pub|sales\/(?:lead|people))\//i
const MAX_SEND_REPORTS = 100
const FUTURE_SKEW_MS = 10 * 60 * 1000
const BEFORE_RUN_SKEW_MS = 5 * 60 * 1000

/** The strict-schema refusal of a report_send body (a 400 for the whole call), or null. */
export function reportSendProblem(input: unknown): string | null {
  if (!isObject(input)) return 'items: Required'
  const top = unknownKeys('', input, ['items'])
  if (top.length) return top[0]!.replace(/^: /, '')
  const items = input.items
  if (!Array.isArray(items)) return 'items: Required'
  if (items.length < 1 || items.length > MAX_SEND_REPORTS) return `items: Array must contain 1 to ${MAX_SEND_REPORTS} element(s)`
  for (const [i, item] of items.entries()) {
    const at = `items.${i}`
    if (!isObject(item)) return `${at}: Expected object`
    const extra = unknownKeys(at, item, REPORT_KEYS)
    if (extra.length) return extra[0]!
    for (const key of ['run_id', 'provider', 'channel', 'sent_as', 'sent_at']) if (item[key] === undefined) return `${at}.${key}: Required`
    if (typeof item.run_id !== 'string' || !UUID.test(item.run_id)) return `${at}.run_id: Invalid uuid`
    if (!SEND_PROVIDERS.includes(String(item.provider))) return `${at}.provider: Invalid enum value`
    if (!SEND_CHANNELS.includes(String(item.channel))) return `${at}.channel: Invalid enum value`
    if (!['returned', 'edited'].includes(String(item.sent_as))) return `${at}.sent_as: Invalid enum value`
    if (typeof item.sent_at !== 'string' || !SENT_AT.test(item.sent_at)) return `${at}.sent_at: Invalid datetime`
    for (const [key, max] of Object.entries(TEXT_LIMITS)) {
      const v = item[key]
      if (v === undefined) continue
      if (typeof v !== 'string' || v.length > max) return `${at}.${key}: String must contain at most ${max} character(s)`
      if (v.includes('\u0000')) return `${at}.${key}: must not contain a NUL character`
    }
    if (item.recipient_key_hash !== undefined && (typeof item.recipient_key_hash !== 'string' || item.recipient_key_hash.length > 64)) return `${at}.recipient_key_hash: String must contain at most 64 character(s)`
    if (item.sequence_step !== undefined && (!Number.isInteger(item.sequence_step) || (item.sequence_step as number) < 0 || (item.sequence_step as number) > 1000)) return `${at}.sequence_step: Number must be between 0 and 1000`
  }
  return null
}

/**
 * The per-item rejection a valid body can still get (a 200 with `status: rejected`), in the
 * order `prepare` in sendReports/index.ts checks them, or null. `runCreatedAt` is when the
 * run was made, or undefined for a run this workspace does not have.
 */
export function reportSendRejection(item: Record<string, unknown>, now: number, runCreatedAt: number | undefined): { reason: string; message: string } | null {
  const s = (key: string) => (typeof item[key] === 'string' ? (item[key] as string) : undefined)
  const sendId = s('provider_send_id')
  if (item.provider === 'gmail' && sendId !== undefined && !/^<[^<>\s]+>$/.test(sendId.trim())) {
    return { reason: 'invalid_provider_id', message: 'provider_send_id: for gmail, send the Message-ID header with its angle brackets, such as <abc@mail.gmail.com>.' }
  }
  for (const key of ['provider_send_id', 'provider_campaign_id', 'provider_variant_id', 'provider_lead_id', 'thread_id']) {
    const v = s(key)
    if (v !== undefined && (EMAIL.test(v.trim()) || LINKEDIN.test(v.trim()))) {
      return { reason: 'invalid_provider_id', message: `${key}: send the provider's own id, not an email address or a LinkedIn profile URL.` }
    }
  }
  let hasRecipient = false
  const recipient = s('recipient')
  // The server refuses both: recipientHashOf in sendReports/index.ts.
  if (recipient?.trim() && s('recipient_key_hash')?.trim()) return { reason: 'invalid_recipient', message: 'Send recipient or recipient_key_hash, not both.' }
  if (recipient?.trim()) {
    const ok = item.channel === 'email' ? EMAIL.test(recipient.trim()) : LINKEDIN.test(recipient.trim())
    if (!ok) return { reason: 'invalid_recipient', message: `recipient: send ${item.channel === 'email' ? 'an email address' : 'a LinkedIn profile URL'} for this channel.` }
    hasRecipient = true
  } else if (s('recipient_key_hash')?.trim()) {
    if (!/^[0-9a-f]{64}$/i.test(s('recipient_key_hash')!.trim())) return { reason: 'invalid_recipient', message: 'recipient_key_hash: 64 hexadecimal characters (SHA-256).' }
    hasRecipient = true
  }
  if (!sendId?.trim() && !hasRecipient) return { reason: 'missing_send_key', message: 'Send provider_send_id, or recipient (or recipient_key_hash) with sent_at.' }
  const sentAt = Date.parse(String(item.sent_at))
  if (sentAt > now + FUTURE_SKEW_MS) return { reason: 'sent_at_in_future', message: 'sent_at is in the future.' }
  if (sentAt < Date.UTC(2000, 0, 1)) return { reason: 'sent_at_too_old', message: 'sent_at is before 2000-01-01.' }
  if (runCreatedAt === undefined) return { reason: 'run_not_found', message: 'No optimize run with this run_id in this workspace.' }
  if (sentAt < runCreatedAt - BEFORE_RUN_SKEW_MS) return { reason: 'sent_at_before_run', message: 'sent_at is before the run was made.' }
  return null
}

// ── search.query: search/query.ts ─────────────────────────────────────────────────────────────

/** The refusal of a search body, or null. */
export function searchProblem(input: unknown, recipeIds: string[] | null = null): string | null {
  if (!isObject(input)) return 'Invalid search request: Expected object'
  // `recipe_id` is a library id, and a server whose library route is absent does not take it (recipeIds null).
  if (input.recipe_id !== undefined) {
    if (recipeIds === null) return 'Invalid search request: Unrecognized key: recipe_id'
    if (typeof input.recipe_id !== 'string' || !recipeIds.includes(input.recipe_id)) return '`recipe_id` must be the id of a recipe in the library: read search.suggestions for the list.'
  }
  if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 10_000)) return 'Invalid search request: query: String must contain at most 10000 character(s)'
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || (input.limit as number) < 1)) return 'Invalid search request: limit: Number must be greater than 0'
  if (input.route !== undefined && !['auto', 'search', 'research'].includes(String(input.route))) return 'Invalid search request: route: Invalid enum value'
  // search/query.ts: `from_query_id` is a uuid (the query_id of the answer whose research offer was taken).
  if (input.from_query_id !== undefined && (typeof input.from_query_id !== 'string' || !UUID.test(input.from_query_id))) return 'Invalid search request: from_query_id: Invalid uuid'
  if (input.answer !== undefined && typeof input.answer !== 'boolean') return 'Invalid search request: answer: Expected boolean'
  if (!(typeof input.query === 'string' && input.query.trim())) return 'Provide a `query`, `filters`, or a `group_by`+`metrics` aggregation: an empty request has nothing to run.'
  return null
}

// ── messages.optimize, mode grade: messages/_optimizeInput.ts (readMode) ─────────────────────────

const OPTIMIZE_KEYS = ['context', 'message', 'channel', 'evidence', 'on_unsupported', 'on_missing_input', 'include_tries', 'recipient', 'recipient_notes', 'message_type', 'sender', 'mode', 'grade_nonce']

/** The refusals of an optimize body that the mock must also refuse (a 400 `invalid_input`), as paths. */
export function optimizeProblems(input: unknown): string[] {
  if (!isObject(input)) return ['$: Expected object']
  const errors = unknownKeys('$', input, OPTIMIZE_KEYS)
  if (input.message !== undefined && (typeof input.message !== 'string' || input.message.length > 10_000)) errors.push('$.message: String must contain at most 10000 character(s)')
  const enums: [string, string[]][] = [['channel', ['email', 'linkedin']], ['evidence', ['workspace', 'off']], ['on_unsupported', ['flag', 'remove']], ['on_missing_input', ['best_effort', 'ask']]]
  for (const [key, allowed] of enums) {
    if (input[key] !== undefined && !allowed.includes(String(input[key]))) errors.push(`$.${key}: Invalid enum value. Expected ${allowed.map((a) => `'${a}'`).join(' | ')}, received '${String(input[key])}'`)
  }
  if (input.mode !== undefined && input.mode !== 'improve' && input.mode !== 'grade') return [...errors, '$.mode: must be one of improve, grade']
  if (input.context !== undefined) errors.push(...optimizeContextProblems(input.context))
  // contextFirst.ts: an empty message is accepted when the context has something to write from; constraints alone are not.
  if (input.mode !== 'grade' && !(typeof input.message === 'string' && input.message.trim()) && !writable(input.context)) {
    errors.push('$.context: send what you know about the recipient. context.facts is the message; context.rules is what it must and must not do.')
  }
  if (input.mode === 'grade') {
    if (typeof input.message !== 'string' || !input.message.trim()) errors.push('$.message: mode grade grades a draft, so message is required')
    if (input.include_tries === true) errors.push('$.include_tries: mode grade writes no versions to return')
    if (input.on_missing_input === 'ask') errors.push('$.on_missing_input: mode grade asks no questions')
  } else if (input.grade_nonce !== undefined) errors.push('$.grade_nonce: only with mode grade')
  return errors
}

// ── messages.optimize_prompt: messages/_optimizePromptSchema.ts, _promptRecipients.ts ────────────

const PROMPT_KEYS = ['prompt', 'mode', 'recipients', 'channel', 'context', 'idempotency_key', 'sender']
const RECIPIENT_ITEM_KEYS = ['recipient', 'recipient_notes', 'label']
export const MAX_PROMPT_CHARS = 20_000

/** The refusals of an optimize_prompt body (a 400 `invalid_input`), as paths. */
export function promptProblems(input: unknown): string[] {
  if (!isObject(input)) return ['$: Expected object']
  const errors = unknownKeys('$', input, PROMPT_KEYS)
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) errors.push('$.prompt: Required')
  else if (input.prompt.length > MAX_PROMPT_CHARS) errors.push(`$.prompt: String must contain at most ${MAX_PROMPT_CHARS} character(s)`)
  if (input.mode !== undefined && input.mode !== 'improve' && input.mode !== 'grade') errors.push('$.mode: Invalid enum value. Expected \'improve\' | \'grade\'')
  if (input.channel !== undefined && !['email', 'linkedin'].includes(String(input.channel))) errors.push('$.channel: Invalid enum value')
  if (input.context !== undefined) errors.push(...contextProblems('$.context', input.context))
  if (input.idempotency_key !== undefined && (typeof input.idempotency_key !== 'string' || input.idempotency_key.length > 200)) errors.push('$.idempotency_key: String must contain at most 200 character(s)')
  if (input.sender !== undefined) {
    // messages/_sender.ts: a strict object with an email (at most 320) or a name (1 to 200), at least one.
    const sender = input.sender
    if (!isObject(sender)) errors.push('$.sender: Expected object')
    else {
      errors.push(...unknownKeys('$.sender', sender, ['email', 'name']))
      if (sender.email === undefined && sender.name === undefined) errors.push('$.sender: name an email or a name')
      if (sender.email !== undefined && (typeof sender.email !== 'string' || sender.email.length > 320 || !EMAIL.test(sender.email.trim()))) errors.push('$.sender.email: Invalid email')
      if (sender.name !== undefined && (typeof sender.name !== 'string' || !sender.name.trim() || sender.name.trim().length > 200)) errors.push('$.sender.name: String must contain 1 to 200 character(s)')
    }
  }
  if (input.recipients !== undefined) {
    if (!Array.isArray(input.recipients)) errors.push('$.recipients: must be an array')
    else {
      const n = input.recipients.length
      if (n < 1 || n > 6) errors.push('$.recipients: Array must contain 1 to 6 element(s)')
      else if (n < 2 && input.mode !== 'grade') errors.push('$.recipients: improve needs at least 2 recipients')
      input.recipients.forEach((item, i) => {
        const at = `$.recipients[${i}]`
        if (!isObject(item)) return void errors.push(`${at}: Expected object`)
        errors.push(...unknownKeys(at, item, RECIPIENT_ITEM_KEYS))
        // messages/_promptRecipients.ts: label is trimmed, 1 to MAX_LABEL_CHARS (200).
        if (item.label !== undefined && (typeof item.label !== 'string' || !item.label.trim() || item.label.trim().length > 200)) errors.push(`${at}.label: String must contain 1 to 200 character(s)`)
        if (!isObject(item.recipient) || Object.keys(item.recipient).length === 0) errors.push(`${at}.recipient: name a person or a company`)
      })
    }
  }
  return errors
}
