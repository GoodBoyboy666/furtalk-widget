/**
 * 本地资料存储。
 *
 * 嵌入页面仅在本地的 localStorage 中保存用户填写的邮箱、昵称、网站 URL，
 * 并按 Furtalk 服务源与站点 ID 分别存放。
 * 不持久化任何评论草稿或凭据。
 * 存储不可用（隐私模式、配额限制、访问受限）时回退到内存存储。
 */

import type { ProfileHints } from './types'
import { isSupportedLanguage, type SupportedLanguage } from './i18n'

export const EMPTY_PROFILE_HINTS: ProfileHints = {
  email: '',
  nickname: '',
  website_url: '',
}

export interface ProfileStore {
  load(): ProfileHints
  save(hints: ProfileHints): void
}

/** 按 Furtalk 服务源与站点 id 区分存放的资料。 */
export function storageKey(serviceOrigin: string, siteId: string): string {
  return `furtalk:profile:${serviceOrigin}:${siteId}`
}

class MemoryProfileStore implements ProfileStore {
  private hints: ProfileHints = { ...EMPTY_PROFILE_HINTS }

  load(): ProfileHints {
    return { ...this.hints }
  }

  save(hints: ProfileHints): void {
    this.hints = {
      email: hints.email,
      nickname: hints.nickname,
      website_url: hints.website_url,
    }
  }
}

/** 安全地解析存储的 JSON 数据，出错也不抛异常。 */
function parseStored(raw: string | null): ProfileHints {
  if (!raw) return { ...EMPTY_PROFILE_HINTS }
  try {
    const parsed = JSON.parse(raw) as Partial<ProfileHints>
    return {
      email: typeof parsed.email === 'string' ? parsed.email : '',
      nickname: typeof parsed.nickname === 'string' ? parsed.nickname : '',
      website_url:
        typeof parsed.website_url === 'string' ? parsed.website_url : '',
    }
  } catch {
    return { ...EMPTY_PROFILE_HINTS }
  }
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export interface ProfileStoreStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * widget 自己的语言偏好键。在同一个嵌入源上，所有 widget 实例和站点共用；
 * 持久化范围由浏览器的同源存储规则决定。
 */
export const LANGUAGE_KEY = 'furtalk:language'

/** 安全地读取已存的语言偏好；任何失败都返回 null。 */
export function loadLanguage(
  storage?: ProfileStoreStorage | null,
): SupportedLanguage | null {
  const backend = storage === undefined ? safeStorage() : storage
  if (!backend) return null
  try {
    const raw = backend.getItem(LANGUAGE_KEY)
    return isSupportedLanguage(raw) ? raw : null
  } catch {
    return null
  }
}

/** 保存语言偏好；失败时该选择仅本次会话内生效。 */
export function saveLanguage(
  language: SupportedLanguage,
  storage?: ProfileStoreStorage | null,
): void {
  const backend = storage === undefined ? safeStorage() : storage
  if (!backend) return
  try {
    backend.setItem(LANGUAGE_KEY, language)
  } catch {
    // 存储不可用：本次会话仍应用该选择。
  }
}

export function createProfileStore(
  serviceOrigin: string,
  siteId: string,
  storage?: ProfileStoreStorage | null,
): ProfileStore {
  const memory = new MemoryProfileStore()
  const backend = storage === undefined ? safeStorage() : storage
  if (!backend) return memory
  const key = storageKey(serviceOrigin, siteId)
  return {
    load(): ProfileHints {
      try {
        return parseStored(backend.getItem(key))
      } catch {
        return memory.load()
      }
    },
    save(hints: ProfileHints): void {
      try {
        backend.setItem(key, JSON.stringify(hints))
      } catch {
        memory.save(hints)
      }
    },
  }
}
