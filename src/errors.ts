/**
 * 规范化后的 widget 错误。
 *
 * widget 遇到的每一个失败（网络、API 返回、会话、浏览器不支持）都会被转换成
 * 携带稳定错误码的 WidgetError，UI 据此判断出错后如何处理（能否恢复）。
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

/** 后端错误信封：{"error": {"code", "message", "request_id", "details"}}。 */
interface ApiErrorEnvelope {
  error?: { code?: string; message?: string; details?: Record<string, unknown> }
}

/** 将后端错误信封代码映射为稳定的 widget 代码。 */
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

/** 将 API 响应体 + 状态码规范化为 WidgetError。 */
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

/** 将任意抛出的值规范化为 WidgetError，并保留已有代码。 */
export function toWidgetError(error: unknown): WidgetError {
  if (error instanceof WidgetError) return error
  if (error instanceof Error) {
    return new WidgetError({ code: 'network', message: error.message })
  }
  return new WidgetError({ code: 'network', message: 'network request failed' })
}
