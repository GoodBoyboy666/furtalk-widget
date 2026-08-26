import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'lit'
import type { TemplateResult } from 'lit'
import { FurtalkCommentsElement, formatRelativeTime } from '../src/element'
import type { CommentNode } from '../src/comments'
import { localMessage, renderMessage, type DisplayMessage, type SupportedLanguage } from '../src/i18n'
import type { WidgetState } from '../src/state'
import type {
  Comment,
  ProfileHints,
  RuntimeConfig,
  ThreadMeta,
  WidgetSession,
} from '../src/types'

function node(partial: Partial<CommentNode> & { id: string }): CommentNode {
  return {
    site_id: '1',
    thread_id: '1',
    user_id: '10',
    parent_id: null,
    root_id: null,
    depth: 0,
    body: 'hello',
    status: 'published',
    author_nickname: 'A',
    author_website: null,
    avatar_url: '',
    reply_to_user_id: null,
    reply_to_nickname: null,
    created_at: '2026-08-11T00:00:00Z',
    published_at: '2026-08-11T00:00:00Z',
    children: [],
    ...partial,
  }
}

const ownerSession: WidgetSession = {
  valid: true,
  credential_mode: 'authenticated',
  user_id: '10',
  site_id: '1',
}

// renderNodeHost 直接渲染私有 renderNode 的 Lit 模板到 jsdom 容器，
// 以便断言 Markdown 输出进入 DOM 时是真实 HTML，而不是被转义的文本。
// session 与 deletingId 用来测试删除确认状态和所有权渲染的不同情况。
function renderNodeHost(
  comment: CommentNode,
  session?: WidgetSession,
  deletingId: string | null = null,
): HTMLDivElement {
  const tagName = 'furtalk-comments-render-test'
  if (!customElements.get(tagName)) {
    customElements.define(tagName, FurtalkCommentsElement)
  }
  const element = document.createElement(tagName) as unknown as {
    renderNode(n: CommentNode, s?: WidgetSession): TemplateResult
    deletingId: string | null
    language: SupportedLanguage
  }
  element.deletingId = deletingId
  element.language = 'zh-CN'
  const template = element.renderNode(comment, session)
  const host = document.createElement('div')
  render(template, host)
  return host
}

describe('FurtalkCommentsElement Markdown boundary', () => {
  it('renders accepted Markdown as formatted DOM, not literal tags', () => {
    const host = renderNodeHost(
      node({ id: '1', body: 'first paragraph\n\nsecond paragraph' }),
    )
    expect(host.querySelectorAll('p')).toHaveLength(2)
    expect(host.innerHTML).not.toContain('&lt;p&gt;')
    expect(host.textContent).toContain('first paragraph')
  })

  it('keeps the deleted placeholder as escaped plain text', () => {
    const host = renderNodeHost(
      node({ id: '2', status: 'deleted', body: '**secret**' }),
    )
    expect(host.textContent).toContain('（该评论已被删除）')
    expect(host.querySelector('strong')).toBeNull()
    expect(host.textContent).not.toContain('**secret**')
  })

  it('does not execute raw HTML from the accepted Markdown source', () => {
    const host = renderNodeHost(
      node({ id: '3', body: '<img src=x onerror="window.__xss=1">hello' }),
    )
    // 唯一的 img 是作者头像；恶意原始 HTML 必须转义成文本，不能作为元素插入 DOM。
    expect(host.querySelector('img[src="x"]')).toBeNull()
    expect(host.innerHTML).toContain('&lt;img')
    expect((window as { __xss?: number }).__xss).toBeUndefined()
  })

  it('expands a known emoji image token from the shared catalog', () => {
    const tagName = 'furtalk-comments-render-test'
    if (!customElements.get(tagName)) {
      customElements.define(tagName, FurtalkCommentsElement)
    }
    const element = document.createElement(tagName) as unknown as {
      renderNode(n: CommentNode, s?: WidgetSession): TemplateResult
      deletingId: string | null
      language: SupportedLanguage
      emojiCatalog: {
        packs: unknown[]
        imageByToken: Map<string, { id: string; name: string; src: string }>
      }
    }
    element.deletingId = null
    element.language = 'zh-CN'
    element.emojiCatalog = {
      packs: [],
      imageByToken: new Map([
        [
          'happy',
          {
            id: 'happy',
            name: '开心',
            src: 'https://cdn.example/emoji/aru/happy.webp',
          },
        ],
      ]),
    }
    const host = document.createElement('div')
    render(
      element.renderNode(
        node({ id: '4', body: 'hello :happy: world' }),
        undefined,
      ),
      host,
    )
    const img = host.querySelector<HTMLImageElement>('.ft-emoji-image')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe(
      'https://cdn.example/emoji/aru/happy.webp',
    )
    expect(img?.getAttribute('alt')).toBe('开心')
    expect(img?.getAttribute('loading')).toBe('lazy')
  })

  it('keeps unknown emoji tokens literal without a catalog', () => {
    const host = renderNodeHost(
      node({ id: '5', body: 'still :happy: literal' }),
    )
    expect(host.querySelector('.ft-emoji-image')).toBeNull()
    expect(host.textContent).toContain(':happy:')
  })
})

describe('FurtalkCommentsElement administrator Badge', () => {
  it('shows the 管理员 Badge next to an admin-authored comment', () => {
    const host = renderNodeHost(node({ id: '1', author_role: 'admin' }))
    const badge = host.querySelector('.ft-admin')
    expect(badge).not.toBeNull()
    expect(badge?.textContent).toBe('管理员')
  })

  it('does not show the Badge for a user comment or a missing role', () => {
    expect(
      renderNodeHost(node({ id: '2', author_role: 'user' })).querySelector(
        '.ft-admin',
      ),
    ).toBeNull()
    // 分阶段上线期间，旧缓存响应可能缺少 author_role，必须安全降级为不显示。
    expect(
      renderNodeHost(node({ id: '3' })).querySelector('.ft-admin'),
    ).toBeNull()
  })

  it('keeps the 管理员 and 待审核 Badges side by side without overlap', () => {
    const host = renderNodeHost(
      node({ id: '4', author_role: 'admin', status: 'pending' }),
    )
    expect(host.querySelector('.ft-admin')).not.toBeNull()
    expect(host.querySelector('.ft-pending')).not.toBeNull()
    const author = host.querySelector('.ft-author')
    expect(author?.nextElementSibling).not.toBeNull()
  })
})

describe('FurtalkCommentsElement reply-target label', () => {
  it('shows no reply label on a root comment', () => {
    const host = renderNodeHost(node({ id: '1', depth: 0 }))
    expect(host.querySelector('.ft-reply-to')).toBeNull()
  })

  it('shows 回复 {nickname} for a reply whose target still exists', () => {
    const host = renderNodeHost(
      node({
        id: '2',
        parent_id: '1',
        depth: 1,
        reply_to_user_id: '5',
        reply_to_nickname: 'Bob',
      }),
    )
    const label = host.querySelector('.ft-reply-to')
    expect(label).not.toBeNull()
    expect(label?.textContent?.trim()).toBe('回复 Bob')
  })

  it('shows 回复 已注销用户 when the reply target user is gone', () => {
    const host = renderNodeHost(
      node({
        id: '3',
        parent_id: '1',
        depth: 1,
        reply_to_user_id: null,
        reply_to_nickname: null,
      }),
    )
    const label = host.querySelector('.ft-reply-to')
    expect(label).not.toBeNull()
    expect(label?.textContent?.trim()).toBe('回复 已注销用户')
  })

  it('keeps the reply label when the parent comment is missing from the list', () => {
    // 父评论因普通分页未加载而缺失时，parent_id 仍存在，回复标签继续显示；
    // 这种情况与软删除压缩无关，根级回退逻辑仍然生效。
    const host = renderNodeHost(
      node({
        id: '4',
        parent_id: '999',
        depth: 2,
        reply_to_user_id: '7',
        reply_to_nickname: 'Carol',
      }),
    )
    const label = host.querySelector('.ft-reply-to')
    expect(label).not.toBeNull()
    expect(label?.textContent?.trim()).toBe('回复 Carol')
  })

  it('hides the reply label when the comment is promoted to a public root', () => {
    // 软删除压缩后上移到根层的评论 parent_id 为 null，即使持久化的 depth > 0，
    // 也不再表现为嵌套节点。
    const host = renderNodeHost(
      node({
        id: '8',
        parent_id: null,
        depth: 2,
        reply_to_user_id: '9',
        reply_to_nickname: 'Dana',
      }),
    )
    expect(host.querySelector('.ft-reply-to')).toBeNull()
  })
})

describe('FurtalkCommentsElement children list layout', () => {
  it('renders nested replies without w-full to prevent horizontal overflow', () => {
    const root = node({
      id: '1',
      children: [
        node({
          id: '2',
          parent_id: '1',
          depth: 1,
          author_nickname: 'Child',
        }),
      ],
    })
    const host = renderNodeHost(root)
    const childrenList = host.querySelector('ul.ft-children')
    expect(childrenList).not.toBeNull()
    expect(childrenList?.classList.contains('w-full')).toBe(false)
    expect(childrenList?.classList.contains('ml-11')).toBe(true)
  })
})

describe('FurtalkCommentsElement long-region collapse', () => {
  type CollapseInstance = {
    renderNode(n: CommentNode, s?: WidgetSession): TemplateResult
    language: SupportedLanguage
    deletingId: string | null
    overflowingRegions: Set<string>
    expandedRegions: Set<string>
    syncLimitedRegions(): void
    renderRoot: ShadowRoot
    regionResizeObserver: ResizeObserver | null
    requestUpdate: () => Promise<unknown>
    boot: () => void
    updateComplete: Promise<unknown>
    remove(): void
  }

  function collapseNodeHost(
    comment: CommentNode,
    options: {
      overflowing?: string[]
      expanded?: string[]
      language?: SupportedLanguage
    } = {},
  ): { element: CollapseInstance; host: HTMLDivElement } {
    const element = document.createElement(
      COMPOSER_HOST_TAG,
    ) as unknown as CollapseInstance
    element.language = options.language ?? 'zh-CN'
    element.deletingId = null
    element.overflowingRegions = new Set(options.overflowing ?? [])
    element.expandedRegions = new Set(options.expanded ?? [])
    const host = document.createElement('div')
    render(element.renderNode(comment), host)
    return { element, host }
  }

  function region(
    host: HTMLDivElement,
    kind: 'content' | 'children',
    commentId: string,
  ): HTMLElement {
    const result = host.querySelector<HTMLElement>(
      `.ft-region[data-region-kind="${kind}"][data-comment-id="${commentId}"]`,
    )
    if (!result) throw new Error(`missing ${kind} region for ${commentId}`)
    return result
  }

  function measurementTarget(
    element: CollapseInstance,
    comment: CommentNode,
  ): Promise<HTMLElement> {
    element.boot = () => undefined
    // Lit 的开发构建在元素已连接后会拒绝类字段遮蔽。
    // 生产 widget 同样存在这些预置字段，因此这里模仿样式采用测试的初始化方式，
    // 再等待首次更新。
    for (const key of [
      'siteId',
      'pageKey',
      'pageUrl',
      'pageTitle',
      'serviceOrigin',
    ]) {
      delete (element as unknown as Record<string, unknown>)[key]
    }
    document.body.appendChild(element as unknown as HTMLElement)
    return element.updateComplete.then(() => {
      render(element.renderNode(comment), element.renderRoot)
      const target = element.renderRoot.querySelector<HTMLElement>(
        '.ft-region-measurement[data-region-kind="content"]',
      )
      if (!target) throw new Error('missing content measurement target')
      return target
    })
  }

  it('renders independent region wrappers with the fixed height candidates', () => {
    const root = node({
      id: 'root',
      children: [node({ id: 'reply', parent_id: 'root', depth: 1 })],
    })
    const { host } = collapseNodeHost(root)

    const content = region(host, 'content', 'root')
    expect(content.id).toBe('ft-content-region-root')
    expect(content.classList.contains('max-h-[300px]')).toBe(false)
    expect(content.querySelector('.ft-region-measurement')).not.toBeNull()
    expect(
      content
        .querySelector('.ft-region-measurement')
        ?.classList.contains('flow-root'),
    ).toBe(true)

    const children = region(host, 'children', 'root')
    expect(children.id).toBe('ft-children-region-root')
    expect(children.classList.contains('max-h-[400px]')).toBe(false)
    expect(children.querySelector('ul.ft-children')).not.toBeNull()
    expect(host.querySelectorAll('.ft-read-more')).toHaveLength(0)
  })

  it('gates localized Read more controls on measured overflow state', () => {
    const root = node({
      id: 'root',
      children: [node({ id: 'reply', parent_id: 'root', depth: 1 })],
    })
    const { host } = collapseNodeHost(root, {
      overflowing: ['content:root', 'children:root'],
    })

    expect(
      region(host, 'content', 'root').classList.contains('max-h-[300px]'),
    ).toBe(true)
    expect(
      region(host, 'children', 'root').classList.contains('max-h-[400px]'),
    ).toBe(true)
    expect(host.querySelectorAll('.ft-read-more')).toHaveLength(2)
    const bodyButton = host.querySelector<HTMLButtonElement>(
      '.ft-read-more[aria-controls="ft-content-region-root"]',
    )
    const subtreeButton = host.querySelector<HTMLButtonElement>(
      '.ft-read-more[aria-controls="ft-children-region-root"]',
    )
    expect(bodyButton?.textContent?.trim()).toBe('阅读更多')
    expect(bodyButton?.type).toBe('button')
    expect(subtreeButton?.getAttribute('aria-expanded')).toBe('false')
    expect(subtreeButton?.classList.contains('ml-11')).toBe(true)
    expect(
      subtreeButton?.classList.contains('[@media(max-width:480px)]:ml-0'),
    ).toBe(true)
  })

  it('expands one region in isolation and preserves it across re-render', () => {
    const root = node({
      id: 'root',
      children: [node({ id: 'reply', parent_id: 'root', depth: 1 })],
    })
    const { element, host } = collapseNodeHost(root, {
      overflowing: ['content:root', 'children:root'],
    })
    const bodyButton = host.querySelector<HTMLButtonElement>(
      '[aria-controls="ft-content-region-root"]',
    )
    bodyButton?.click()
    expect(element.expandedRegions.has('content:root')).toBe(true)
    expect(element.expandedRegions.has('children:root')).toBe(false)

    render(element.renderNode(root), host)
    expect(
      region(host, 'content', 'root').classList.contains('max-h-[300px]'),
    ).toBe(false)
    expect(
      region(host, 'children', 'root').classList.contains('max-h-[400px]'),
    ).toBe(true)
    expect(
      host.querySelector('[aria-controls="ft-content-region-root"]'),
    ).toBeNull()
    expect(
      host.querySelector('[aria-controls="ft-children-region-root"]'),
    ).not.toBeNull()

    host
      .querySelector<HTMLButtonElement>(
        '[aria-controls="ft-children-region-root"]',
      )
      ?.click()
    render(element.renderNode(root), host)
    expect(element.expandedRegions).toEqual(
      new Set(['content:root', 'children:root']),
    )
    expect(host.querySelectorAll('.ft-read-more')).toHaveLength(0)
    expect(
      region(host, 'content', 'root').querySelector('.ft-body'),
    ).not.toBeNull()
    expect(
      region(host, 'children', 'root').querySelector('ul.ft-children'),
    ).not.toBeNull()
  })

  it('uses strict greater-than thresholds for content measurement', async () => {
    const root = node({ id: 'root' })
    const { element } = collapseNodeHost(root)
    const target = await measurementTarget(element, root)
    const update = vi
      .spyOn(element, 'requestUpdate')
      .mockResolvedValue(undefined)
    Object.defineProperty(target, 'scrollHeight', {
      configurable: true,
      value: 300,
    })
    element.syncLimitedRegions()
    expect(element.overflowingRegions.has('content:root')).toBe(false)

    Object.defineProperty(target, 'scrollHeight', { value: 301 })
    element.syncLimitedRegions()
    expect(element.overflowingRegions.has('content:root')).toBe(true)
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('applies the same strict boundary to the reply-region limit', () => {
    const root = node({ id: 'root' })
    const { element } = collapseNodeHost(root)
    const updateRegionOverflow = (
      element as unknown as {
        updateRegionOverflow(
          kind: 'content' | 'children',
          commentId: string,
          height: number,
        ): boolean
      }
    ).updateRegionOverflow.bind(element)

    expect(updateRegionOverflow('children', 'root', 400)).toBe(false)
    expect(element.overflowingRegions.has('children:root')).toBe(false)
    expect(updateRegionOverflow('children', 'root', 401)).toBe(true)
    expect(element.overflowingRegions.has('children:root')).toBe(true)
  })

  it('remeasures observed targets and skips unchanged observer decisions', async () => {
    type ResizeObserverMock = {
      callback: ResizeObserverCallback
      observe: ReturnType<typeof vi.fn>
      disconnect: ReturnType<typeof vi.fn>
      trigger(target: Element): void
    }
    class MockResizeObserver {
      static current: ResizeObserverMock | null = null
      callback: ResizeObserverCallback
      observe = vi.fn()
      disconnect = vi.fn()

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
        MockResizeObserver.current = this
      }

      trigger(target: Element): void {
        this.callback(
          [{ target } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        )
      }
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver)

    const root = node({ id: 'root' })
    const { element } = collapseNodeHost(root)
    const target = await measurementTarget(element, root)
    const observer = MockResizeObserver.current
    const update = vi
      .spyOn(element, 'requestUpdate')
      .mockResolvedValue(undefined)
    Object.defineProperty(target, 'scrollHeight', {
      configurable: true,
      value: 301,
    })
    element.syncLimitedRegions()
    expect(observer).not.toBeNull()
    expect(observer?.observe).toHaveBeenCalledWith(target)
    update.mockClear()

    observer?.trigger(target)
    expect(update).not.toHaveBeenCalled()

    Object.defineProperty(target, 'scrollHeight', { value: 250 })
    observer?.trigger(target)
    expect(element.overflowingRegions.has('content:root')).toBe(false)
    expect(update).toHaveBeenCalledTimes(1)

    element.remove()
    expect(observer?.disconnect).toHaveBeenCalled()
  })

  it('keeps initial measurement working without ResizeObserver', async () => {
    vi.stubGlobal('ResizeObserver', undefined)

    const root = node({ id: 'root' })
    const { element } = collapseNodeHost(root)
    const target = await measurementTarget(element, root)
    Object.defineProperty(target, 'scrollHeight', {
      configurable: true,
      value: 401,
    })

    element.syncLimitedRegions()
    expect(element.overflowingRegions.has('content:root')).toBe(true)
    expect(element.regionResizeObserver).toBeNull()
  })

  afterEach(() => {
    document
      .querySelectorAll(COMPOSER_HOST_TAG)
      .forEach((element) => element.remove())
    vi.unstubAllGlobals()
  })
})

describe('FurtalkCommentsElement delete confirmation copy', () => {
  it('shows only 确认删除 and 取消 without the redundant confirm prompt text', () => {
    const host = renderNodeHost(
      node({ id: '5', user_id: '10' }),
      ownerSession,
      '5',
    )
    expect(host.textContent).not.toContain('确认删除？')
    expect(host.textContent).toContain('确认删除')
    expect(host.textContent).toContain('取消')
  })

  it('does not enter the confirmation state before the delete action is requested', () => {
    const host = renderNodeHost(node({ id: '6', user_id: '10' }), ownerSession)
    expect(host.querySelector('.ft-btn-danger')?.textContent?.trim()).toBe(
      '删除',
    )
    expect(host.textContent).not.toContain('确认删除？')
    expect(host.textContent).not.toContain('取消')
  })
})

describe('FurtalkCommentsElement anonymous ownership', () => {
  it('never shows delete in anonymous mode even with a matching stale user id', () => {
    // 陈旧的匿名凭据或缺失的 credential_mode，绝不能判定为拥有该评论；
    // 删除操作以服务端为准。
    const stale = renderNodeHost(node({ id: '7', user_id: '10' }), {
      valid: true,
      user_id: '10',
    })
    expect(stale.textContent).not.toContain('删除')
    expect(stale.querySelector('.ft-btn-danger')).toBeNull()

    const none = renderNodeHost(node({ id: '8', user_id: '10' }))
    expect(none.textContent).not.toContain('删除')
  })

  it('shows delete only for a matching authenticated session', () => {
    const owned = renderNodeHost(node({ id: '9', user_id: '10' }), ownerSession)
    expect(owned.querySelector('.ft-btn-danger')?.textContent?.trim()).toBe(
      '删除',
    )
  })
})

// composerHost 直接渲染私有 renderRootComposer 的 Lit 模板，用于断言资料行
// 在两种评论模式下都始终可见、没有折叠开关、也没有单独的保存按钮。
const COMPOSER_HOST_TAG = 'furtalk-comments-render-test'
if (!customElements.get(COMPOSER_HOST_TAG)) {
  customElements.define(COMPOSER_HOST_TAG, FurtalkCommentsElement)
}

function composerHost(
  mode: 'anonymous' | 'authenticated',
  hints: ProfileHints,
  session?: WidgetSession,
  configOverrides?: Partial<RuntimeConfig>,
): HTMLDivElement {
  const element = document.createElement(COMPOSER_HOST_TAG) as unknown as {
    state: WidgetState
    hints: ProfileHints
    language: SupportedLanguage
    renderRootComposer(): TemplateResult
  }
  element.language = 'zh-CN'
  element.state = {
    status: 'ready',
    comments: [],
    nextCursor: null,
    sort: 'asc',
    loadingMore: false,
    authPhase: 'idle',
    pendingLikeIds: {},
    config: {
      site_id: '1',
      name: 'Site',
      comment_mode: mode,
      moderation: 'direct',
      user_delete_mode: 'soft',
      max_reply_depth: 5,
      captcha: {
        comment: { required: false },
      },
      ...configOverrides,
    },
    ...(session ? { session } : {}),
  }
  element.hints = { ...hints }
  const template = element.renderRootComposer()
  const host = document.createElement('div')
  render(template, host)
  return host
}

describe('FurtalkCommentsElement profile row', () => {
  it('renders the profile row always visible with no disclosure toggle', () => {
    for (const mode of ['anonymous', 'authenticated'] as const) {
      const host = composerHost(mode, {
        email: 'a@b.example',
        nickname: 'Alice',
        website_url: '',
      })
      expect(host.querySelector('.ft-profile')).not.toBeNull()
      expect(host.querySelector('.ft-profile-toggle')).toBeNull()
      expect(host.querySelector('#ft-email')).not.toBeNull()
      expect(host.querySelector('#ft-nickname')).not.toBeNull()
      expect(host.querySelector('#ft-website')).not.toBeNull()
    }
  })

  it('renders three profile fields in one horizontal desktop row', () => {
    const host = composerHost('anonymous', {
      email: '',
      nickname: '',
      website_url: '',
    })
    const profile = host.querySelector('.ft-profile')
    expect(profile).not.toBeNull()
    expect(profile?.querySelectorAll('.ft-field')).toHaveLength(3)
  })

  it('separates profile fields without allowing them to overlap', () => {
    const host = composerHost('anonymous', {
      email: '',
      nickname: '',
      website_url: '',
    })
    const profile = host.querySelector('.ft-profile')
    const fields = host.querySelectorAll('.ft-profile .ft-field')

    expect(
      profile?.classList.contains(
        '[border-bottom:1px_solid_var(--furtalk-border)]',
      ),
    ).toBe(true)
    expect(profile?.classList.contains('border-solid')).toBe(false)
    expect(fields[0]?.classList.contains('border-l')).toBe(false)
    for (const field of fields) {
      expect(field.classList.contains('min-w-0')).toBe(true)
      expect(field.classList.contains('border-solid')).toBe(false)
    }
    for (const field of [...fields].slice(1)) {
      expect(
        field.classList.contains(
          '[border-left:1px_solid_var(--furtalk-border)]',
        ),
      ).toBe(true)
      expect(
        field.classList.contains('[@media(max-width:480px)]:[border-left:0]'),
      ).toBe(true)
      expect(
        field.classList.contains(
          '[@media(max-width:480px)]:[border-top:1px_solid_var(--furtalk-border)]',
        ),
      ).toBe(true)
    }
    for (const input of host.querySelectorAll('.ft-profile .ft-input')) {
      expect(input.classList.contains('min-w-0')).toBe(true)
      expect(input.classList.contains('w-full')).toBe(true)
    }
  })

  it('has no separate profile-save button', () => {
    const host = composerHost('anonymous', {
      email: '',
      nickname: '',
      website_url: '',
    })
    expect(host.textContent).not.toContain('保存资料')
    expect(
      [...host.querySelectorAll('button')].some((b) =>
        b.textContent?.includes('保存'),
      ),
    ).toBe(false)
  })

  it('orders profile fields nickname, email, then website using placeholders', () => {
    const host = composerHost('anonymous', {
      email: 'a@b.example',
      nickname: 'Alice',
      website_url: '',
    })
    const fields = host.querySelectorAll('.ft-profile .ft-field')
    expect(fields).toHaveLength(3)
    const placeholders = [...fields].map((field) =>
      field.querySelector('input')?.getAttribute('placeholder'),
    )
    expect(placeholders).toEqual(['昵称', '邮箱', '网站（可选）'])
    expect(host.querySelector('.ft-profile label')).toBeNull()
  })

  it('shows no redundant profile validation note', () => {
    const host = composerHost('anonymous', {
      email: 'not-an-email',
      nickname: '',
      website_url: 'not-a-url',
    })
    expect(host.textContent).not.toContain('资料仅保存在当前网站浏览器中')
    expect(host.textContent).not.toContain('部分字段无效')
  })

  it('locks all profile fields and shows the logout button on a valid authenticated session', () => {
    const host = composerHost(
      'authenticated',
      { email: 'a@b.example', nickname: 'Alice', website_url: '' },
      { valid: true, credential_mode: 'authenticated', user_id: '1' },
    )
    for (const id of ['#ft-nickname', '#ft-email', '#ft-website']) {
      expect(host.querySelector<HTMLInputElement>(id)?.disabled).toBe(true)
    }
    expect(host.textContent).toContain('退出登录')
  })

  it('keeps profile fields editable with no logout button before an authenticated session exists', () => {
    const host = composerHost('authenticated', {
      email: 'a@b.example',
      nickname: 'Alice',
      website_url: '',
    })
    for (const id of ['#ft-nickname', '#ft-email', '#ft-website']) {
      expect(host.querySelector<HTMLInputElement>(id)?.disabled).toBe(false)
    }
    expect(host.textContent).not.toContain('退出登录')
  })

  it('keeps profile fields editable in anonymous mode even with a valid session', () => {
    const host = composerHost(
      'anonymous',
      { email: 'a@b.example', nickname: 'Alice', website_url: '' },
      { valid: true, credential_mode: 'authenticated', user_id: '1' },
    )
    for (const id of ['#ft-nickname', '#ft-email', '#ft-website']) {
      expect(host.querySelector<HTMLInputElement>(id)?.disabled).toBe(false)
    }
    expect(host.textContent).not.toContain('退出登录')
  })
})

describe('FurtalkCommentsElement two-layer logout', () => {
  interface LogoutInstance {
    state: WidgetState
    config: { serviceOrigin: string } | null
    api: { clearWidgetSession(): Promise<void> } | null
    widgetNotice: { text: DisplayMessage; reopenLogout?: boolean } | null
    handleLogout(): void
    openLogoutPage(): void
  }

  function logoutInstance(): LogoutInstance {
    const element = document.createElement(
      COMPOSER_HOST_TAG,
    ) as unknown as LogoutInstance
    element.config = { serviceOrigin: 'https://comments.example' }
    element.state = {
      status: 'ready',
      comments: [],
      nextCursor: null,
      sort: 'asc',
      loadingMore: false,
      authPhase: 'idle',
      pendingLikeIds: {},
      config: {
        site_id: '1',
        name: 'Site',
        comment_mode: 'authenticated',
        moderation: 'direct',
        user_delete_mode: 'soft',
        max_reply_depth: 5,
        captcha: {
          comment: { required: false },
        },
      },
      session: {
        valid: true,
        credential_mode: 'authenticated',
        user_id: '1',
        site_id: '1',
      },
    }
    element.api = null
    element.widgetNotice = null
    return element
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens the first-party logout page synchronously within the click gesture', () => {
    const instance = logoutInstance()
    const openMock = vi.fn(() => ({}) as Window)
    vi.stubGlobal('open', openMock)
    instance.handleLogout()
    expect(openMock).toHaveBeenCalledWith(
      'https://comments.example/logout',
      '_blank',
      '',
    )
  })

  it('does not open a logout page without a valid authenticated session', () => {
    const instance = logoutInstance()
    instance.state = { ...instance.state, session: { valid: false } }
    const openMock = vi.fn(() => ({}) as Window)
    vi.stubGlobal('open', openMock)
    instance.handleLogout()
    expect(openMock).not.toHaveBeenCalled()
  })

  it('clears the widget session and invalidates the local session on success', async () => {
    const instance = logoutInstance()
    const clear = vi.fn().mockResolvedValue(undefined)
    instance.api = { clearWidgetSession: clear }
    vi.stubGlobal(
      'open',
      vi.fn(() => ({}) as Window),
    )
    instance.handleLogout()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(clear).toHaveBeenCalled()
    expect(instance.state.session).toEqual({ valid: false })
  })

  it('keeps the session valid and shows a recoverable notice when the clear fails', async () => {
    const instance = logoutInstance()
    instance.api = {
      clearWidgetSession: vi.fn().mockRejectedValue(new Error('network down')),
    }
    vi.stubGlobal(
      'open',
      vi.fn(() => ({}) as Window),
    )
    instance.handleLogout()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(instance.state.session).toEqual({
      valid: true,
      credential_mode: 'authenticated',
      user_id: '1',
      site_id: '1',
    })
    expect(renderMessage(instance.widgetNotice!.text, 'zh-CN')).toContain(
      '退出登录失败',
    )
    expect(instance.widgetNotice?.reopenLogout).toBe(true)
  })

  it('keeps the widget session state while offering reopen when the popup is blocked', async () => {
    const instance = logoutInstance()
    instance.api = { clearWidgetSession: vi.fn().mockResolvedValue(undefined) }
    vi.stubGlobal(
      'open',
      vi.fn(() => null),
    )
    instance.handleLogout()
    expect(renderMessage(instance.widgetNotice!.text, 'zh-CN')).toContain(
      '浏览器拦截',
    )
    expect(instance.widgetNotice?.reopenLogout).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // widget 会话仍由它自己的请求结果清除。
    expect(instance.state.session).toEqual({ valid: false })
  })
})

describe('FurtalkCommentsElement unified create', () => {
  interface ComposerLike {
    comment: string
    body: string
    error: string
    replyTargetId: string | null
  }

  interface CreateInstance {
    state: WidgetState
    config: {
      siteId: string
      pageKey: string
      pageUrl?: string
      pageTitle?: string
      serviceOrigin: string
    } | null
    api: {
      createComment(
        siteId: string,
        input: Record<string, unknown>,
        captchaToken: string,
      ): Promise<unknown>
    } | null
    store: { save(hints: ProfileHints): void } | null
    hints: ProfileHints
    root: ComposerLike
    reply: ComposerLike | null
    loadPage(): Promise<void>
    ensureAuthenticated(action: unknown): Promise<boolean>
    createComment(composer: ComposerLike): Promise<void>
    performCreate(
      action: {
        type: 'create'
        parentId?: string
        body: string
        captchaToken: string
      },
      composer: ComposerLike,
      fromAuthRetry?: boolean,
    ): Promise<void>
  }

  const publishedComment = {
    id: '7',
    site_id: '1',
    thread_id: '1',
    user_id: '10',
    parent_id: null,
    root_id: null,
    depth: 0,
    body: 'hello',
    status: 'published',
    author_nickname: 'Visitor',
    author_website: null,
    avatar_url: '',
    created_at: '2026-08-11T00:00:00Z',
    published_at: '2026-08-11T00:00:00Z',
  }

  function createInstance(mode: 'anonymous' | 'authenticated'): CreateInstance {
    const element = document.createElement(
      COMPOSER_HOST_TAG,
    ) as unknown as CreateInstance
    element.config = {
      siteId: '1',
      pageKey: 'page',
      pageUrl: 'https://host.example/page',
      serviceOrigin: 'https://comments.example',
    }
    element.state = {
      status: 'ready',
      comments: [],
      nextCursor: null,
      sort: 'asc',
      loadingMore: false,
      authPhase: 'idle',
      pendingLikeIds: {},
      config: {
        site_id: '1',
        name: 'Site',
        comment_mode: mode,
        moderation: 'direct',
        user_delete_mode: 'soft',
        max_reply_depth: 5,
        captcha: { comment: { required: false } },
      },
    }
    element.hints = {
      email: 'visitor@example.com',
      nickname: 'Visitor',
      website_url: 'https://blog.example',
    }
    element.root = { comment: '', body: '', error: '', replyTargetId: null }
    element.reply = null
    element.api = null
    element.store = null
    element.loadPage = vi.fn().mockResolvedValue(undefined)
    element.ensureAuthenticated = vi.fn().mockResolvedValue(true)
    return element
  }

  it('creates an anonymous root comment in one POST carrying attribution fields', async () => {
    const instance = createInstance('anonymous')
    const createMock = vi.fn().mockResolvedValue(publishedComment)
    instance.api = { createComment: createMock }

    await instance.createComment({
      comment: '',
      body: 'hello',
      error: '',
      replyTargetId: null,
    })

    expect(createMock).toHaveBeenCalledTimes(1)
    const input = createMock.mock.calls[0]?.[1] as Record<string, unknown>
    expect(input).toMatchObject({
      pageKey: 'page',
      pageUrl: 'https://host.example/page',
      parentId: undefined,
      bodyMarkdown: 'hello',
      email: 'visitor@example.com',
      nickname: 'Visitor',
      websiteUrl: 'https://blog.example',
    })
    expect(instance.root.body).toBe('')
    expect(instance.loadPage).toHaveBeenCalledTimes(1)
  })

  it('creates an anonymous reply in one POST with the parent id', async () => {
    const instance = createInstance('anonymous')
    const createMock = vi.fn().mockResolvedValue(publishedComment)
    instance.api = { createComment: createMock }

    await instance.createComment({
      comment: '',
      body: 'reply',
      error: '',
      replyTargetId: '5',
    })

    expect(createMock).toHaveBeenCalledTimes(1)
    const input = createMock.mock.calls[0]?.[1] as Record<string, unknown>
    expect(input.parentId).toBe('5')
    expect(input.bodyMarkdown).toBe('reply')
    expect(instance.reply).toBeNull()
  })

  it('blocks submission before the network when attribution is invalid', async () => {
    const instance = createInstance('anonymous')
    instance.hints = {
      email: 'visitor@example.com',
      nickname: '',
      website_url: '',
    }
    const createMock = vi.fn()
    instance.api = { createComment: createMock }
    const composer = { comment: '', body: 'hi', error: '', replyTargetId: null }

    await instance.createComment(composer)

    expect(createMock).not.toHaveBeenCalled()
    expect(
      renderMessage(composer.error as unknown as DisplayMessage, 'zh-CN'),
    ).toBe('请填写有效的昵称')
  })

  it('routes an administrator need_auth_code response through authorization and retries the same comment', async () => {
    const instance = createInstance('anonymous')
    const createMock = vi
      .fn()
      .mockResolvedValueOnce({ need_auth_code: true })
      .mockResolvedValueOnce(publishedComment)
    instance.api = { createComment: createMock }

    await instance.createComment({
      comment: '',
      body: 'admin comment',
      error: '',
      replyTargetId: null,
    })

    expect(createMock).toHaveBeenCalledTimes(2)
    expect(instance.ensureAuthenticated).toHaveBeenCalledTimes(1)
    const first = createMock.mock.calls[0]?.[1] as Record<string, unknown>
    const second = createMock.mock.calls[1]?.[1] as Record<string, unknown>
    expect(second).toEqual(first)
    expect(instance.root.body).toBe('')
    expect(instance.state.pendingAction).toBeUndefined()
  })

  it('keeps the pending action and never retries when authorization is abandoned', async () => {
    const instance = createInstance('anonymous')
    const createMock = vi.fn().mockResolvedValue({ need_auth_code: true })
    instance.api = { createComment: createMock }
    instance.ensureAuthenticated = vi.fn().mockResolvedValue(false)
    const composer = {
      comment: '',
      body: 'admin comment',
      error: '',
      replyTargetId: null,
    }

    await instance.createComment(composer)

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(instance.state.pendingAction).toMatchObject({
      type: 'create',
      body: 'admin comment',
    })
    expect(composer.body).toBe('admin comment')
  })

  it('stops after a second need_auth_code and reports the retry failure', async () => {
    const instance = createInstance('anonymous')
    const createMock = vi.fn().mockResolvedValue({ need_auth_code: true })
    instance.api = { createComment: createMock }
    const composer = { comment: '', body: 'hi', error: '', replyTargetId: null }

    await instance.createComment(composer)

    // ensureAuthenticated 被模拟为成功，因此重试会再次运行并再次得到 need_auth_code：
    // 流程必须停止而不是无限循环。
    expect(createMock).toHaveBeenCalledTimes(2)
    expect(
      renderMessage(composer.error as unknown as DisplayMessage, 'zh-CN'),
    ).toBe('授权未生效，请重试')
  })

  it('preserves the authenticated-mode lock via the unified flow', async () => {
    const instance = createInstance('authenticated')
    const createMock = vi.fn().mockResolvedValue(publishedComment)
    instance.api = { createComment: createMock }
    instance.state = {
      ...instance.state,
      session: {
        valid: true,
        credential_mode: 'authenticated',
        user_id: '10',
        site_id: '1',
      },
    }

    await instance.createComment({
      comment: '',
      body: 'account comment',
      error: '',
      replyTargetId: null,
    })

    expect(instance.ensureAuthenticated).not.toHaveBeenCalled()
    expect(createMock).toHaveBeenCalledTimes(1)
    const input = createMock.mock.calls[0]?.[1] as Record<string, unknown>
    expect(input.email).toBe('visitor@example.com')
    expect(input.nickname).toBe('Visitor')
  })

  it('shows the published success notice after a direct publish', async () => {
    const instance = createInstance('anonymous')
    instance.api = {
      createComment: vi.fn().mockResolvedValue(publishedComment),
    }

    await instance.createComment({
      comment: '',
      body: 'hello',
      error: '',
      replyTargetId: null,
    })

    expect(renderMessage(instance.state.notice, 'zh-CN')).toBe('评论已发布。')
  })

  it('shows the moderation notice when the created comment is pending', async () => {
    const instance = createInstance('anonymous')
    instance.api = {
      createComment: vi
        .fn()
        .mockResolvedValue({ ...publishedComment, status: 'pending' }),
    }

    await instance.createComment({
      comment: '',
      body: 'hello',
      error: '',
      replyTargetId: null,
    })

    expect(renderMessage(instance.state.notice, 'zh-CN')).toBe(
      '评论已提交，等待审核。',
    )
  })

  it('clears a stale success notice when a new submission fails', async () => {
    const instance = createInstance('anonymous')
    instance.state = {
      ...instance.state,
      notice: localMessage('notice.submissionPublished'),
    }
    const createMock = vi.fn().mockRejectedValue(new Error('network down'))
    instance.api = { createComment: createMock }
    const composer = {
      comment: '',
      body: 'hello',
      error: '',
      replyTargetId: null,
    }

    await instance.createComment(composer)

    expect(instance.state.notice).toBeUndefined()
    expect(composer.error).not.toBe('')
  })

  it('clears a stale success notice before retrying a need_auth_code flow', async () => {
    const instance = createInstance('anonymous')
    instance.state = {
      ...instance.state,
      notice: localMessage('notice.submissionPublished'),
    }
    instance.api = {
      createComment: vi.fn().mockResolvedValue({ need_auth_code: true }),
    }
    const composer = {
      comment: '',
      body: 'admin comment',
      error: '',
      replyTargetId: null,
    }

    await instance.createComment(composer)

    expect(instance.state.notice).toBeUndefined()
    expect(instance.state.pendingAction).toMatchObject({
      type: 'create',
      body: 'admin comment',
    })
  })
})

describe('FurtalkCommentsElement composer command group', () => {
  const hints = { email: 'a@b.example', nickname: 'Alice', website_url: '' }
  const authenticatedSession: WidgetSession = {
    valid: true,
    credential_mode: 'authenticated',
    user_id: '1',
    site_id: '1',
  }

  it('groups logout and publish into one adjacent command container', () => {
    const host = composerHost('authenticated', hints, authenticatedSession)
    const group = host.querySelector('.ft-command-group')
    expect(group).not.toBeNull()
    const buttons = group?.querySelectorAll('button')
    expect(buttons).toHaveLength(2)
    expect(buttons?.[0]?.textContent?.trim()).toBe('退出登录')
    expect(buttons?.[1]?.textContent?.trim()).toBe('发表评论')
  })

  it('keeps the publish button inside the command group in anonymous mode', () => {
    const host = composerHost('anonymous', hints)
    const group = host.querySelector('.ft-command-group')
    expect(group).not.toBeNull()
    expect(group?.querySelectorAll('button')).toHaveLength(1)
    expect(group?.querySelector('button')?.textContent?.trim()).toBe('发表评论')
  })

  it('hides the expression trigger without a configured catalog URL and keeps commands right aligned', () => {
    const host = composerHost('anonymous', hints)
    const group = host.querySelector('.ft-command-group')
    expect(group?.textContent).not.toContain('无需登录')
    expect(group?.classList.contains('ml-auto')).toBe(true)
    // 未配置远程目录时不渲染表情触发器。
    expect(host.querySelector('.ft-emoji-trigger')).toBeNull()
  })

  it('shows the expression trigger when a catalog URL is configured and keeps commands right aligned', () => {
    const host = composerHost('anonymous', hints, undefined, {
      emoji_catalog_url: 'https://cdn.example/emoji.json',
    })
    const trigger = host.querySelector<HTMLButtonElement>('.ft-emoji-trigger')
    expect(trigger).not.toBeNull()
    expect(trigger?.querySelector('.ft-emoji-icon')).not.toBeNull()
    const group = host.querySelector('.ft-command-group')
    expect(group?.classList.contains('ml-auto')).toBe(true)
  })

  it('groups the reply composer cancel and submit actions together', () => {
    const element = document.createElement(COMPOSER_HOST_TAG) as unknown as {
      reply: {
        comment: string
        body: string
        error: string
        replyTargetId: string
      }
      language: SupportedLanguage
      renderNode(n: CommentNode, s?: WidgetSession): TemplateResult
    }
    element.reply = { comment: '', body: '', error: '', replyTargetId: '1' }
    element.language = 'zh-CN'
    const reply = document.createElement('div')
    render(element.renderNode(node({ id: '1' }), authenticatedSession), reply)
    const group = reply.querySelector('.ft-reply-form .ft-command-group')
    expect(group).not.toBeNull()
    const buttons = group?.querySelectorAll('button')
    expect(buttons).toHaveLength(2)
    expect(buttons?.[0]?.textContent?.trim()).toBe('取消回复')
    expect(buttons?.[1]?.textContent?.trim()).toBe('回复')
  })
})

// readyViewHost 直接渲染就绪状态的整页视图，用于断言评论框下方的排序控件与
// 成功提示的 DOM 呈现。
interface ReadyViewInstance {
  state: WidgetState
  hints: ProfileHints
  configError: string | null
  language: SupportedLanguage
  widgetNotice: { text: DisplayMessage; reopenLogout?: boolean } | null
  captchaMaskKey: 'root' | 'reply' | null
  render(): TemplateResult
}

function readyViewHost(overrides: Partial<WidgetState> = {}): HTMLDivElement {
  const element = document.createElement(
    COMPOSER_HOST_TAG,
  ) as unknown as ReadyViewInstance
  element.configError = null
  element.language = 'zh-CN'
  element.widgetNotice = null
  element.hints = { email: '', nickname: '', website_url: '' }
  element.captchaMaskKey = null
  element.state = {
    status: 'ready',
    comments: [],
    nextCursor: null,
    sort: 'asc',
    loadingMore: false,
    authPhase: 'idle',
    pendingLikeIds: {},
    config: {
      site_id: '1',
      name: 'Site',
      comment_mode: 'anonymous',
      moderation: 'direct',
      user_delete_mode: 'soft',
      max_reply_depth: 5,
      captcha: { comment: { required: false } },
    },
    ...overrides,
  }
  const template = element.render()
  const host = document.createElement('div')
  render(template, host)
  return host
}

// maskedViewHost 渲染就绪视图并预设一个打开的掩膜，用于断言掩膜
// 恰好渲染一次且位于 Widget 根层（空评论区与多评论场景都不重复渲染）。
function maskedViewHost(
  key: 'root' | 'reply',
  overrides: Partial<WidgetState> = {},
): HTMLDivElement {
  const element = document.createElement(
    COMPOSER_HOST_TAG,
  ) as unknown as ReadyViewInstance
  element.configError = null
  element.language = 'zh-CN'
  element.widgetNotice = null
  element.hints = { email: 'a@b.example', nickname: 'Alice', website_url: '' }
  element.captchaMaskKey = key
  element.state = {
    status: 'ready',
    comments: [],
    nextCursor: null,
    sort: 'asc',
    loadingMore: false,
    authPhase: 'idle',
    pendingLikeIds: {},
    config: {
      site_id: '1',
      name: 'Site',
      comment_mode: 'anonymous',
      moderation: 'direct',
      user_delete_mode: 'soft',
      max_reply_depth: 5,
      captcha: {
        comment: { required: true, provider: 'turnstile', site_key: 'k' },
      },
    },
    ...overrides,
  }
  const template = element.render()
  const host = document.createElement('div')
  render(template, host)
  return host
}

describe('FurtalkCommentsElement compiled stylesheet', () => {
  function compiledCss(): string {
    const styles = FurtalkCommentsElement.styles
    return Array.isArray(styles)
      ? styles.map((s) => s.cssText).join('\n')
      : styles.cssText
  }

  it('keeps every documented --furtalk-* custom property with a default', () => {
    const cssText = compiledCss()
    for (const name of [
      '--furtalk-font',
      '--furtalk-text',
      '--furtalk-text-muted',
      '--furtalk-border',
      '--furtalk-bg',
      '--furtalk-bg-muted',
      '--furtalk-accent',
      '--furtalk-danger',
      '--furtalk-radius',
    ]) {
      expect(cssText).toContain(name)
    }
  })

  it('contains no unprocessed Tailwind directive or tailwindcss import', () => {
    const cssText = compiledCss()
    expect(cssText).not.toContain('@source')
    expect(cssText).not.toContain('@apply')
    expect(cssText).not.toMatch(/@import[\s\S]*tailwindcss/)
  })

  it('keeps the 480px responsive profile/action behavior', () => {
    expect(compiledCss()).toMatch(/@media\s*\(max-width:\s*480px\)/)
  })

  it('emits side-specific profile and composer dividers', () => {
    const cssText = compiledCss()

    expect(cssText).toContain('border-bottom: 1px solid var(--furtalk-border)')
    expect(cssText).toContain('border-left: 1px solid var(--furtalk-border)')
    expect(cssText).toContain('border-top: 1px solid var(--furtalk-border)')
  })
})

describe('FurtalkCommentsElement shadow DOM style adoption', () => {
  const tagName = 'furtalk-comments-shadow-test'

  // FurtalkCommentsElement 已在本套件其他测试标签下注册，而自定义元素构造器只能
  // 注册一次。派生子类，使该标签获得独立、可注册的构造器。
  class ShadowTestElement extends FurtalkCommentsElement {}

  afterEach(() => {
    document.querySelectorAll(tagName).forEach((el) => el.remove())
  })

  it('renders into an open shadow root and never injects styles into document.head', async () => {
    if (!customElements.get(tagName)) {
      customElements.define(tagName, ShadowTestElement)
    }
    const element = document.createElement(tagName) as HTMLElement & {
      boot: () => void
      updateComplete: Promise<unknown>
    }
    // 不走真实的启动和网络流程；我们只断言渲染根。
    element.boot = () => undefined
    // widget 同时以类字段和 `static properties` 声明响应式属性，这会遮蔽 Lit 的
    // 响应式访问器，开发构建在实例连接时会报错。
    // 删除这些类字段，让首次更新流程可以运行（生产构建不受影响）。
    for (const key of [
      'siteId',
      'pageKey',
      'pageUrl',
      'pageTitle',
      'serviceOrigin',
    ]) {
      delete (element as unknown as Record<string, unknown>)[key]
    }
    const headStyles = document.head.querySelectorAll('style').length
    document.body.appendChild(element)
    await element.updateComplete

    expect(element.shadowRoot).not.toBeNull()
    expect(element.shadowRoot?.querySelector('style')).not.toBeNull()
    expect(document.head.querySelectorAll('style').length).toBe(headStyles)
  })
})

describe('FurtalkCommentsElement captcha host alignment', () => {
  it('left-aligns the captcha host instead of centering it', () => {
    const styles = FurtalkCommentsElement.styles
    const cssText = Array.isArray(styles)
      ? styles.map((s) => s.cssText).join('\n')
      : styles.cssText
    expect(cssText).toContain('justify-content: flex-start')
    expect(cssText).not.toContain('justify-content: center')
  })

  it('lays the captcha mask over the full viewport instead of the widget area', () => {
    const styles = FurtalkCommentsElement.styles
    const cssText = Array.isArray(styles)
      ? styles.map((s) => s.cssText).join('\n')
      : styles.cssText
    // 掩膜必须是视口固定定位（全屏遮罩），而不是相对 .ft-widget 的内容区域。
    // 这些由掩膜模板上的 `fixed inset-0` 静态工具类编译而来。
    expect(cssText).toContain('position: fixed')
    expect(cssText).toContain('inset: 0')
    expect(cssText).toContain('z-index: 2147483647')
  })
})

describe('FurtalkCommentsElement authored stylesheet boundary', () => {
  it('keeps no authored .ft-* selector or component layer in styles.css', () => {
    const source = readFileSync(resolve('src/styles.css'), 'utf8')
    expect(source).not.toMatch(/\.ft-[a-z-]+/)
    expect(source).not.toContain('@layer components')
  })

  it('never combines a directional border utility with all-side border-solid', () => {
    const source = readFileSync(resolve('src/element.ts'), 'utf8')
    const unsafeDirectionalBorder =
      /(?:border-(?:t|r|b|l)(?:-\S+)?[^'"\n]*border-solid|border-solid[^'"\n]*border-(?:t|r|b|l)(?:-\S+)?)/

    expect(source).not.toMatch(unsafeDirectionalBorder)
  })
})

describe('FurtalkCommentsElement sort control', () => {
  it('renders asc and desc buttons with the active direction pressed inside a segmented container', () => {
    const host = readyViewHost({ sort: 'desc' })
    const asc = host.querySelector<HTMLButtonElement>('[data-sort="asc"]')
    const desc = host.querySelector<HTMLButtonElement>('[data-sort="desc"]')
    expect(asc).not.toBeNull()
    expect(desc).not.toBeNull()
    expect(asc?.parentElement).toBe(desc?.parentElement)
    expect(asc?.parentElement?.classList.contains('inline-flex')).toBe(true)
    expect(asc?.getAttribute('aria-pressed')).toBe('false')
    expect(desc?.getAttribute('aria-pressed')).toBe('true')
    expect(asc?.textContent?.trim()).toBe('最早')
    expect(desc?.textContent?.trim()).toBe('最新')
  })

  it('renders the asc button pressed by default', () => {
    const host = readyViewHost()
    expect(
      host.querySelector('[data-sort="asc"]')?.getAttribute('aria-pressed'),
    ).toBe('true')
    expect(
      host.querySelector('[data-sort="desc"]')?.getAttribute('aria-pressed'),
    ).toBe('false')
  })

  it('removes the site comment header and places sorting above the list', () => {
    const host = readyViewHost()
    const sort = host.querySelector('.ft-sort')
    expect(host.querySelector('.ft-header')).toBeNull()
    expect(host.textContent).not.toContain('的评论')
    expect(sort).not.toBeNull()
    expect(
      sort?.previousElementSibling?.classList.contains('ft-composer'),
    ).toBe(true)
    expect(sort?.nextElementSibling?.classList.contains('ft-state')).toBe(true)
  })

  it('does not render portal link for anonymous mode regular visitors', () => {
    const host = readyViewHost({
      config: {
        site_id: '1',
        name: 'Site',
        comment_mode: 'anonymous',
        moderation: 'direct',
        user_delete_mode: 'soft',
        max_reply_depth: 5,
        captcha: { comment: { required: false } },
      },
      session: { valid: false },
    })
    expect(host.querySelector('.ft-portal-link')).toBeNull()
  })

  it('renders 后台管理 link for anonymous mode administrators', () => {
    const host = readyViewHost({
      config: {
        site_id: '1',
        name: 'Site',
        comment_mode: 'anonymous',
        moderation: 'direct',
        user_delete_mode: 'soft',
        max_reply_depth: 5,
        captcha: { comment: { required: false } },
      },
      session: {
        valid: true,
        credential_mode: 'authenticated',
        role: 'admin',
      },
    })
    const link = host.querySelector<HTMLAnchorElement>('.ft-portal-link')
    expect(link).not.toBeNull()
    expect(link?.textContent?.trim()).toBe('后台管理')
    expect(link?.getAttribute('href')).toContain('/admin')
    expect(link?.getAttribute('target')).toBe('_blank')
  })

  it('renders 我的评论 link for authenticated mode normal users', () => {
    const host = readyViewHost({
      config: {
        site_id: '1',
        name: 'Site',
        comment_mode: 'authenticated',
        moderation: 'direct',
        user_delete_mode: 'soft',
        max_reply_depth: 5,
        captcha: { comment: { required: false } },
      },
      session: {
        valid: true,
        credential_mode: 'authenticated',
        role: 'user',
      },
    })
    const link = host.querySelector<HTMLAnchorElement>('.ft-portal-link')
    expect(link).not.toBeNull()
    expect(link?.textContent?.trim()).toBe('我的评论')
    expect(link?.getAttribute('href')).toContain('/account/comments')
    expect(link?.getAttribute('target')).toBe('_blank')
  })

  it('renders 后台管理 link for authenticated mode administrators', () => {
    const host = readyViewHost({
      config: {
        site_id: '1',
        name: 'Site',
        comment_mode: 'authenticated',
        moderation: 'direct',
        user_delete_mode: 'soft',
        max_reply_depth: 5,
        captcha: { comment: { required: false } },
      },
      session: {
        valid: true,
        credential_mode: 'authenticated',
        role: 'admin',
      },
    })
    const link = host.querySelector<HTMLAnchorElement>('.ft-portal-link')
    expect(link).not.toBeNull()
    expect(link?.textContent?.trim()).toBe('后台管理')
    expect(link?.getAttribute('href')).toContain('/admin')
    expect(link?.getAttribute('target')).toBe('_blank')
  })

  it('keeps the composer and sort control mounted while loading comments on sort change', () => {
    const host = readyViewHost({
      loadingComments: true,
      comments: [],
    })
    expect(host.querySelector('.ft-composer')).not.toBeNull()
    expect(host.querySelector('.ft-sort')).not.toBeNull()
    const stateEl = host.querySelector('.ft-state')
    expect(stateEl).not.toBeNull()
    expect(stateEl?.textContent).toContain('加载中…')
  })
})

describe('FurtalkCommentsElement comment item styling', () => {
  it('renders comment items without gray divider borders', () => {
    const host = readyViewHost({ comments: [node({ id: '1' })] })
    const item = host.querySelector('.ft-item')

    expect(item).not.toBeNull()
    expect(item?.classList.contains('border-t')).toBe(false)
    expect(item?.classList.contains('border-(--furtalk-border)')).toBe(false)
  })
})

describe('FurtalkCommentsElement success notice', () => {
  it('renders a success notice in a distinct success style', () => {
    const host = readyViewHost({
      notice: localMessage('notice.submissionPublished'),
    })
    const noticeEl = host.querySelector('.ft-success')
    expect(noticeEl).not.toBeNull()
    expect(noticeEl?.textContent).toContain('评论已发布。')
    expect(host.querySelector('.ft-error')).toBeNull()
  })

  it('does not render a success notice when none is set', () => {
    const host = readyViewHost()
    expect(host.querySelector('.ft-success')).toBeNull()
  })
})

describe('FurtalkCommentsElement captcha mask render', () => {
  it('renders the mask once at the widget root on an empty thread', () => {
    // 空评论区时 renderNode 不运行，掩膜必须由 Widget 根层只渲染一次。
    const host = maskedViewHost('root')
    const masks = host.querySelectorAll('.ft-captcha-mask')
    expect(masks).toHaveLength(1)
    const panel = host.querySelector('.ft-captcha-mask-panel')
    expect(panel).not.toBeNull()
    expect(panel?.getAttribute('role')).toBe('dialog')
    expect(panel?.getAttribute('aria-modal')).toBe('true')
    expect(host.querySelector('[data-captcha-host="root"]')).not.toBeNull()
  })

  it('renders exactly one mask regardless of comment count', () => {
    const comments = [node({ id: '1' }), node({ id: '2' }), node({ id: '3' })]
    const host = maskedViewHost('reply', { comments })
    expect(host.querySelectorAll('.ft-captcha-mask')).toHaveLength(1)
    expect(host.querySelector('[data-captcha-host="reply"]')).not.toBeNull()
    expect(host.querySelectorAll('[data-captcha-host="reply"]')).toHaveLength(1)
  })

  it('renders no mask when no composer is waiting for a token', () => {
    const host = readyViewHost()
    expect(host.querySelector('.ft-captcha-mask')).toBeNull()
    expect(host.querySelector('[data-captcha-host]')).toBeNull()
  })

  it('does not render an inline provider host in the composer', () => {
    const host = maskedViewHost('root')
    // 内联编辑器中不允许出现 data-captcha-host；只有掩膜内的容器存在。
    const composerHosts = host.querySelectorAll(
      '.ft-composer [data-captcha-host]',
    )
    expect(composerHosts).toHaveLength(0)
  })
})

// threadPage 构造一页线程响应，nextCursor 决定“加载更多”按钮是否出现。
function threadPage(nextCursor: string | null): {
  thread: ThreadMeta
  comments: Comment[]
  next_cursor: string | null
} {
  return {
    thread: {
      id: '1',
      site_id: '1',
      page_key: 'page',
      page_url: null,
      page_title: null,
      comments_enabled: true,
    },
    comments: [node({ id: '1' })],
    next_cursor: nextCursor,
  }
}

describe('FurtalkCommentsElement load-more button', () => {
  it('shows 加载更多 only when a next page exists', () => {
    const withMore = readyViewHost({
      comments: [node({ id: '1' })],
      thread: threadPage('c1'),
    })
    const loadMore = withMore.querySelector('.ft-loadmore')
    expect(loadMore).not.toBeNull()
    const button = loadMore?.querySelector<HTMLButtonElement>('button')
    expect(button?.textContent).toContain('加载更多')
    expect(button?.disabled).toBe(false)

    const withoutMore = readyViewHost({
      comments: [node({ id: '1' })],
      thread: threadPage(null),
    })
    expect(withoutMore.querySelector('.ft-loadmore')).toBeNull()
  })

  it('disables the button while a load-more request is in flight', () => {
    const host = readyViewHost({
      comments: [node({ id: '1' })],
      loadingMore: true,
      thread: threadPage('c1'),
    })
    const button = host.querySelector<HTMLButtonElement>('.ft-loadmore button')
    expect(button?.disabled).toBe(true)
    expect(button?.textContent).toContain('加载中…')
  })
})

describe('FurtalkCommentsElement load-more retry', () => {
  // loadMoreHost 为真实的 loadPage 调用准备元素（api 的 listComments 可以注入）。
  function loadMoreHost() {
    const element = document.createElement(COMPOSER_HOST_TAG) as unknown as {
      config: { siteId: string; pageKey: string; serviceOrigin: string }
      api: { listComments: ReturnType<typeof vi.fn> }
      state: WidgetState
      hints: ProfileHints
      loadPage(cursor?: string): Promise<void>
    }
    element.config = {
      siteId: '1',
      pageKey: 'page',
      serviceOrigin: 'https://comments.example',
    }
    element.hints = { email: '', nickname: '', website_url: '' }
    element.api = { listComments: vi.fn() }
    element.state = {
      status: 'ready',
      comments: [node({ id: '1' })],
      nextCursor: 'c1',
      sort: 'asc',
      loadingMore: false,
      authPhase: 'idle',
      pendingLikeIds: {},
      config: {
        site_id: '1',
        name: 'Site',
        comment_mode: 'anonymous',
        moderation: 'direct',
        user_delete_mode: 'soft',
        max_reply_depth: 5,
        captcha: { comment: { required: false } },
      },
      thread: threadPage('c1'),
    }
    return element
  }

  it('keeps the visible thread and the cursor after a failed load-more', async () => {
    const element = loadMoreHost()
    element.api.listComments.mockRejectedValue(new Error('offline'))

    await element.loadPage('c1')

    expect(element.api.listComments).toHaveBeenCalledWith(
      '1',
      'page',
      'c1',
      10,
      'asc',
    )
    expect(element.state.loadingMore).toBe(false)
    expect(element.state.comments.map((c) => c.id)).toEqual(['1'])
    expect(element.state.nextCursor).toBe('c1')
  })

  it('allows a retry that appends the next page without duplicates', async () => {
    const element = loadMoreHost()
    element.api.listComments
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        thread: threadPage(null).thread,
        comments: [node({ id: '1' }), node({ id: '2' })],
        next_cursor: null,
      })

    await element.loadPage('c1')
    expect(element.state.comments.map((c) => c.id)).toEqual(['1'])
    expect(element.state.nextCursor).toBe('c1')

    await element.loadPage('c1')
    expect(element.state.comments.map((c) => c.id)).toEqual(['1', '2'])
    expect(element.state.nextCursor).toBeNull()
    expect(element.state.loadingMore).toBe(false)
  })
})

describe('formatRelativeTime', () => {
  const baseTime = 1755500000000 // 2025-08-18T06:53:20.000Z

  it('formats seconds ago (<60s)', () => {
    const time = new Date(baseTime - 30 * 1000).toISOString()
    expect(formatRelativeTime(time, 'zh-CN', baseTime)).toBe('30秒前')
  })

  it('formats minutes ago (<60m)', () => {
    const time = new Date(baseTime - 15 * 60 * 1000).toISOString()
    expect(formatRelativeTime(time, 'zh-CN', baseTime)).toBe('15分钟前')
  })

  it('formats hours ago (<24h)', () => {
    const time = new Date(baseTime - 3 * 3600 * 1000).toISOString()
    expect(formatRelativeTime(time, 'zh-CN', baseTime)).toBe('3小时前')
  })

  it('formats days ago (<7d)', () => {
    const time = new Date(baseTime - 4 * 86400 * 1000).toISOString()
    expect(formatRelativeTime(time, 'zh-CN', baseTime)).toBe('4天前')
  })

  it('falls back to a localized date for older timestamps (>=7d)', () => {
    const oldTime = new Date(baseTime - 10 * 86400 * 1000)
    expect(formatRelativeTime(oldTime.toISOString(), 'zh-CN', baseTime)).toBe(
      oldTime.toLocaleDateString('zh-CN'),
    )
  })

  it('formats relative time in English', () => {
    const time = new Date(baseTime - 2 * 3600 * 1000).toISOString()
    expect(formatRelativeTime(time, 'en', baseTime)).toBe('2 hours ago')
  })

  it('handles invalid timestamps gracefully', () => {
    expect(formatRelativeTime('invalid-date', 'zh-CN', baseTime)).toBe(
      'invalid-date',
    )
  })
})

describe('FurtalkCommentsElement Like control', () => {
  interface LikeHostState {
    mode: 'anonymous' | 'authenticated'
    session?: WidgetSession
    pendingLikeIds?: Record<string, boolean>
    pendingPinIds?: Record<string, boolean>
  }

  function likeHost(comment: CommentNode, opts: LikeHostState): HTMLDivElement {
    const tagName = COMPOSER_HOST_TAG
    if (!customElements.get(tagName)) {
      customElements.define(tagName, FurtalkCommentsElement)
    }
    const element = document.createElement(tagName) as unknown as {
      state: WidgetState
      renderNode(n: CommentNode, s?: WidgetSession): TemplateResult
      deletingId: string | null
      language: SupportedLanguage
    }
    element.deletingId = null
    element.language = 'zh-CN'
    element.state = {
      status: 'ready',
      comments: [],
      nextCursor: null,
      sort: 'asc',
      loadingMore: false,
      authPhase: 'idle',
      pendingLikeIds: opts.pendingLikeIds ?? {},
      pendingPinIds: opts.pendingPinIds ?? {},
      config: {
        site_id: '1',
        name: 'Site',
        comment_mode: opts.mode,
        moderation: 'direct',
        user_delete_mode: 'soft',
        max_reply_depth: 5,
        captcha: { comment: { required: false } },
      },
      session: opts.session,
    }
    const template = element.renderNode(comment, opts.session)
    const host = document.createElement('div')
    render(template, host)
    return host
  }

  it('renders an interactive Like button in authenticated mode', () => {
    const host = likeHost(
      node({ id: '1', like_count: 2, liked_by_me: false }),
      { mode: 'authenticated' },
    )
    const button = host.querySelector<HTMLButtonElement>('.ft-like')
    expect(button).not.toBeNull()
    expect(button?.getAttribute('aria-pressed')).toBe('false')
    expect(button?.textContent).toContain('赞')
    expect(host.textContent).toContain('2')
  })

  it('renders the pin shortcut only for an existing administrator session', () => {
    const adminHost = likeHost(node({ id: '1' }), {
      mode: 'anonymous',
      session: {
        valid: true,
        credential_mode: 'authenticated',
        user_id: '10',
        site_id: '1',
        role: 'admin',
      },
    })
    expect(adminHost.textContent).toContain('置顶')

    const visitorHost = likeHost(node({ id: '1' }), { mode: 'anonymous' })
    expect(visitorHost.textContent).not.toContain('置顶')
  })

  it('reflects the liked state via aria-pressed and label', () => {
    const host = likeHost(node({ id: '1', like_count: 5, liked_by_me: true }), {
      mode: 'authenticated',
    })
    const button = host.querySelector<HTMLButtonElement>('.ft-like')
    expect(button?.getAttribute('aria-pressed')).toBe('true')
    expect(button?.getAttribute('aria-label')).toBe('取消点赞')
    expect(button?.textContent).toContain('5')
  })

  it('disables the button while a Like mutation is pending for that comment', () => {
    const host = likeHost(node({ id: '1', like_count: 1 }), {
      mode: 'authenticated',
      pendingLikeIds: { '1': true },
    })
    const button = host.querySelector<HTMLButtonElement>('.ft-like')
    expect(button?.disabled).toBe(true)
  })

  it('renders a read-only count for an anonymous ordinary visitor', () => {
    const host = likeHost(node({ id: '1', like_count: 3 }), {
      mode: 'anonymous',
    })
    expect(host.querySelector('.ft-like button')).toBeNull()
    const count = host.querySelector<HTMLElement>('.ft-like-count')
    expect(count?.textContent).toContain('3')
  })

  it('renders an interactive button for a valid anonymous administrator session', () => {
    const host = likeHost(node({ id: '1', like_count: 3 }), {
      mode: 'anonymous',
      session: {
        valid: true,
        credential_mode: 'authenticated',
        user_id: '1',
        site_id: '1',
        role: 'admin',
      },
    })
    expect(host.querySelector<HTMLButtonElement>('.ft-like')).not.toBeNull()
  })

  it('hides the Like control for deleted comments', () => {
    const host = likeHost(node({ id: '1', status: 'deleted', like_count: 1 }), {
      mode: 'authenticated',
    })
    expect(host.querySelector('.ft-like')).toBeNull()
  })
})

describe('FurtalkCommentsElement hot sort tab', () => {
  it('renders three peer sort tabs with hot as the active state', () => {
    const tagName = COMPOSER_HOST_TAG
    if (!customElements.get(tagName)) {
      customElements.define(tagName, FurtalkCommentsElement)
    }
    const element = document.createElement(tagName) as unknown as {
      state: WidgetState
      language: SupportedLanguage
      render(): TemplateResult
    }
    element.language = 'zh-CN'
    element.state = {
      status: 'ready',
      comments: [],
      nextCursor: null,
      sort: 'hot',
      loadingMore: false,
      authPhase: 'idle',
      pendingLikeIds: {},
      config: {
        site_id: '1',
        name: 'Site',
        comment_mode: 'authenticated',
        moderation: 'direct',
        user_delete_mode: 'soft',
        max_reply_depth: 5,
        captcha: { comment: { required: false } },
      },
    }
    const host = document.createElement('div')
    render(element.render(), host)
    const tabs = [
      ...host.querySelectorAll<HTMLButtonElement>('.ft-sort [data-sort]'),
    ]
    expect(tabs.map((t) => t.dataset.sort)).toEqual(['asc', 'desc', 'hot'])
    const hot = host.querySelector<HTMLButtonElement>('[data-sort="hot"]')
    expect(hot?.getAttribute('aria-pressed')).toBe('true')
    expect(hot?.textContent).toContain('最热')
  })
})

describe('FurtalkCommentsElement language control', () => {
  const MOUNTED_LANGUAGE_HOST_TAG = 'furtalk-comments-language-test'

  // 挂载交互测试需要独立的构造器，以便在不发起真实网络请求的前提下，
  // 使用真实的 Shadow DOM 事件边界。
  class MountedLanguageElement extends FurtalkCommentsElement {
    override boot(): void {}
  }
  if (!customElements.get(MOUNTED_LANGUAGE_HOST_TAG)) {
    customElements.define(MOUNTED_LANGUAGE_HOST_TAG, MountedLanguageElement)
  }

  interface LangComposer {
    comment: string
    body: string
    error: DisplayMessage | ''
    replyTargetId: string | null
  }

  interface LangInstance {
    state: WidgetState
    hints: ProfileHints
    configError: string | null
    language: SupportedLanguage
    languageMenuOpen: boolean
    widgetNotice: { text: DisplayMessage; reopenLogout?: boolean } | null
    captchaMaskKey: 'root' | 'reply' | null
    root: LangComposer
    render(): TemplateResult
    renderTrailingControls(): TemplateResult
    toggleLanguageMenu(): void
    setLanguageMenu(open: boolean): void
    selectLanguage(language: SupportedLanguage): void
  }

  function langInstance(
    overrides: Partial<WidgetState> = {},
    tagName: string = COMPOSER_HOST_TAG,
  ): LangInstance {
    const element = document.createElement(tagName) as unknown as LangInstance
    element.language = 'zh-CN'
    element.languageMenuOpen = false
    element.configError = null
    element.widgetNotice = null
    element.hints = { email: 'a@b.example', nickname: 'Alice', website_url: '' }
    element.captchaMaskKey = null
    element.root = { comment: '', body: '', error: '', replyTargetId: null }
    element.state = {
      status: 'ready',
      comments: [],
      nextCursor: null,
      sort: 'asc',
      loadingMore: false,
      authPhase: 'idle',
      pendingLikeIds: {},
      config: {
        site_id: '1',
        name: 'Site',
        comment_mode: 'anonymous',
        moderation: 'direct',
        user_delete_mode: 'soft',
        max_reply_depth: 5,
        captcha: { comment: { required: false } },
      },
      ...overrides,
    }
    return element
  }

  function renderHost(instance: LangInstance): HTMLDivElement {
    const host = document.createElement('div')
    render(instance.render(), host)
    return host
  }

  afterEach(() => {
    localStorage.clear()
    // 清理任何残留的 document 级菜单关闭监听器。
    document
      .querySelectorAll(COMPOSER_HOST_TAG)
      .forEach((element) => (element as unknown as { languageMenuOpen: boolean }).languageMenuOpen = false)
    document
      .querySelectorAll(MOUNTED_LANGUAGE_HOST_TAG)
      .forEach((element) => element.remove())
  })

  it('keeps the language trigger visible without a portal link for anonymous visitors', () => {
    const host = renderHost(langInstance())
    expect(host.querySelector('.ft-portal-link')).toBeNull()
    const trigger = host.querySelector<HTMLButtonElement>('.ft-lang-trigger')
    expect(trigger).not.toBeNull()
    expect(trigger?.querySelector('.ft-lang-icon')).not.toBeNull()
    expect(host.querySelector('.ft-trailing-controls')).not.toBeNull()
  })

  it('places the language trigger after the portal link for administrators', () => {
    const instance = langInstance({
      session: {
        valid: true,
        credential_mode: 'authenticated',
        role: 'admin',
      },
    })
    const host = renderHost(instance)
    const link = host.querySelector<HTMLAnchorElement>('.ft-portal-link')
    const trigger = host.querySelector<HTMLButtonElement>('.ft-lang-trigger')
    expect(link).not.toBeNull()
    expect(trigger).not.toBeNull()
    const controls = host.querySelector('.ft-trailing-controls')
    expect(controls?.children[0]).toBe(link)
    expect(controls?.children[1]?.querySelector('.ft-lang-trigger')).toBe(
      trigger,
    )
  })

  it('exposes an accessible name and expanded state on the trigger', () => {
    const instance = langInstance()
    const closed = renderHost(instance)
    const trigger = closed.querySelector<HTMLButtonElement>('.ft-lang-trigger')
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
    expect(trigger?.getAttribute('aria-label')).toBe('切换语言')

    instance.languageMenuOpen = true
    const opened = renderHost(instance)
    expect(
      opened.querySelector<HTMLButtonElement>('.ft-lang-trigger')?.getAttribute(
        'aria-expanded',
      ),
    ).toBe('true')
    expect(opened.querySelector('.ft-lang-menu')).not.toBeNull()
  })

  it('renders radio-style menu items with native labels and a selected state', () => {
    const instance = langInstance()
    instance.languageMenuOpen = true
    const host = renderHost(instance)
    const menu = host.querySelector<HTMLElement>('.ft-lang-menu')
    expect(menu?.getAttribute('role')).toBe('menu')
    expect(menu?.getAttribute('aria-label')).toBe('选择语言')
    const items = [
      ...host.querySelectorAll<HTMLButtonElement>(
        '.ft-lang-menu [role="menuitemradio"]',
      ),
    ]
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent?.trim()).toBe('简体中文')
    expect(items[0]?.getAttribute('aria-checked')).toBe('true')
    expect(items[1]?.textContent?.trim()).toBe('English')
    expect(items[1]?.getAttribute('aria-checked')).toBe('false')
  })

  it('closes the menu and restores focus to the trigger on Escape', () => {
    const instance = langInstance()
    instance.toggleLanguageMenu()
    expect(instance.languageMenuOpen).toBe(true)
    const host = renderHost(instance)
    host
      .querySelector<HTMLElement>('.ft-lang-menu')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(instance.languageMenuOpen).toBe(false)
  })

  it('retranslates visible local feedback and controls on switch without a reload', () => {
    const instance = langInstance()
    instance.root.error = localMessage('validate.email')
    instance.state = {
      ...instance.state,
      comments: [
        node({
          id: '1',
          created_at: '2026-08-14T00:00:00Z',
          published_at: '2026-08-14T00:00:00Z',
        }),
      ],
    }
    const zh = renderHost(instance)
    expect(zh.querySelector('.ft-error-text')?.textContent).toContain(
      '请填写有效的邮箱地址',
    )
    expect(
      zh.querySelector('[data-sort="asc"]')?.textContent?.trim(),
    ).toBe('最早')

    instance.selectLanguage('en')
    const en = renderHost(instance)
    expect(en.querySelector('.ft-error-text')?.textContent).toContain(
      'Please enter a valid email address',
    )
    expect(
      en.querySelector('[data-sort="asc"]')?.textContent?.trim(),
    ).toBe('Oldest')
    expect(
      en.querySelector<HTMLButtonElement>('.ft-lang-trigger')?.getAttribute(
        'aria-label',
      ),
    ).toBe('Change language')
  })

  it('retranslates an already-visible success notice on switch', () => {
    const instance = langInstance({
      notice: localMessage('notice.submissionPublished'),
    })
    const zh = renderHost(instance)
    expect(zh.querySelector('.ft-success')?.textContent).toContain('评论已发布。')
    instance.selectLanguage('en')
    const en = renderHost(instance)
    expect(en.querySelector('.ft-success')?.textContent).toContain(
      'Your comment has been published.',
    )
  })

  it('persists a manual selection to the widget-owned key', () => {
    const instance = langInstance()
    instance.selectLanguage('en')
    expect(localStorage.getItem('furtalk:language')).toBe('en')
    expect(instance.language).toBe('en')
    expect(instance.languageMenuOpen).toBe(false)
  })

  it('switches language through a mounted Shadow DOM pointer interaction', async () => {
    const instance = langInstance(
      {},
      MOUNTED_LANGUAGE_HOST_TAG,
    ) as LangInstance &
      HTMLElement & {
        shadowRoot: ShadowRoot
        updateComplete: Promise<unknown>
      }
    for (const key of [
      'siteId',
      'pageKey',
      'pageUrl',
      'pageTitle',
      'serviceOrigin',
    ]) {
      delete (instance as unknown as Record<string, unknown>)[key]
    }
    document.body.appendChild(instance)
    await instance.updateComplete

    const trigger =
      instance.shadowRoot.querySelector<HTMLButtonElement>('.ft-lang-trigger')
    expect(trigger).not.toBeNull()
    trigger?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    )
    await instance.updateComplete

    const menu = instance.shadowRoot.querySelector('.ft-lang-menu')
    const english = menu?.querySelector<HTMLButtonElement>(
      '[role="menuitemradio"][aria-checked="false"]',
    )
    expect(english).not.toBeNull()
    english?.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, composed: true }),
    )
    english?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true }),
    )
    await instance.updateComplete

    expect(
      instance.shadowRoot.querySelector('.ft-widget')?.getAttribute('lang'),
    ).toBe('en')
    expect(
      instance.shadowRoot
        .querySelector('[data-sort="asc"]')
        ?.textContent?.trim(),
    ).toBe('Oldest')
    expect(localStorage.getItem('furtalk:language')).toBe('en')
    expect(instance.languageMenuOpen).toBe(false)
    expect(instance.shadowRoot.querySelector('.ft-lang-menu')).toBeNull()
  })

  it('closes the mounted language menu on a true outside pointer', async () => {
    const instance = langInstance(
      {},
      MOUNTED_LANGUAGE_HOST_TAG,
    ) as LangInstance &
      HTMLElement & {
        shadowRoot: ShadowRoot
        updateComplete: Promise<unknown>
      }
    for (const key of [
      'siteId',
      'pageKey',
      'pageUrl',
      'pageTitle',
      'serviceOrigin',
    ]) {
      delete (instance as unknown as Record<string, unknown>)[key]
    }
    document.body.appendChild(instance)
    await instance.updateComplete

    instance.shadowRoot
      .querySelector<HTMLButtonElement>('.ft-lang-trigger')
      ?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, composed: true }),
      )
    await instance.updateComplete
    expect(instance.shadowRoot.querySelector('.ft-lang-menu')).not.toBeNull()

    document.body.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, composed: true }),
    )
    await instance.updateComplete
    expect(instance.languageMenuOpen).toBe(false)
    expect(instance.shadowRoot.querySelector('.ft-lang-menu')).toBeNull()
  })

  it('keeps drafts, comments, and ordering across a language switch', () => {
    const comments = [node({ id: '1' })]
    const instance = langInstance({ comments, sort: 'desc' })
    instance.root.body = 'draft body'
    instance.selectLanguage('en')
    expect(instance.state.comments).toHaveLength(1)
    expect(instance.state.sort).toBe('desc')
    expect(instance.root.body).toBe('draft body')
  })
})
