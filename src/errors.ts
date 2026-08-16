/**
 * Normalized widget errors.
 *
 * Every failure surfaced by the widget (network, API envelope, session,
 * unsupported browser) is a WidgetError with a stable code the UI can branch
 * on for recoverable states.
 */

export type WidgetErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'invalid_input'
  | 'captcha_required'
  | 'captcha_failed'
  | 'captcha_unavailable'
  | 'thread_closed'
  | 'email_domain_not_allowed'
  | 'session_unavailable'
  | 'unsupported_browser'
  | 'network'
  | 'unknown'

export interface WidgetErrorOptions {
  message: string
  code?: WidgetErrorCode
  status?: number
  details?: Record<string, unknown>
}

export class WidgetError extends Error {
  readonly code: WidgetErrorCode
  readonly status?: number
  readonly details?: Record<string, unknown>

  constructor(options: WidgetErrorOptions) {
    super(options.message)
    this.name = 'WidgetError'
    this.code = options.code ?? 'unknown'
    this.status = options.status
    this.details = options.details
  }
}

/** Backend error envelope: {"error": {"code", "message", "request_id", "details"}}. */
interface ApiErrorEnvelope {
  error?: { code?: string; message?: string; details?: Record<string, unknown> }
}

/** Maps backend error envelope codes to stable widget codes. */
export function mapErrorCode(code: string): WidgetErrorCode {
  switch (code) {
    case 'invalid_request':
    case 'invalid_id':
    case 'invalid_request_body':
      return 'invalid_request'
    case 'unauthorized':
    case 'invalid_credentials':
      return 'unauthorized'
    case 'forbidden':
      return 'forbidden'
    case 'not_found':
      return 'not_found'
    case 'conflict':
    case 'thread_closed':
      return 'thread_closed'
    case 'invalid_input':
      return 'invalid_input'
    case 'email_domain_not_allowed':
      return 'email_domain_not_allowed'
    default:
      return 'unknown'
  }
}

/** Normalizes an API response body + status into a WidgetError. */
export function normalizeApiError(data: unknown, status: number): WidgetError {
  const envelope = (
    typeof data === 'object' && data !== null ? data : {}
  ) as ApiErrorEnvelope
  const code = envelope.error?.code ?? 'unknown'
  const message = envelope.error?.message ?? `request failed (${status})`
  const details = envelope.error?.details
  return new WidgetError({
    code: mapErrorCode(code),
    status,
    message,
    details,
  })
}

/** Normalizes any thrown value into a WidgetError, preserving existing codes. */
export function toWidgetError(error: unknown): WidgetError {
  if (error instanceof WidgetError) return error
  if (error instanceof Error) {
    return new WidgetError({ code: 'network', message: error.message })
  }
  return new WidgetError({ code: 'network', message: 'network request failed' })
}
