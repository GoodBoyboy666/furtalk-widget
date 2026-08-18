// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render } from 'lit'
import type { TemplateResult } from 'lit'
import { FurtalkCommentsElement } from '../src/element'
import type { WidgetState } from '../src/state'
import type { EmojiGroup } from '../src/owo'
import type { RuntimeConfig } from '../src/types'

const TAG = 'furtalk-comments-owo-test'
if (!customElements.get(TAG)) {
  customElements.define(TAG, FurtalkCommentsElement)
}

const CATALOG_URL = 'https://cdn.example/owo.json'

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

const sampleCatalog: EmojiGroup[] = [
  {
    id: 'custom-0',
    label: '颜文字',
    kind: 'emoticon',
    items: [
      { kind: 'emoticon', label: 'Hi', insertion: 'OωO', display: 'OωO' },
    ],
  },
  {
    id: 'custom-1',
    label: 'Emoji',
    kind: 'emoji',
    items: [{ kind: 'emoji', label: '😀', insertion: '😀', display: '😀' }],
  },
]

interface OwOTestElement {
  state: WidgetState
  owoCatalog: EmojiGroup[]
  owoOpenKey: 'root' | 'reply' | null
  owoActiveTab: string
  renderComposerBody(
    composer: {
      body: string
      error: string
      comment: string
      replyTargetId: string | null
    },
    key: 'root' | 'reply',
  ): TemplateResult
  renderOwoTrigger(key: 'root' | 'reply'): TemplateResult
  toggleOwoPanel(key: 'root' | 'reply'): void
  updateComplete: Promise<void>
}

function makeElement() {
  return document.createElement(TAG) as unknown as OwOTestElement
}

function readyElement(overrides: Partial<RuntimeConfig> = {}): OwOTestElement {
  const element = makeElement()
  element.state = {
    status: 'ready',
    comments: [],
    nextCursor: null,
    sort: 'asc',
    loadingMore: false,
    authPhase: 'idle',
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

describe('FurtalkCommentsElement expression picker', () => {
  it('hides the trigger without a configured catalog URL', () => {
    const element = readyElement()
    const host = document.createElement('div')
    render(element.renderOwoTrigger('root'), host)
    expect(host.querySelector('.ft-owo-trigger')).toBeNull()
  })

  it('renders a trigger with aria-expanded and aria-controls when configured', () => {
    const element = readyElement({ owo_catalog_url: CATALOG_URL })
    const host = document.createElement('div')
    render(element.renderOwoTrigger('root'), host)
    const trigger = host.querySelector<HTMLButtonElement>('.ft-owo-trigger')
    expect(trigger).not.toBeNull()
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
    expect(trigger?.getAttribute('aria-controls')).toBe('ft-owo-panel-root')
    expect(trigger?.querySelector('.ft-owo-icon')).not.toBeNull()
  })

  it('renders the panel with remote catalog categories and item labels when open', () => {
    const element = readyElement({ owo_catalog_url: CATALOG_URL })
    element.owoCatalog = sampleCatalog
    element.owoActiveTab = sampleCatalog[0]!.id
    ;(element as unknown as { owoOpenKey: 'root' | null }).owoOpenKey = 'root'
    const host = document.createElement('div')
    render(element.renderComposerBody(emptyComposer(), 'root'), host)
    const panel = host.querySelector<HTMLElement>('.ft-owo-panel')
    expect(panel).not.toBeNull()
    expect(panel?.getAttribute('role')).toBe('dialog')
    expect(panel?.getAttribute('aria-label')).toBe('选择表情')
    const tabs = host.querySelectorAll<HTMLButtonElement>('.ft-owo-tab')
    expect(tabs.length).toBeGreaterThanOrEqual(2)
    expect(tabs[0]?.getAttribute('role')).toBe('tab')
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    const items = host.querySelectorAll<HTMLButtonElement>('.ft-owo-item')
    expect(items.length).toBeGreaterThan(0)
    expect(items[0]?.getAttribute('aria-label')).toBeTruthy()
  })

  it('closes the panel on Escape via the dialog keydown handler', () => {
    const element = readyElement({ owo_catalog_url: CATALOG_URL })
    ;(element as unknown as { owoOpenKey: 'root' | null }).owoOpenKey = 'root'
    const host = document.createElement('div')
    render(element.renderComposerBody(emptyComposer(), 'root'), host)
    const panel = host.querySelector<HTMLElement>('.ft-owo-panel')
    expect(panel).not.toBeNull()
    panel?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    expect(
      (element as unknown as { owoOpenKey: string | null }).owoOpenKey,
    ).toBeNull()
  })

  it('opens one panel at a time per composer', () => {
    const element = readyElement({ owo_catalog_url: CATALOG_URL })
    element.toggleOwoPanel('root')
    expect(element.owoOpenKey).toBe('root')
    element.toggleOwoPanel('root')
    expect(element.owoOpenKey).toBeNull()
  })

  it('shows a non-fatal error notice with retry and no item grid', () => {
    const element = readyElement({ owo_catalog_url: CATALOG_URL })
    ;(element as unknown as { owoOpenKey: 'root' | null }).owoOpenKey = 'root'
    ;(element as unknown as { owoState: string }).owoState = 'error'
    element.owoCatalog = []
    const host = document.createElement('div')
    render(element.renderComposerBody(emptyComposer(), 'root'), host)
    // 错误提示与重试可见，且不宣称内置表情可用。
    expect(host.textContent).toContain('表情加载失败。')
    expect(host.textContent).not.toContain('内置表情')
    expect(
      host.querySelector<HTMLButtonElement>('.ft-owo-msg button'),
    ).not.toBeNull()
    // 无内置回退：错误态不渲染表情网格。
    expect(
      host.querySelectorAll<HTMLButtonElement>('.ft-owo-item').length,
    ).toBe(0)
  })
})
