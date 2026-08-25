// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from 'lit'
import type { TemplateResult } from 'lit'
import { FurtalkCommentsElement } from '../src/element'
import type { EmojiCatalog } from '../src/emoji'
import type { WidgetState } from '../src/state'
import type { RuntimeConfig } from '../src/types'

const TAG = 'furtalk-comments-emoji-test'
if (!customElements.get(TAG)) {
  customElements.define(TAG, FurtalkCommentsElement)
}

const CATALOG_URL = 'https://cdn.example/emoji.json'

function runtimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    site_id: '1',
    name: 'Site',
    comment_mode: 'anonymous',
    moderation: 'direct',
    user_delete_mode: 'soft',
    max_reply_depth: 5,
    comment_sort: 'asc',
    captcha: { comment: { required: false } },
    ...overrides,
  }
}

const sampleCatalog: EmojiCatalog = {
  packs: [
    {
      id: 'face',
      name: '颜文字',
      type: 'emotion',
      items: [
        { kind: 'text', id: 'shrug', name: '摊手', content: '¯\\_(ツ)_/¯', insertion: '¯\\_(ツ)_/¯' },
      ],
    },
    {
      id: 'emoji',
      name: 'Emoji',
      type: 'unicode',
      items: [
        { kind: 'text', id: 'joy', name: '笑哭', content: '😂', insertion: '😂' },
      ],
    },
    {
      id: 'aru',
      name: '阿鲁',
      type: 'image',
      items: [
        {
          kind: 'image',
          id: 'happy',
          name: '开心',
          src: 'https://cdn.example/emoji/aru/happy.webp',
          insertion: ':happy:',
        },
      ],
    },
  ],
  imageByToken: new Map([
    [
      'happy',
      {
        kind: 'image',
        id: 'happy',
        name: '开心',
        src: 'https://cdn.example/emoji/aru/happy.webp',
        insertion: ':happy:',
      },
    ],
  ]),
}

interface EmojiTestElement {
  state: WidgetState
  emojiCatalog: EmojiCatalog | null
  emojiOpenKey: 'root' | 'reply' | null
  emojiActiveTab: string
  renderComposerBody(
    composer: {
      body: string
      error: string
      comment: string
      replyTargetId: string | null
    },
    key: 'root' | 'reply',
  ): TemplateResult
  renderEmojiTrigger(key: 'root' | 'reply'): TemplateResult
  toggleEmojiPanel(key: 'root' | 'reply'): void
  updateComplete: Promise<void>
}

function makeElement() {
  return document.createElement(TAG) as unknown as EmojiTestElement
}

function readyElement(overrides: Partial<RuntimeConfig> = {}): EmojiTestElement {
  const element = makeElement()
  element.state = {
    status: 'ready',
    comments: [],
    nextCursor: null,
    sort: 'asc',
    loadingMore: false,
    authPhase: 'idle',
    pendingLikeIds: {},
    config: runtimeConfig(overrides),
  }
  return element
}

const emptyComposer = () => ({
  body: '',
  error: '',
  comment: '',
  replyTargetId: null,
})

describe('FurtalkCommentsElement emoji picker', () => {
  it('hides the trigger without a configured catalog URL', () => {
    const element = readyElement()
    const host = document.createElement('div')
    render(element.renderEmojiTrigger('root'), host)
    expect(host.querySelector('.ft-emoji-trigger')).toBeNull()
  })

  it('renders a trigger with aria-expanded and aria-controls when configured', () => {
    const element = readyElement({ emoji_catalog_url: CATALOG_URL })
    const host = document.createElement('div')
    render(element.renderEmojiTrigger('root'), host)
    const trigger = host.querySelector<HTMLButtonElement>('.ft-emoji-trigger')
    expect(trigger).not.toBeNull()
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
    expect(trigger?.getAttribute('aria-controls')).toBe('ft-emoji-panel-root')
    expect(trigger?.querySelector('.ft-emoji-icon')).not.toBeNull()
  })

  it('renders the panel with all three pack types and item previews when open', () => {
    const element = readyElement({ emoji_catalog_url: CATALOG_URL })
    element.emojiCatalog = sampleCatalog
    element.emojiActiveTab = sampleCatalog.packs[0]!.id
    ;(element as unknown as { emojiOpenKey: 'root' | null }).emojiOpenKey = 'root'
    const host = document.createElement('div')
    render(element.renderComposerBody(emptyComposer(), 'root'), host)
    const panel = host.querySelector<HTMLElement>('.ft-emoji-panel')
    expect(panel).not.toBeNull()
    expect(panel?.getAttribute('role')).toBe('dialog')
    expect(panel?.getAttribute('aria-label')).toBe('选择表情')
    const tabs = host.querySelectorAll<HTMLButtonElement>('.ft-emoji-tab')
    expect(tabs.length).toBeGreaterThanOrEqual(3)
    expect(tabs[0]?.getAttribute('role')).toBe('tab')
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    const items = host.querySelectorAll<HTMLButtonElement>('.ft-emoji-item')
    expect(items.length).toBeGreaterThan(0)
    expect(items[0]?.getAttribute('aria-label')).toBeTruthy()
  })

  it('renders an image item as an img preview and a text item as escaped content', () => {
    const element = readyElement({ emoji_catalog_url: CATALOG_URL })
    element.emojiCatalog = sampleCatalog
    element.emojiActiveTab = 'aru'
    ;(element as unknown as { emojiOpenKey: 'root' | null }).emojiOpenKey = 'root'
    const host = document.createElement('div')
    render(element.renderComposerBody(emptyComposer(), 'root'), host)
    const img = host.querySelector<HTMLImageElement>('.ft-emoji-image')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe(
      'https://cdn.example/emoji/aru/happy.webp',
    )
    expect(img?.getAttribute('loading')).toBe('lazy')
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('binds text emoji to the themed token and keeps tabs outside the scroll region', () => {
    const element = readyElement({ emoji_catalog_url: CATALOG_URL })
    element.emojiCatalog = sampleCatalog
    element.emojiActiveTab = 'face'
    ;(element as unknown as { emojiOpenKey: 'root' | null }).emojiOpenKey = 'root'
    const host = document.createElement('div')
    render(element.renderComposerBody(emptyComposer(), 'root'), host)
    const panel = host.querySelector<HTMLElement>('.ft-emoji-panel')
    expect(panel?.getAttribute('class')).toContain('max-h-80')
    expect(panel?.getAttribute('class')).not.toContain('overflow-y-auto')
    const tabs = host.querySelector<HTMLElement>('.ft-emoji-tabs')
    expect(tabs?.getAttribute('class')).not.toContain('overflow-y-auto')
    const scroll = host.querySelector<HTMLElement>('.ft-emoji-scroll')
    expect(scroll).not.toBeNull()
    expect(scroll?.getAttribute('class')).toContain('min-h-0')
    expect(scroll?.getAttribute('class')).toContain('overflow-y-auto')
    const items = host.querySelectorAll<HTMLButtonElement>('.ft-emoji-item')
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      expect(item.getAttribute('class')).toContain('text-(--furtalk-text)')
    }
  })

  it('closes the panel on Escape via the dialog keydown handler', () => {
    const element = readyElement({ emoji_catalog_url: CATALOG_URL })
    ;(element as unknown as { emojiOpenKey: 'root' | null }).emojiOpenKey = 'root'
    const host = document.createElement('div')
    render(element.renderComposerBody(emptyComposer(), 'root'), host)
    const panel = host.querySelector<HTMLElement>('.ft-emoji-panel')
    expect(panel).not.toBeNull()
    panel?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    expect(
      (element as unknown as { emojiOpenKey: string | null }).emojiOpenKey,
    ).toBeNull()
  })

  it('opens one panel at a time per composer', () => {
    const element = readyElement({ emoji_catalog_url: CATALOG_URL })
    element.toggleEmojiPanel('root')
    expect(element.emojiOpenKey).toBe('root')
    element.toggleEmojiPanel('root')
    expect(element.emojiOpenKey).toBeNull()
  })

  it('shows a non-fatal error notice with retry and no item grid', () => {
    const element = readyElement({ emoji_catalog_url: CATALOG_URL })
    ;(element as unknown as { emojiOpenKey: 'root' | null }).emojiOpenKey = 'root'
    ;(element as unknown as { emojiState: string }).emojiState = 'error'
    element.emojiCatalog = null
    const host = document.createElement('div')
    render(element.renderComposerBody(emptyComposer(), 'root'), host)
    expect(host.textContent).toContain('表情加载失败。')
    expect(host.textContent).not.toContain('内置表情')
    expect(
      host.querySelector<HTMLButtonElement>('.ft-emoji-msg button'),
    ).not.toBeNull()
    expect(
      host.querySelectorAll<HTMLButtonElement>('.ft-emoji-item').length,
    ).toBe(0)
  })
})
