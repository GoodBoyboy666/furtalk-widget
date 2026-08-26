/**
 * Local profile storage.
 *
 * The embedding page stores only user-entered email/nickname/website URL in its
 * own Origin's localStorage, namespaced by Furtalk service origin and site ID.
 * No comment draft or credential is persisted. Storage failures (private mode,
 * quota, blocked access) fall back to an in-memory store.
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

/** Namespaces stored hints by Furtalk service origin and site id. */
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

/** Parses a stored JSON payload defensively, never throwing. */
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
 * Widget-owned language preference key. Shared across widget instances and
 * sites on the same embedding origin; the browser's same-origin storage rules
 * define the persistence boundary.
 */
export const LANGUAGE_KEY = 'furtalk:language'

/** Reads the stored language preference defensively; null on any failure. */
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

/** Persists the language preference; failures degrade to in-memory behavior. */
export function saveLanguage(
  language: SupportedLanguage,
  storage?: ProfileStoreStorage | null,
): void {
  const backend = storage === undefined ? safeStorage() : storage
  if (!backend) return
  try {
    backend.setItem(LANGUAGE_KEY, language)
  } catch {
    // Storage unavailable: the selection still applies for this session.
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
