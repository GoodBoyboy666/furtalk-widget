/**
 * Profile hint validation and normalization.
 *
 * Mirrors the backend public rules for immediate feedback; the server remains
 * authoritative. Invalid hints are never sent to first-party login or applied
 * as profile values.
 */

import type { ProfileHints } from './types'

export const MAX_NICKNAME_LENGTH = 100

/** Reports whether the value is a valid email address. */
export function isValidEmail(raw: string): boolean {
  const value = raw.trim()
  if (value === '' || value.length > 254) return false
  // Minimal structural check matching the backend net/mail rules closely enough
  // for client-side feedback; the server normalizes authoritatively.
  const at = value.lastIndexOf('@')
  if (at <= 0 || at === value.length - 1) return false
  const domain = value.slice(at + 1)
  if (!/^[a-z0-9.-]+$/i.test(domain)) return false
  return !domain.includes('..')
}

/** Normalizes a nickname: trims and rejects empty/overlong values. */
export function normalizeNickname(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.length > MAX_NICKNAME_LENGTH) return ''
  return trimmed
}

/** Reports whether the value is an absolute http(s) URL (empty is allowed). */
export function isHttpUrl(raw: string): boolean {
  const trimmed = raw.trim()
  if (trimmed === '') return true
  try {
    const url = new URL(trimmed)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/** Normalizes a website URL; returns '' when empty or invalid. */
export function normalizeWebsite(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  if (!isHttpUrl(trimmed)) return ''
  return trimmed
}

export interface ValidationResult {
  email: string
  nickname: string
  website_url: string
}

/**
 * Validates raw profile input and returns the safe values to store/send.
 * Invalid values are dropped (never block authorization or login).
 */
export function validateProfileHints(raw: ProfileHints): ValidationResult {
  return {
    email: isValidEmail(raw.email) ? raw.email.trim() : '',
    nickname: normalizeNickname(raw.nickname),
    website_url: normalizeWebsite(raw.website_url),
  }
}
