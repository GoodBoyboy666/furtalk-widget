import { describe, expect, it } from 'vitest'

import { canRenderCaptcha } from '../src/captcha'
import type { CaptchaProjection } from '../src/types'

function projection(overrides?: Partial<CaptchaProjection>): CaptchaProjection {
  return { required: false, ...overrides }
}

describe('canRenderCaptcha', () => {
  it('returns false when not required', () => {
    expect(canRenderCaptcha(projection())).toBe(false)
    expect(canRenderCaptcha(projection({ required: false, provider: 'turnstile', site_key: 'k' }))).toBe(false)
  })

  it('returns false when provider data is missing', () => {
    expect(canRenderCaptcha(projection({ required: true }))).toBe(false)
    expect(canRenderCaptcha(projection({ required: true, provider: 'turnstile' }))).toBe(false)
    expect(canRenderCaptcha(projection({ required: true, site_key: 'k' }))).toBe(false)
  })

  it('accepts supported providers', () => {
    for (const provider of ['turnstile', 'recaptcha', 'hcaptcha', 'cap']) {
      expect(canRenderCaptcha(projection({ required: true, provider, site_key: 'k' }))).toBe(true)
    }
  })

  it('rejects unknown providers (treated as not required)', () => {
    expect(canRenderCaptcha(projection({ required: true, provider: 'evil', site_key: 'k' }))).toBe(false)
  })
})
