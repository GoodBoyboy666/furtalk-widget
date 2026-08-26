import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  catalogKeys,
  FALLBACK_LANGUAGE,
  formatRelativeTime,
  isSupportedLanguage,
  localMessage,
  normalizeLanguage,
  prefixMessage,
  rawMessage,
  renderMessage,
  resolveLanguage,
  SUPPORTED_LANGUAGES,
  translate,
} from '../src/i18n'

describe('supported languages and fallback', () => {
  it('declares zh-CN and en with an English fallback', () => {
    expect(SUPPORTED_LANGUAGES).toEqual(['zh-CN', 'en'])
    expect(FALLBACK_LANGUAGE).toBe('en')
    expect(isSupportedLanguage('zh-CN')).toBe(true)
    expect(isSupportedLanguage('en')).toBe(true)
    expect(isSupportedLanguage('zh-TW')).toBe(false)
    expect(isSupportedLanguage('fr')).toBe(false)
  })
})

describe('catalog parity', () => {
  it('keeps identical key sets across both locales', () => {
    const zh = [...catalogKeys('zh-CN')].sort()
    const en = [...catalogKeys('en')].sort()
    expect(en).toEqual(zh)
  })

  it('resolves every key to non-empty text in both locales', () => {
    for (const key of catalogKeys('zh-CN')) {
      expect(translate('zh-CN', key).trim()).not.toBe('')
      expect(translate('en', key).trim()).not.toBe('')
    }
  })
})

describe('normalizeLanguage', () => {
  it('normalizes zh-* to zh-CN and en-* to en', () => {
    expect(normalizeLanguage('zh-CN')).toBe('zh-CN')
    expect(normalizeLanguage('zh-TW')).toBe('zh-CN')
    expect(normalizeLanguage('zh-Hant')).toBe('zh-CN')
    expect(normalizeLanguage('en-US')).toBe('en')
    expect(normalizeLanguage('en-GB')).toBe('en')
    expect(normalizeLanguage('en')).toBe('en')
  })

  it('rejects unsupported or empty tags', () => {
    expect(normalizeLanguage('fr')).toBeNull()
    expect(normalizeLanguage('ja')).toBeNull()
    expect(normalizeLanguage('')).toBeNull()
    expect(normalizeLanguage(null)).toBeNull()
    expect(normalizeLanguage(undefined)).toBeNull()
  })
})

describe('resolveLanguage', () => {
  it('prefers a valid stored preference over browser detection', () => {
    expect(
      resolveLanguage('zh-CN', ['en-US', 'zh-TW']),
    ).toBe('zh-CN')
    expect(resolveLanguage('en', ['zh-CN'])).toBe('en')
  })

  it('uses the first supported browser language in order', () => {
    expect(resolveLanguage(null, ['fr', 'zh-TW', 'en-US'])).toBe('zh-CN')
    expect(resolveLanguage(null, ['fr', 'en-GB'])).toBe('en')
  })

  it('falls back to English when nothing is supported', () => {
    expect(resolveLanguage(null, ['fr', 'ja'])).toBe('en')
    expect(resolveLanguage(null, [])).toBe('en')
    expect(resolveLanguage(null, null)).toBe('en')
  })

  it('ignores an invalid stored preference', () => {
    expect(resolveLanguage('de', ['zh-CN'])).toBe('zh-CN')
    expect(resolveLanguage('ZH-CN', ['en'])).toBe('en')
  })
})

describe('translate', () => {
  it('interpolates named placeholders', () => {
    expect(translate('zh-CN', 'reply.to', { nickname: '小明' })).toBe(
      '回复 小明',
    )
    expect(translate('en', 'reply.to', { nickname: 'Sam' })).toBe('Reply to Sam')
    expect(translate('en', 'like.count', { count: 3 })).toBe('Like 3')
  })

  it('returns the key itself for an unknown key instead of blanking', () => {
    expect(
      translate('zh-CN', 'missing.key' as never),
    ).toBe('missing.key')
    expect(translate('en', 'missing.key' as never)).toBe('missing.key')
  })
})

describe('formatRelativeTime', () => {
  const baseTime = 1755500000000 // 2025-08-18T06:53:20.000Z

  it('formats relative time in both locales', () => {
    const seconds = new Date(baseTime - 30 * 1000).toISOString()
    const minutes = new Date(baseTime - 15 * 60 * 1000).toISOString()
    const hours = new Date(baseTime - 3 * 3600 * 1000).toISOString()
    const days = new Date(baseTime - 4 * 86400 * 1000).toISOString()
    expect(formatRelativeTime(seconds, 'zh-CN', baseTime)).toBe('30秒前')
    expect(formatRelativeTime(seconds, 'en', baseTime)).toBe('30 seconds ago')
    expect(formatRelativeTime(minutes, 'zh-CN', baseTime)).toBe('15分钟前')
    expect(formatRelativeTime(minutes, 'en', baseTime)).toBe('15 minutes ago')
    expect(formatRelativeTime(hours, 'zh-CN', baseTime)).toBe('3小时前')
    expect(formatRelativeTime(hours, 'en', baseTime)).toBe('3 hours ago')
    expect(formatRelativeTime(days, 'zh-CN', baseTime)).toBe('4天前')
    expect(formatRelativeTime(days, 'en', baseTime)).toBe('4 days ago')
  })

  it('uses a locale-specific date for timestamps at least seven days old', () => {
    const oldTime = new Date(baseTime - 10 * 86400 * 1000)
    expect(formatRelativeTime(oldTime.toISOString(), 'zh-CN', baseTime)).toBe(
      oldTime.toLocaleDateString('zh-CN'),
    )
    expect(formatRelativeTime(oldTime.toISOString(), 'en', baseTime)).toBe(
      oldTime.toLocaleDateString('en-US'),
    )
  })

  it('handles invalid timestamps gracefully', () => {
    expect(formatRelativeTime('nope', 'zh-CN', baseTime)).toBe('nope')
  })
})

describe('renderMessage', () => {
  it('renders local keys in the active locale', () => {
    expect(renderMessage(localMessage('notice.pinned'), 'zh-CN')).toBe(
      '评论已置顶。',
    )
    expect(renderMessage(localMessage('notice.pinned'), 'en')).toBe(
      'Comment pinned.',
    )
  })

  it('renders raw text unchanged in either locale', () => {
    const raw = rawMessage('backend detail: nope')
    expect(renderMessage(raw, 'zh-CN')).toBe('backend detail: nope')
    expect(renderMessage(raw, 'en')).toBe('backend detail: nope')
  })

  it('composes a local prefix with an inner message lazily', () => {
    const message = prefixMessage('notice.likeFailed', rawMessage('boom'))
    expect(renderMessage(message, 'zh-CN')).toBe('点赞失败：boom')
    expect(renderMessage(message, 'en')).toBe('Like failed: boom')
  })

  it('renders empty for nullish input', () => {
    expect(renderMessage(undefined, 'zh-CN')).toBe('')
    expect(renderMessage(null, 'en')).toBe('')
  })
})

describe('widget-owned display copy lives in the catalogs', () => {
  const HAN = /[\u3400-\u9fff]/

  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
  }

  it('keeps no Han display literal in widget source outside i18n.ts', () => {
    const srcDir = resolve('src')
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith('.ts') || name === 'i18n.ts') continue
      const source = readFileSync(resolve(srcDir, name), 'utf8')
      expect(stripComments(source), name).not.toMatch(HAN)
    }
  })
})
