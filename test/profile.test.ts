import { describe, expect, it } from 'vitest'

import {
  isHttpUrl,
  isValidEmail,
  normalizeNickname,
  normalizeWebsite,
  validateProfileHints,
} from '../src/profile'

describe('isValidEmail', () => {
  it('accepts ordinary addresses', () => {
    expect(isValidEmail('alice@example.com')).toBe(true)
    expect(isValidEmail(' a+b@sub.example.co ')).toBe(true)
  })

  it('rejects malformed addresses', () => {
    expect(isValidEmail('')).toBe(false)
    expect(isValidEmail('not-an-email')).toBe(false)
    expect(isValidEmail('a@')).toBe(false)
    expect(isValidEmail('@example.com')).toBe(false)
    expect(isValidEmail('a@b..com')).toBe(false)
  })
})

describe('normalizeNickname', () => {
  it('trims valid nicknames', () => {
    expect(normalizeNickname('  Alice  ')).toBe('Alice')
  })

  it('rejects empty and overlong nicknames', () => {
    expect(normalizeNickname('   ')).toBe('')
    expect(normalizeNickname('x'.repeat(101))).toBe('')
    expect(normalizeNickname('x'.repeat(100))).toBe('x'.repeat(100))
  })
})

describe('isHttpUrl / normalizeWebsite', () => {
  it('accepts absolute http(s) urls and empty values', () => {
    expect(isHttpUrl('https://blog.example.com')).toBe(true)
    expect(isHttpUrl('http://example.com')).toBe(true)
    expect(isHttpUrl('')).toBe(true)
  })

  it('rejects unsafe or relative destinations', () => {
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpUrl('ftp://example.com')).toBe(false)
    expect(isHttpUrl('/relative')).toBe(false)
    expect(normalizeWebsite('javascript:alert(1)')).toBe('')
  })

  it('normalizes to the trimmed url', () => {
    expect(normalizeWebsite('  https://blog.example.com  ')).toBe(
      'https://blog.example.com',
    )
  })
})

describe('validateProfileHints', () => {
  it('drops invalid values without throwing', () => {
    const result = validateProfileHints({
      email: 'not-an-email',
      nickname: '   ',
      website_url: 'javascript:alert(1)',
    })
    expect(result).toEqual({ email: '', nickname: '', website_url: '' })
  })

  it('keeps valid values', () => {
    const result = validateProfileHints({
      email: ' alice@example.com ',
      nickname: '  Alice  ',
      website_url: ' https://blog.example ',
    })
    expect(result).toEqual({
      email: 'alice@example.com',
      nickname: 'Alice',
      website_url: 'https://blog.example',
    })
  })
})
