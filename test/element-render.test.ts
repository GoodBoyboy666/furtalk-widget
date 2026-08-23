import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'lit'
import type { TemplateResult } from 'lit'
import { FurtalkCommentsElement, formatRelativeTime } from '../src/element'
import type { CommentNode } from '../src/comments'
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
// 以便断言 Markdown 输出在 DOM 边界以 HTML 而非转义文本呈现。
// session 与 deletingId 用于覆盖删除确认态与所有权渲染分支。
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
  }
  element.deletingId = deletingId
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
    // 唯一的 img 是作者头像，恶意 raw HTML 必须被转义为文本而非 DOM。
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
      emojiCatalog: {
        packs: unknown[]
        imageByToken: Map<string, { id: string; name: string; src: string }>
      }
    }
    element.deletingId = null
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
    // 旧缓存响应在滚动发布期间可能缺 author_role，必须安全降级为不显示。
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
    // 该情形与软删除压缩无关，Widget 根级兜底仍成立。
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
    // 软删除压缩后补位到根的评论 parent_id 为 null，即使持久化 depth > 0
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
    // A stale anonymous credential or missing credential_mode must never
    // project ownership; the server stays authoritative for deletion.
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
// 在两种评论模式下都常驻可见、无折叠开关、无独立保存按钮。
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
    renderRootComposer(): TemplateResult
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
    widgetNotice: { text: string; reopenLogout?: boolean } | null
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
    expect(instance.widgetNotice?.text).toContain('退出登录失败')
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
    expect(instance.widgetNotice?.text).toContain('浏览器拦截')
    expect(instance.widgetNotice?.reopenLogout).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The widget session is still cleared by its own request result.
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
    expect(composer.error).toBe('请填写有效的昵称')
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

    // ensureAuthenticated is stubbed to succeed, so the retry re-runs and gets
    // need_auth_code again: the flow must stop instead of looping forever.
    expect(createMock).toHaveBeenCalledTimes(2)
    expect(composer.error).toBe('授权未生效，请重试')
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

    expect(instance.state.notice).toBe('评论已发布。')
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

    expect(instance.state.notice).toBe('评论已提交，等待审核。')
  })

  it('clears a stale success notice when a new submission fails', async () => {
    const instance = createInstance('anonymous')
    instance.state = { ...instance.state, notice: '评论已发布。' }
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
    instance.state = { ...instance.state, notice: '评论已发布。' }
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
      renderNode(n: CommentNode, s?: WidgetSession): TemplateResult
    }
    element.reply = { comment: '', body: '', error: '', replyTargetId: '1' }
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

// readyViewHost 直接渲染 ready 状态的整页视图，用于断言评论框下方排序控件与
// 成功 notice 的 DOM 呈现。
interface ReadyViewInstance {
  state: WidgetState
  hints: ProfileHints
  configError: string | null
  widgetNotice: { text: string; reopenLogout?: boolean } | null
  captchaMaskKey: 'root' | 'reply' | null
  render(): TemplateResult
}

function readyViewHost(overrides: Partial<WidgetState> = {}): HTMLDivElement {
  const element = document.createElement(
    COMPOSER_HOST_TAG,
  ) as unknown as ReadyViewInstance
  element.configError = null
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

// maskedViewHost 渲染 ready 视图并预置打开的掩膜 key，用于断言掩膜
// 恰好渲染一次且位于 Widget 根级（空评论区与多评论场景都不重复渲染）。
function maskedViewHost(
  key: 'root' | 'reply',
  overrides: Partial<WidgetState> = {},
): HTMLDivElement {
  const element = document.createElement(
    COMPOSER_HOST_TAG,
  ) as unknown as ReadyViewInstance
  element.configError = null
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

  // FurtalkCommentsElement is already registered under other test tags in this
  // suite, and a custom element constructor can only be registered once.
  // Subclass it so this tag gets a distinct, registerable constructor.
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
    // Avoid the real boot/network path; we only assert on the render root.
    element.boot = () => undefined
    // The widget declares its reactive attributes both as class fields and in
    // `static properties`. That shadows Lit's reactive accessors, which the
    // dev-mode build rejects when an instance is connected. Delete the own
    // fields so the first update path can run (production builds are unaffected).
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
    // 这些由 mask 模板上的 `fixed inset-0` 静态工具类编译而来。
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
    expect(asc?.textContent?.trim()).toBe('最早优先')
    expect(desc?.textContent?.trim()).toBe('最新优先')
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
    const host = readyViewHost({ notice: '评论已发布。' })
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
    // 空评论区时 renderNode 不运行，掩膜必须由 Widget 根级渲染恰好一次。
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
    // 内联 composer 中不允许出现 data-captcha-host；只有掩膜内宿主存在。
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
  // loadMoreHost 构造真实 loadPage 所需的 element（api 的 listComments 可注入）。
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
    expect(formatRelativeTime(time, baseTime)).toBe('30秒前')
  })

  it('formats minutes ago (<60m)', () => {
    const time = new Date(baseTime - 15 * 60 * 1000).toISOString()
    expect(formatRelativeTime(time, baseTime)).toBe('15分钟前')
  })

  it('formats hours ago (<24h)', () => {
    const time = new Date(baseTime - 3 * 3600 * 1000).toISOString()
    expect(formatRelativeTime(time, baseTime)).toBe('3小时前')
  })

  it('formats days ago (<7d)', () => {
    const time = new Date(baseTime - 4 * 86400 * 1000).toISOString()
    expect(formatRelativeTime(time, baseTime)).toBe('4天前')
  })

  it('falls back to localized date for older timestamps (>=7d)', () => {
    const oldTime = new Date(baseTime - 10 * 86400 * 1000)
    expect(formatRelativeTime(oldTime.toISOString(), baseTime)).toBe(
      oldTime.toLocaleDateString(),
    )
  })

  it('handles invalid timestamps gracefully', () => {
    expect(formatRelativeTime('invalid-date', baseTime)).toBe('invalid-date')
  })
})

describe('FurtalkCommentsElement Like control', () => {
  interface LikeHostState {
    mode: 'anonymous' | 'authenticated'
    session?: WidgetSession
    pendingLikeIds?: Record<string, boolean>
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
    }
    element.deletingId = null
    element.state = {
      status: 'ready',
      comments: [],
      nextCursor: null,
      sort: 'asc',
      loadingMore: false,
      authPhase: 'idle',
      pendingLikeIds: opts.pendingLikeIds ?? {},
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
      render(): TemplateResult
    }
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
