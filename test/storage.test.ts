import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createProfileStore,
  EMPTY_PROFILE_HINTS,
  storageKey,
} from '../src/storage'

describe('storageKey', () => {
  it('namespaces by Furtalk service origin and site id', () => {
    expect(storageKey('https://comments.example', '42')).toBe(
      'furtalk:profile:https://comments.example:42',
    )
    expect(storageKey('https://comments.example', '7')).not.toBe(
      storageKey('https://comments.example', '42'),
    )
    expect(storageKey('https://comments.example', '42')).not.toBe(
      storageKey('https://other.example', '42'),
    )
  })
})

describe('createProfileStore', () => {
  let storage: Map<string, string>

  beforeEach(() => {
    storage = new Map()
  })

  it('round-trips hints through the provided storage', () => {
    const store = createProfileStore('https://comments.example', '42', {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    })
    expect(store.load()).toEqual(EMPTY_PROFILE_HINTS)
    store.save({
      email: 'a@b.example',
      nickname: 'Alice',
      website_url: 'https://blog.example',
    })
    expect(store.load()).toEqual({
      email: 'a@b.example',
      nickname: 'Alice',
      website_url: 'https://blog.example',
    })
    expect(storage.has('furtalk:profile:https://comments.example:42')).toBe(
      true,
    )
  })

  it('falls back to memory when storage access throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('quota')
      },
    }
    const store = createProfileStore('https://comments.example', '42', throwing)
    expect(() => store.load()).not.toThrow()
    store.save({ email: 'a@b.example', nickname: 'Alice', website_url: '' })
    expect(store.load().email).toBe('a@b.example')
  })

  it('falls back to memory when no storage exists', () => {
    const store = createProfileStore('https://comments.example', '42', null)
    store.save({ email: 'a@b.example', nickname: 'Alice', website_url: '' })
    expect(store.load()).toEqual({
      email: 'a@b.example',
      nickname: 'Alice',
      website_url: '',
    })
  })

  it('tolerates corrupt stored JSON', () => {
    const store = createProfileStore('https://comments.example', '42', {
      getItem: () => '{not json',
      setItem: () => {},
    })
    expect(store.load()).toEqual(EMPTY_PROFILE_HINTS)
  })

  it('uses real localStorage when available', () => {
    const setSpy = vi.fn()
    const getSpy = vi.fn(() => null)
    const store = createProfileStore('https://comments.example', '42', {
      getItem: getSpy,
      setItem: setSpy,
    })
    store.save({ email: 'a@b.example', nickname: 'Alice', website_url: '' })
    expect(setSpy).toHaveBeenCalledWith(
      'furtalk:profile:https://comments.example:42',
      expect.stringContaining('a@b.example'),
    )
  })
})
