// src/errors.ts
//
// The one error type every command throws, and the exit-code map. Exit codes
// are a frozen interface: scripts and end-to-end test harnesses branch on
// them, so a code never changes meaning.

/** Process exit codes. */
export const EXIT = {
  ok: 0,
  general: 1,
  usage: 2,
  unauthenticated: 3,
  forbidden: 4,
  noWorkspace: 5,
  rateLimited: 6,
  denied: 7,
  network: 8,
} as const

/** One of the {@link EXIT} values. */
export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/**
 * A failure the CLI reports and exits on. `code` is the stable machine code
 * printed in `--json` output; `message` is the human sentence; `hint` is an
 * optional next step.
 */
export class CliError extends Error {
  readonly code: string
  readonly exit: ExitCode
  readonly hint?: string

  constructor(code: string, message: string, exit: ExitCode, hint?: string) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.exit = exit
    this.hint = hint
  }
}

/** A usage error (exit 2). */
export function usageError(message: string, hint?: string): CliError {
  return new CliError('usage', message, EXIT.usage, hint)
}

/** The message every command prints when no credential is found. */
export const NOT_SIGNED_IN = 'Not signed in. Run `amdahl login`, or set AMDAHL_KEY.'

/** Server codes that always mean a specific exit, whatever the status. */
const CODE_EXITS: Record<string, ExitCode> = {
  oauth_required: EXIT.forbidden,
  cli_client_required: EXIT.forbidden,
  not_admin: EXIT.forbidden,
  scope_denied: EXIT.forbidden,
  missing_scope: EXIT.forbidden,
  role_too_low: EXIT.forbidden,
  invalid_grant: EXIT.unauthenticated,
  no_business: EXIT.noWorkspace,
  too_many_pending: EXIT.rateLimited,
  rate_limited: EXIT.rateLimited,
  quota_exceeded: EXIT.rateLimited,
  quota_exhausted: EXIT.rateLimited,
  request_denied: EXIT.denied,
  request_expired: EXIT.denied,
}

/**
 * Map an HTTP status (and the server's error code, when it sent one) to an
 * exit code. A known code wins over the status.
 *
 * @param status - the HTTP status; 0 for a transport failure.
 * @param code - the server's machine code, when present.
 */
export function exitForHttp(status: number, code?: string): ExitCode {
  if (code && CODE_EXITS[code] !== undefined) return CODE_EXITS[code]
  if (status === 0 || status >= 500) return EXIT.network
  if (status === 401) return EXIT.unauthenticated
  if (status === 403) return EXIT.forbidden
  if (status === 429) return EXIT.rateLimited
  if (status === 410) return EXIT.denied
  return EXIT.general
}
