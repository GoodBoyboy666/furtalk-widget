import { describe, expect, it } from 'vitest'

import {
  WidgetError,
  mapErrorCode,
  normalizeApiError,
  toWidgetError,
} from '../src/errors'

describe('mapErrorCode', () => {
  it('maps known backend codes to stable widget codes', () => {
    expect(mapErrorCode('invalid_input')).toBe('invalid_input')
    expect(mapErrorCode('invalid_credentials')).toBe('unauthorized')
    expect(mapErrorCode('forbidden')).toBe('forbidden')
    expect(mapErrorCode('not_found')).toBe('not_found')
    expect(mapErrorCode('thread_closed')).toBe('thread_closed')
    expect(mapErrorCode('email_domain_not_allowed')).toBe(
      'email_domain_not_allowed',
    )
    expect(mapErrorCode('conflict')).toBe('thread_closed')
    expect(mapErrorCode('invalid_id')).toBe('invalid_request')
  })

  it('falls back to unknown', () => {
    expect(mapErrorCode('whatever')).toBe('unknown')
  })
})

describe('normalizeApiError', () => {
  it('extracts the error envelope', () => {
    const error = normalizeApiError(
      { error: { code: 'thread_closed', message: '评论区已关闭' } },
      409,
    )
    expect(error.code).toBe('thread_closed')
    expect(error.message).toBe('评论区已关闭')
    expect(error.status).toBe(409)
    expect(error).toBeInstanceOf(WidgetError)
  })

  it('falls back to status message when the body is not an envelope', () => {
    const error = normalizeApiError('<html>proxy error</html>', 502)
    expect(error.code).toBe('unknown')
    expect(error.status).toBe(502)
    expect(error.message).toContain('502')
  })
})

describe('toWidgetError', () => {
  it('preserves existing WidgetError', () => {
    const original = new WidgetError({ code: 'forbidden', message: 'nope' })
    expect(toWidgetError(original)).toBe(original)
  })

  it('wraps generic errors as network', () => {
    const error = toWidgetError(new TypeError('failed to fetch'))
    expect(error.code).toBe('network')
    expect(error.message).toContain('failed to fetch')
  })

  it('wraps unknown values', () => {
    expect(toWidgetError('boom').code).toBe('network')
  })
})
