/**
 * 资料提示的校验与规范化。
 *
 * 校验规则与后端公开规则保持一致，用于即时反馈；最终仍以服务端为准。
 * 无效资料绝不会传给第一方登录，也不会作为资料保存。
 */

import type { ProfileHints } from './types'

export const MAX_NICKNAME_LENGTH = 100

/** 报告值是否为有效的邮箱地址。 */
export function isValidEmail(raw: string): boolean {
  const value = raw.trim()
  if (value === '' || value.length > 254) return false
  // 一个与后端邮箱校验（net/mail）接近的最小结构检查，用于客户端即时反馈；
  // 服务端仍负责最终校验。
  const at = value.lastIndexOf('@')
  if (at <= 0 || at === value.length - 1) return false
  const domain = value.slice(at + 1)
  if (!/^[a-z0-9.-]+$/i.test(domain)) return false
  return !domain.includes('..')
}

/** 规范化昵称：去除首尾空格，并拒绝空值/超长值。 */
export function normalizeNickname(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.length > MAX_NICKNAME_LENGTH) return ''
  return trimmed
}

/** 报告值是否为绝对 http(s) URL（允许为空）。 */
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

/** 规范化网站 URL；为空或无效时返回 ''。 */
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
 * 校验原始资料输入，并返回安全的待存储/发送值。
 * 无效值会被丢弃（绝不阻断授权或登录）。
 */
export function validateProfileHints(raw: ProfileHints): ValidationResult {
  return {
    email: isValidEmail(raw.email) ? raw.email.trim() : '',
    nickname: normalizeNickname(raw.nickname),
    website_url: normalizeWebsite(raw.website_url),
  }
}
