import { render, type TemplateResult } from 'lit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FurtalkCommentsElement } from '../src/element'
import { initialState, type WidgetState } from '../src/state'
import { localMessage, type SupportedLanguage } from '../src/i18n'
import type { ComposerState } from '../src/element-model'
import type {
  Comment,
  RepliesResponse,
  RootComment,
  RootThreadResponse,
  WidgetSession,
} from '../src/types'

const TAG = 'furtalk-comments-pagination-test'
if (!customElements.get(TAG)) customElements.define(TAG, FurtalkCommentsElement)

interface PaginationElement extends HTMLElement {
  state: WidgetState
  config: { siteId: string; pageKey: string; serviceOrigin: string }
  api: {
    listRootComments: ReturnType<typeof vi.fn>
    listReplies: ReturnType<typeof vi.fn>
    widgetSession: ReturnType<typeof vi.fn>
    runtimeConfig: ReturnType<typeof vi.fn>
    clearWidgetSession: ReturnType<typeof vi.fn>
    createComment: ReturnType<typeof vi.fn>
    likeComment: ReturnType<typeof vi.fn>
    pinComment: ReturnType<typeof vi.fn>
    deleteComment: ReturnType<typeof vi.fn>
  }
  language: SupportedLanguage
  root: ComposerState
  reply: ComposerState | null
  hints: { email: string; nickname: string; website_url: string }
  expandedRegions: Set<string>
  overflowingRegions: Set<string>
  load(): Promise<void>
  loadPage(cursor?: string): Promise<void>
  loadReplies(rootId: string, append?: boolean): Promise<void>
  probeSession(refreshOnChange?: boolean): Promise<boolean>
  performCreate(
    action: {
      type: 'create'
      parentId?: string
      body: string
      captchaToken: string
    },
    composer: ComposerState,
  ): Promise<void>
  performLike(commentId: string, like: boolean): Promise<void>
  performPin(commentId: string, pinned: boolean): Promise<void>
  deleteComment(commentId: string): Promise<void>
  clearWidgetSession(): Promise<void>
  handleSessionExpired(action: {
    type: 'like'
    commentId: string
    like: boolean
  }): void
  changeSort(sort: 'asc' | 'desc' | 'hot'): void
  disconnectedCallback(): void
  render(): TemplateResult
  boot(): void
  updateComplete: Promise<unknown>
}

function comment(id: string, partial: Partial<Comment> = {}): Comment {
  return {
    id,
    site_id: '1',
    thread_id: '1',
    user_id: '5',
    parent_id: null,
    root_id: null,
    depth: 0,
    body: `comment ${id}`,
    status: 'published',
    author_nickname: `author ${id}`,
    author_website: null,
    avatar_url: '',
    reply_to_user_id: null,
    reply_to_nickname: null,
    created_at: '2026-10-03T00:00:00Z',
    published_at: '2026-10-03T00:00:00Z',
    ...partial,
  }
}

function root(
  id: string,
  hasReplies = true,
  partial: Partial<Comment> = {},
): RootComment {
  return { ...comment(id, partial), has_replies: hasReplies }
}

function roots(
  comments: RootComment[],
  cursor: string | null = null,
): RootThreadResponse {
  return {
    thread: {
      id: '1',
      site_id: '1',
      page_key: 'page',
      page_url: null,
      page_title: null,
      comments_enabled: true,
    },
    comments,
    next_cursor: cursor,
  }
}

function replies(
  rootId: string,
  comments: Comment[],
  cursor: string | null = null,
): RepliesResponse {
  return { root_id: rootId, comments, next_cursor: cursor }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function element(): PaginationElement {
  const instance = document.createElement(TAG) as PaginationElement
  instance.config = {
    siteId: '1',
    pageKey: 'page',
    serviceOrigin: 'https://comments.example',
  }
  instance.language = 'zh-CN'
  instance.state = {
    ...initialState,
    repliesByRoot: {},
    status: 'ready',
    config: {
      site_id: '1',
      name: 'Site',
      comment_mode: 'authenticated',
      moderation: 'direct',
      user_delete_mode: 'soft',
      max_reply_depth: 3,
      captcha: { comment: { required: false } },
    },
  }
  instance.api = {
    listRootComments: vi.fn().mockResolvedValue(roots([])),
    listReplies: vi.fn().mockResolvedValue(replies('1', [])),
    widgetSession: vi.fn().mockResolvedValue({ valid: false }),
    runtimeConfig: vi.fn(),
    clearWidgetSession: vi.fn().mockResolvedValue(undefined),
    createComment: vi.fn(),
    likeComment: vi.fn(),
    pinComment: vi.fn(),
    deleteComment: vi.fn(),
  }
  return instance
}

function view(instance: PaginationElement): HTMLDivElement {
  const host = document.createElement('div')
  render(instance.render(), host)
  return host
}

function displayedRoots(host: ParentNode): string[] {
  return Array.from(
    host.querySelectorAll(
      '.ft-list > .ft-item > div > .ft-content > .ft-body, .ft-list > .ft-item > div > .ft-content > .ft-region .ft-body',
    ),
  ).map((item) => item.textContent?.trim() ?? '')
}

// 自动首批回复由 loadPage 发起；两轮微任务用于等待独立请求进入缓存。
async function settleReplies(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('root pages and automatic replies', () => {
  it('shows roots promptly and starts every reply preview directly without a request cap', async () => {
    const instance = element()
    const jobs = Array.from({ length: 10 }, () => deferred<RepliesResponse>())
    instance.api.listRootComments.mockResolvedValue(
      roots(Array.from({ length: 10 }, (_, index) => root(String(index + 1)))),
    )
    instance.api.listReplies.mockImplementation(
      (_site: string, _page: string, id: string) =>
        jobs[Number(id) - 1]?.promise,
    )
    await instance.loadPage()
    expect(instance.api.listRootComments).toHaveBeenCalledWith(
      '1',
      'page',
      undefined,
      10,
      'asc',
    )
    expect(instance.api.listReplies).toHaveBeenCalledTimes(10)
    expect(instance.state.comments).toHaveLength(10)
    expect(instance.state.status).toBe('ready')
    expect(view(instance).querySelectorAll('.ft-list > .ft-item')).toHaveLength(
      10,
    )
    for (let index = 0; index < jobs.length; index += 1) {
      const id = String(index + 1)
      expect(instance.api.listReplies).toHaveBeenCalledWith(
        '1',
        'page',
        id,
        undefined,
        10,
      )
      expect(instance.state.repliesByRoot[id]?.loading).toBe(true)
      jobs[index]?.resolve(
        replies(id, [
          comment(String(index + 20), { parent_id: id, root_id: id, depth: 1 }),
        ]),
      )
    }
    await settleReplies()
    expect(
      Object.values(instance.state.repliesByRoot).every(
        (page) => page.loaded && !page.loading,
      ),
    ).toBe(true)
    expect(instance.state.comments).toHaveLength(10)
  })

  it('skips no-reply roots and preserves old caches while appending roots', async () => {
    const instance = element()
    instance.api.listRootComments
      .mockResolvedValueOnce(roots([root('1'), root('2', false)], 'root-next'))
      .mockResolvedValueOnce(roots([root('1'), root('3')]))
    instance.api.listReplies.mockImplementation(
      (_site: string, _page: string, id: string) =>
        Promise.resolve(
          replies(
            id,
            [comment(`${id}0`, { parent_id: id, root_id: id, depth: 1 })],
            `${id}-reply-next`,
          ),
        ),
    )
    await instance.loadPage()
    await settleReplies()
    const firstCache = instance.state.repliesByRoot['1']
    await instance.loadPage('root-next')
    await settleReplies()
    expect(instance.state.comments.map((item) => item.id)).toEqual([
      '1',
      '2',
      '3',
    ])
    expect(instance.state.repliesByRoot['1']).toBe(firstCache)
    expect(instance.state.repliesByRoot['2']).toBeUndefined()
    expect(instance.api.listReplies.mock.calls.map((args) => args[2])).toEqual([
      '1',
      '3',
    ])
    expect(view(instance).querySelectorAll('.ft-list > .ft-item')).toHaveLength(
      3,
    )
  })

  it('loads a busy root in bounded pages without promoting missing-parent descendants', async () => {
    const instance = element()
    const all = Array.from({ length: 23 }, (_, index) =>
      comment(String(index + 2), {
        parent_id: index % 2 === 0 ? 'missing-intermediate' : '1',
        root_id: '1',
        depth: index % 2 === 0 ? 2 : 1,
        reply_to_nickname: 'missing author',
      }),
    )
    instance.api.listRootComments.mockResolvedValue(
      roots([root('1'), root('50', false)]),
    )
    instance.api.listReplies
      .mockResolvedValueOnce(replies('1', all.slice(0, 10), 'reply-10'))
      .mockResolvedValueOnce(
        replies('1', [all[9]!, ...all.slice(10, 19)], 'reply-19'),
      )
      .mockResolvedValueOnce(replies('1', all.slice(19)))
    await instance.loadPage()
    await settleReplies()
    const firstView = view(instance)
    expect(firstView.querySelectorAll('.ft-list > .ft-item')).toHaveLength(2)
    expect(
      firstView.querySelectorAll(
        '.ft-list > .ft-item:first-child .ft-children > .ft-item',
      ),
    ).toHaveLength(10)
    expect(firstView.textContent).toContain('回复 missing author')
    await instance.loadReplies('1', true)
    await instance.loadReplies('1', true)
    expect(instance.api.listReplies).toHaveBeenNthCalledWith(
      2,
      '1',
      'page',
      '1',
      'reply-10',
      10,
    )
    expect(instance.api.listReplies).toHaveBeenNthCalledWith(
      3,
      '1',
      'page',
      '1',
      'reply-19',
      10,
    )
    expect(instance.state.comments.map((item) => item.id)).toEqual(['1', '50'])
    expect(
      instance.state.repliesByRoot['1']?.comments.map((item) => item.id),
    ).toEqual(all.map((item) => item.id))
    expect(instance.state.repliesByRoot['1']?.nextCursor).toBeNull()
    expect(view(instance).querySelectorAll('.ft-list > .ft-item')).toHaveLength(
      2,
    )
    expect(
      view(instance).querySelectorAll('.ft-children > .ft-item'),
    ).toHaveLength(23)
  })

  it('sorts roots by pin/own likes and replies chronologically across all depths', async () => {
    const instance = element()
    instance.state.sort = 'hot'
    instance.api.listRootComments.mockResolvedValue(
      roots([
        root('1', true, { like_count: 2 }),
        root('2', false, { like_count: 5 }),
        root('3', false, { is_pinned: true }),
      ]),
    )
    instance.api.listReplies.mockResolvedValue(
      replies('1', [
        comment('11', {
          parent_id: '10',
          root_id: '1',
          depth: 2,
          like_count: 999,
        }),
        comment('10', { parent_id: '1', root_id: '1', depth: 1 }),
      ]),
    )
    await instance.loadPage()
    await settleReplies()
    const host = view(instance)
    expect(displayedRoots(host)).toEqual([
      'comment 3',
      'comment 2',
      'comment 1',
    ])
    expect(
      Array.from(host.querySelectorAll('.ft-children .ft-body')).map((item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(['comment 10', 'comment 11'])
    expect(host.querySelectorAll('.ft-list > .ft-item')).toHaveLength(3)
    instance.state.sort = 'desc'
    expect(displayedRoots(view(instance))).toEqual([
      'comment 3',
      'comment 2',
      'comment 1',
    ])
  })

  it('keeps a promoted root in the main list and uses stored depth for reply eligibility', async () => {
    const instance = element()
    instance.api.listRootComments.mockResolvedValue(
      roots([root('1', true, { parent_id: null, root_id: null, depth: 2 })]),
    )
    instance.api.listReplies.mockResolvedValue(
      replies('1', [comment('2', { parent_id: '1', root_id: '1', depth: 3 })]),
    )
    await instance.loadPage()
    await settleReplies()
    const host = view(instance)
    expect(host.querySelectorAll('.ft-list > .ft-item')).toHaveLength(1)
    expect(host.querySelectorAll('.ft-children > .ft-item')).toHaveLength(1)
    const rootButtons = host
      .querySelector('.ft-list > .ft-item > div')
      ?.querySelectorAll('button')
    expect(
      Array.from(rootButtons ?? []).some(
        (button) => button.textContent?.trim() === '回复',
      ),
    ).toBe(true)
    const replyButtons = host
      .querySelector('.ft-children > .ft-item')
      ?.querySelectorAll('button')
    expect(
      Array.from(replyButtons ?? []).some(
        (button) => button.textContent?.trim() === '回复',
      ),
    ).toBe(false)
  })
})

describe('independent failure and retry controls', () => {
  it('keeps reply errors local and retries the first page without blocking another root', async () => {
    const instance = element()
    instance.api.listRootComments.mockResolvedValue(
      roots([root('1'), root('2')], 'root-next'),
    )
    instance.api.listReplies.mockImplementation(
      (_site: string, _page: string, id: string) =>
        id === '1'
          ? Promise.reject(new Error('reply offline'))
          : Promise.resolve(
              replies(id, [
                comment('20', { parent_id: id, root_id: id, depth: 1 }),
              ]),
            ),
    )
    await instance.loadPage()
    await settleReplies()
    expect(instance.state.status).toBe('ready')
    expect(instance.state.repliesByRoot['1']?.error?.message).toBe(
      'reply offline',
    )
    expect(instance.state.repliesByRoot['2']?.loaded).toBe(true)
    const host = view(instance)
    expect(host.querySelectorAll('.ft-list > .ft-item')).toHaveLength(2)
    const retry = host.querySelector<HTMLButtonElement>(
      '.ft-replies-controls button',
    )
    expect(retry?.textContent).toContain('重试')
    instance.api.listReplies.mockResolvedValue(
      replies(
        '1',
        [comment('10', { parent_id: '1', root_id: '1', depth: 1 })],
        'reply-next',
      ),
    )
    retry?.click()
    await settleReplies()
    expect(instance.api.listReplies).toHaveBeenLastCalledWith(
      '1',
      'page',
      '1',
      undefined,
      10,
    )
    expect(instance.state.repliesByRoot['1']?.error).toBeUndefined()
    expect(instance.state.repliesByRoot['2']?.comments[0]?.id).toBe('20')
  })

  it('leaves pagination and retry controls outside clipping and expands manual appended replies', async () => {
    const instance = element()
    instance.api.listRootComments.mockResolvedValue(roots([root('1')]))
    instance.api.listReplies
      .mockResolvedValueOnce(
        replies(
          '1',
          [comment('10', { parent_id: '1', depth: 1 })],
          'reply-next',
        ),
      )
      .mockRejectedValueOnce(new Error('page offline'))
      .mockResolvedValueOnce(
        replies('1', [
          comment('10', { parent_id: '1', depth: 1 }),
          comment('11', { parent_id: 'missing', depth: 2 }),
        ]),
      )
    await instance.loadPage()
    await settleReplies()
    instance.overflowingRegions.add('children:1')
    let host = view(instance)
    expect(
      host
        .querySelector('.ft-region[data-region-kind="children"]')
        ?.classList.contains('overflow-hidden'),
    ).toBe(true)
    const more = host.querySelector<HTMLButtonElement>(
      '.ft-replies-controls button',
    )
    expect(more?.textContent).toContain('加载更多回复')
    expect(more?.closest('.ft-region')).toBeNull()
    more?.click()
    await settleReplies()
    expect(
      instance.state.repliesByRoot['1']?.comments.map((item) => item.id),
    ).toEqual(['10'])
    expect(instance.state.repliesByRoot['1']?.nextCursor).toBe('reply-next')
    host = view(instance)
    const retry = host.querySelector<HTMLButtonElement>(
      '.ft-replies-controls button',
    )
    expect(retry?.textContent).toContain('重试')
    expect(retry?.closest('.ft-region')).toBeNull()
    retry?.click()
    await settleReplies()
    expect(instance.api.listReplies).toHaveBeenLastCalledWith(
      '1',
      'page',
      '1',
      'reply-next',
      10,
    )
    expect(
      instance.state.repliesByRoot['1']?.comments.map((item) => item.id),
    ).toEqual(['10', '11'])
    expect(instance.expandedRegions.has('children:1')).toBe(true)
    expect(
      view(instance)
        .querySelector('.ft-region[data-region-kind="children"]')
        ?.classList.contains('overflow-hidden'),
    ).toBe(false)
  })

  it('disables only a pending root reply action while other roots remain independent', async () => {
    const instance = element()
    const first = deferred<RepliesResponse>()
    const second = deferred<RepliesResponse>()
    instance.api.listRootComments.mockResolvedValue(
      roots([root('1'), root('2')]),
    )
    instance.api.listReplies
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    await instance.loadPage()
    await instance.loadReplies('1')
    expect(instance.api.listReplies).toHaveBeenCalledTimes(2)
    const controls = view(instance).querySelectorAll<HTMLButtonElement>(
      '.ft-replies-controls button',
    )
    expect(controls).toHaveLength(2)
    expect(Array.from(controls).every((button) => button.disabled)).toBe(true)
    first.resolve(replies('1', []))
    second.resolve(replies('2', []))
    await settleReplies()
    expect(
      view(instance).querySelectorAll('.ft-replies-controls'),
    ).toHaveLength(0)
  })

  it('retains roots and retries the failed append cursor without duplicates', async () => {
    const instance = element()
    instance.api.listRootComments
      .mockResolvedValueOnce(roots([root('1', false)], 'root-next'))
      .mockRejectedValueOnce(new Error('root offline'))
      .mockResolvedValueOnce(roots([root('1', false), root('2', false)]))
    await instance.loadPage()
    await instance.loadPage('root-next')
    expect(instance.state.comments.map((item) => item.id)).toEqual(['1'])
    expect(instance.state.nextCursor).toBe('root-next')
    expect(instance.state.commentsError?.message).toBe('root offline')
    const host = view(instance)
    expect(host.querySelector('.ft-loadmore button')?.textContent).toContain(
      '重试',
    )
    host.querySelector<HTMLButtonElement>('.ft-loadmore button')?.click()
    await settleReplies()
    expect(instance.api.listRootComments).toHaveBeenLastCalledWith(
      '1',
      'page',
      'root-next',
      10,
      'asc',
    )
    expect(instance.state.comments.map((item) => item.id)).toEqual(['1', '2'])
  })

  it('retries a failed fresh refresh from the first page even with an old root cursor', async () => {
    const instance = element()
    instance.api.listRootComments
      .mockResolvedValueOnce(roots([root('1', false)], 'old-cursor'))
      .mockRejectedValueOnce(new Error('refresh offline'))
      .mockResolvedValueOnce(roots([root('2', false)]))
    await instance.loadPage()
    await instance.loadPage()
    expect(instance.state.comments.map((item) => item.id)).toEqual(['1'])
    view(instance)
      .querySelector<HTMLButtonElement>('.ft-loadmore button')
      ?.click()
    await settleReplies()
    expect(instance.api.listRootComments).toHaveBeenLastCalledWith(
      '1',
      'page',
      undefined,
      10,
      'asc',
    )
    expect(instance.state.comments.map((item) => item.id)).toEqual(['2'])
  })
})

describe('stale paging completions', () => {
  it.each(['resolve', 'reject'] as const)(
    'ignores an old root %s without settling a newer sort request',
    async (outcome) => {
      const instance = element()
      const old = deferred<RootThreadResponse>()
      const fresh = deferred<RootThreadResponse>()
      instance.api.listRootComments
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(fresh.promise)
      const previous = instance.loadPage()
      instance.changeSort('desc')
      if (outcome === 'resolve') old.resolve(roots([root('1')]))
      else old.reject(new Error('stale root error'))
      await previous
      expect(instance.state.loadingComments).toBe(true)
      expect(instance.state.comments).toEqual([])
      expect(instance.state.error).toBeUndefined()
      expect(instance.api.listReplies).not.toHaveBeenCalled()
      fresh.resolve(roots([root('2', false)]))
      await settleReplies()
      expect(instance.state.comments.map((item) => item.id)).toEqual(['2'])
      expect(instance.state.loadingComments).toBe(false)
    },
  )

  it.each(['resolve', 'reject'] as const)(
    'ignores an old reply %s without settling a newer same-root request',
    async (outcome) => {
      const instance = element()
      const old = deferred<RepliesResponse>()
      const fresh = deferred<RepliesResponse>()
      instance.api.listRootComments.mockResolvedValue(roots([root('1')]))
      instance.api.listReplies
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(fresh.promise)
      await instance.loadPage()
      await instance.loadPage()
      if (outcome === 'resolve')
        old.resolve(replies('1', [comment('stale', { parent_id: '1' })]))
      else old.reject(new Error('stale reply error'))
      await settleReplies()
      expect(instance.state.repliesByRoot['1']?.loading).toBe(true)
      expect(instance.state.repliesByRoot['1']?.comments).toEqual([])
      expect(instance.state.repliesByRoot['1']?.error).toBeUndefined()
      fresh.resolve(replies('1', [comment('fresh', { parent_id: '1' })]))
      await settleReplies()
      expect(
        instance.state.repliesByRoot['1']?.comments.map((item) => item.id),
      ).toEqual(['fresh'])
    },
  )

  it('invalidates a pending root and reply on disconnect', async () => {
    const instance = element()
    const oldReply = deferred<RepliesResponse>()
    const oldRoot = deferred<RootThreadResponse>()
    instance.api.listRootComments
      .mockResolvedValueOnce(roots([root('1')], 'root-next'))
      .mockReturnValueOnce(oldRoot.promise)
    instance.api.listReplies.mockReturnValue(oldReply.promise)
    await instance.loadPage()
    const append = instance.loadPage('root-next')
    instance.disconnectedCallback()
    oldRoot.resolve(roots([root('2')]))
    oldReply.reject(new Error('detached reply error'))
    await append
    await settleReplies()
    expect(instance.state.comments.map((item) => item.id)).toEqual(['1'])
    expect(instance.state.repliesByRoot).toEqual({})
    expect(instance.state.loadingMore).toBe(false)
    expect(instance.state.commentsError).toBeUndefined()
  })

  it('ignores stale configuration completion after a newer load begins', async () => {
    const instance = element()
    const old = deferred<WidgetState['config']>()
    instance.api.runtimeConfig
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(instance.state.config)
    const previous = instance.load()
    await instance.load()
    old.resolve({ ...instance.state.config!, comment_sort: 'hot' })
    await previous
    expect(instance.state.sort).toBe('asc')
    expect(instance.api.listRootComments).toHaveBeenCalledTimes(1)
    expect(instance.state.status).toBe('ready')
  })

  it('keeps an existing root page reachable when configuration reload succeeds but roots fail', async () => {
    const instance = element()
    instance.api.listRootComments
      .mockResolvedValueOnce(roots([root('1', false)], 'root-next'))
      .mockRejectedValueOnce(new Error('root offline'))
    await instance.loadPage()
    instance.api.runtimeConfig.mockResolvedValue(instance.state.config)
    await instance.load()
    expect(instance.state.status).toBe('ready')
    expect(instance.state.comments.map((item) => item.id)).toEqual(['1'])
    expect(
      view(instance).querySelector('.ft-loadmore button')?.textContent,
    ).toContain('重试')
  })

  it('suppresses a duplicate root append while that cursor is pending', async () => {
    const instance = element()
    const job = deferred<RootThreadResponse>()
    instance.api.listRootComments
      .mockResolvedValueOnce(roots([root('1', false)], 'root-next'))
      .mockReturnValueOnce(job.promise)
    await instance.loadPage()
    const append = instance.loadPage('root-next')
    await instance.loadPage('root-next')
    expect(instance.api.listRootComments).toHaveBeenCalledTimes(2)
    job.resolve(roots([root('2', false)]))
    await append
    expect(instance.state.comments.map((item) => item.id)).toEqual(['1', '2'])
  })
})

describe('viewer changes and mounted reply controls', () => {
  it.each(['resolve', 'reject'] as const)(
    'invalidates a pending sort root %s when the viewer changes before thread metadata returns',
    async (outcome) => {
      const instance = element()
      const old = deferred<RootThreadResponse>()
      const fresh = deferred<RootThreadResponse>()
      instance.api.listRootComments
        .mockResolvedValueOnce(roots([root('1', false)]))
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(fresh.promise)
      await instance.loadPage()
      instance.state.session = { valid: false }
      instance.changeSort('desc')
      expect(instance.state.thread).toBeUndefined()
      instance.api.widgetSession.mockResolvedValue({
        valid: true,
        user_id: '9',
        site_id: '1',
        credential_mode: 'authenticated',
      } satisfies WidgetSession)
      await instance.probeSession()
      expect(instance.api.listRootComments).toHaveBeenCalledTimes(3)
      if (outcome === 'resolve') old.resolve(roots([root('old-viewer')]))
      else old.reject(new Error('old viewer error'))
      await settleReplies()
      expect(instance.state.comments).toEqual([])
      expect(instance.state.loadingComments).toBe(true)
      expect(instance.state.error).toBeUndefined()
      expect(instance.state.commentsError).toBeUndefined()
      expect(instance.api.listReplies).not.toHaveBeenCalled()
      fresh.resolve(roots([root('2', false, { liked_by_me: true })]))
      await settleReplies()
      expect(instance.state.comments).toMatchObject([
        { id: '2', liked_by_me: true },
      ])
      expect(instance.state.loadingComments).toBe(false)
    },
  )

  it('refreshes a changed viewer while preserving auth state, composers and notices', async () => {
    const instance = element()
    const old = deferred<RepliesResponse>()
    instance.api.listRootComments.mockResolvedValue(roots([root('1')]))
    instance.api.listReplies
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(
        replies('1', [
          comment('new-viewer', { liked_by_me: true, parent_id: '1' }),
        ]),
      )
    await instance.loadPage()
    instance.state = {
      ...instance.state,
      session: { valid: false },
      status: 'authenticating',
      pendingAction: { type: 'like', commentId: '1', like: true },
      notice: localMessage('notice.submissionPublished'),
    }
    instance.root.body = 'unfinished composer'
    instance.api.widgetSession.mockResolvedValue({
      valid: true,
      user_id: '9',
      site_id: '1',
      credential_mode: 'authenticated',
    } satisfies WidgetSession)
    await instance.probeSession()
    await settleReplies()
    old.resolve(replies('1', [comment('old-viewer', { parent_id: '1' })]))
    await settleReplies()
    expect(instance.api.listRootComments).toHaveBeenCalledTimes(2)
    expect(instance.state.status).toBe('authenticating')
    expect(instance.state.pendingAction).toEqual({
      type: 'like',
      commentId: '1',
      like: true,
    })
    expect(instance.root.body).toBe('unfinished composer')
    expect(instance.state.notice).toEqual(
      localMessage('notice.submissionPublished'),
    )
    expect(
      instance.state.repliesByRoot['1']?.comments.map((item) => item.id),
    ).toEqual(['new-viewer'])
    await instance.probeSession()
    expect(instance.api.listRootComments).toHaveBeenCalledTimes(2)
  })

  it('invalidates cached viewer replies when logout completes', async () => {
    const instance = element()
    const old = deferred<RepliesResponse>()
    instance.api.listRootComments.mockResolvedValue(roots([root('1')]))
    instance.api.listReplies
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(replies('1', []))
    await instance.loadPage()
    instance.state = {
      ...instance.state,
      session: {
        valid: true,
        user_id: '9',
        site_id: '1',
        credential_mode: 'authenticated',
      },
    }
    await instance.clearWidgetSession()
    await settleReplies()
    old.reject(new Error('old viewer failure'))
    await settleReplies()
    expect(instance.state.session?.valid).toBe(false)
    expect(instance.state.repliesByRoot['1']?.comments).toEqual([])
    expect(instance.state.repliesByRoot['1']?.error).toBeUndefined()
  })

  it('renders independent reply pagination and translated controls in a real Shadow DOM', async () => {
    const instance = element()
    instance.boot = () => undefined
    // 与已有 Lit 挂载测试一致，移除属性类字段遮蔽后触发真实更新。
    for (const key of [
      'siteId',
      'pageKey',
      'pageUrl',
      'pageTitle',
      'serviceOrigin',
    ])
      delete (instance as unknown as Record<string, unknown>)[key]
    document.body.appendChild(instance)
    instance.api.listRootComments.mockResolvedValue(roots([root('1')]))
    instance.api.listReplies
      .mockResolvedValueOnce(
        replies(
          '1',
          [comment('10', { parent_id: '1', depth: 1 })],
          'reply-next',
        ),
      )
      .mockResolvedValueOnce(
        replies('1', [comment('11', { parent_id: 'missing', depth: 2 })]),
      )
    await instance.loadPage()
    await settleReplies()
    await instance.updateComplete
    const button = instance.shadowRoot?.querySelector<HTMLButtonElement>(
      '.ft-replies-controls button',
    )
    expect(button?.textContent).toContain('加载更多回复')
    expect(button?.closest('.ft-region')).toBeNull()
    button?.click()
    await settleReplies()
    await instance.updateComplete
    expect(
      instance.shadowRoot?.querySelectorAll('.ft-list > .ft-item'),
    ).toHaveLength(1)
    expect(
      instance.shadowRoot?.querySelectorAll('.ft-children > .ft-item'),
    ).toHaveLength(2)
    instance.language = 'en'
    instance.state.repliesByRoot['1'] = {
      ...instance.state.repliesByRoot['1']!,
      nextCursor: 'another-page',
    }
    expect(
      view(instance).querySelector('.ft-replies-controls button')?.textContent,
    ).toContain('Load more replies')
  })
})

describe('mutation refreshes with independent reply caches', () => {
  it('settles a reply like in place without ranking its root by descendant likes', async () => {
    const instance = element()
    instance.api.listRootComments.mockResolvedValue(roots([root('1')]))
    instance.api.listReplies.mockResolvedValue(
      replies(
        '1',
        [comment('10', { parent_id: '1', depth: 1, like_count: 1 })],
        'reply-next',
      ),
    )
    await instance.loadPage()
    await settleReplies()
    instance.api.likeComment.mockResolvedValue({
      comment_id: '10',
      like_count: 3,
      liked: true,
    })
    await instance.performLike('10', true)
    expect(instance.state.repliesByRoot['1']?.comments[0]).toMatchObject({
      id: '10',
      liked_by_me: true,
      like_count: 3,
    })
    expect(instance.state.repliesByRoot['1']?.nextCursor).toBe('reply-next')
    expect(instance.state.comments[0]?.like_count).toBeUndefined()
    expect(instance.api.listRootComments).toHaveBeenCalledTimes(1)
    expect(
      view(instance)
        .querySelector('.ft-children .ft-like')
        ?.getAttribute('aria-pressed'),
    ).toBe('true')
  })

  it('retains a published reply success notice through real first-page refresh and previews', async () => {
    const instance = element()
    const old = deferred<RepliesResponse>()
    instance.api.listRootComments.mockResolvedValue(roots([root('1')]))
    instance.api.listReplies
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(
        replies('1', [comment('new-reply', { parent_id: '1', depth: 1 })]),
      )
    await instance.loadPage()
    instance.hints = {
      email: 'author@example.com',
      nickname: 'Author',
      website_url: '',
    }
    const composer: ComposerState = {
      body: 'new reply',
      comment: '',
      error: '',
      replyTargetId: '1',
    }
    instance.reply = composer
    instance.api.createComment.mockResolvedValue(
      comment('new-reply', { parent_id: '1', depth: 1 }),
    )
    await instance.performCreate(
      { type: 'create', parentId: '1', body: 'new reply', captchaToken: '' },
      composer,
    )
    await settleReplies()
    old.resolve(
      replies('1', [comment('old-reply', { parent_id: '1', depth: 1 })]),
    )
    await settleReplies()
    expect(instance.api.listRootComments).toHaveBeenCalledTimes(2)
    expect(instance.state.notice).toEqual(
      localMessage('notice.submissionPublished'),
    )
    expect(instance.reply).toBeNull()
    expect(
      instance.state.repliesByRoot['1']?.comments.map((item) => item.id),
    ).toEqual(['new-reply'])
    expect(view(instance).querySelector('.ft-success')?.textContent).toContain(
      '评论已发布。',
    )
  })

  it('refreshes a pin and deletion using the root endpoint while dropping incompatible replies', async () => {
    const instance = element()
    const admin = {
      valid: true,
      credential_mode: 'authenticated',
      user_id: '9',
      site_id: '1',
      role: 'admin',
    } satisfies WidgetSession
    instance.state.session = admin
    instance.api.listRootComments
      .mockResolvedValueOnce(roots([root('1')]))
      .mockResolvedValueOnce(roots([root('1', true, { is_pinned: true })]))
      .mockResolvedValueOnce(roots([]))
    instance.api.listReplies.mockResolvedValue(
      replies('1', [comment('10', { parent_id: '1', depth: 1 })]),
    )
    await instance.loadPage()
    await settleReplies()
    instance.api.pinComment.mockResolvedValue({
      comment_id: '1',
      is_pinned: true,
    })
    await instance.performPin('1', true)
    await settleReplies()
    expect(instance.state.comments[0]?.is_pinned).toBe(true)
    expect(instance.api.listReplies).toHaveBeenCalledTimes(2)
    instance.api.deleteComment.mockResolvedValue({
      deleted_root_id: '1',
      hard: false,
    })
    await instance.deleteComment('1')
    expect(instance.state.comments).toEqual([])
    expect(instance.state.repliesByRoot).toEqual({})
    expect(instance.api.listRootComments).toHaveBeenCalledTimes(3)
  })
})
