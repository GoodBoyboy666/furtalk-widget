import { describe, expect, it } from 'vitest'

import { WidgetError } from '../src/errors'
import { initialState, widgetReducer } from '../src/state'
import type { Comment, ThreadResponse } from '../src/types'

function thread(overrides?: Partial<ThreadResponse>): ThreadResponse {
  return {
    thread: {
      id: '1',
      site_id: '1',
      page_key: 'page',
      page_url: null,
      page_title: null,
      comments_enabled: true,
    },
    comments: [],
    next_cursor: null,
    ...overrides,
  }
}

function comment(id: string): Comment {
  return {
    id,
    site_id: '1',
    thread_id: '1',
    user_id: '10',
    parent_id: null,
    root_id: null,
    depth: 0,
    body: 'body',
    status: 'published',
    author_nickname: 'n',
    author_website: null,
    avatar_url: '',
    reply_to_user_id: null,
    reply_to_nickname: null,
    created_at: '2026-08-11T00:00:00Z',
    published_at: null,
  }
}

describe('widgetReducer', () => {
  it('follows boot -> loading-config -> loading-thread -> ready', () => {
    let state = widgetReducer(initialState, { type: 'config/loading' })
    expect(state.status).toBe('loading-config')
    state = widgetReducer(state, { type: 'config/loaded', config: {} as never })
    expect(state.status).toBe('loading-thread')
    state = widgetReducer(state, { type: 'thread/loaded', thread: thread() })
    expect(state.status).toBe('ready')
    expect(state.comments).toEqual([])
  })

  it('replaces the thread on a fresh load', () => {
    const state = widgetReducer(initialState, {
      type: 'thread/loaded',
      thread: thread({
        comments: [comment('1'), comment('2')],
        next_cursor: 'c1',
      }),
    })
    expect(state.comments.map((c) => c.id)).toEqual(['1', '2'])
    expect(state.nextCursor).toBe('c1')
  })

  it('appends cursor pages without duplicates', () => {
    let state = widgetReducer(initialState, {
      type: 'thread/loaded',
      thread: thread({
        comments: [comment('1'), comment('2')],
        next_cursor: 'c1',
      }),
    })
    state = widgetReducer(state, { type: 'thread/load-more' })
    expect(state.loadingMore).toBe(true)
    state = widgetReducer(state, {
      type: 'thread/appended',
      thread: thread({
        comments: [comment('2'), comment('3')],
        next_cursor: 'c2',
      }),
    })
    expect(state.comments.map((c) => c.id)).toEqual(['1', '2', '3'])
    expect(state.nextCursor).toBe('c2')
    expect(state.loadingMore).toBe(false)
  })

  it('clears the error when retrying', () => {
    let state = widgetReducer(initialState, {
      type: 'error',
      error: new WidgetError({ code: 'network', message: 'offline' }),
    })
    expect(state.status).toBe('error')
    state = widgetReducer(state, { type: 'config/loading' })
    expect(state.status).toBe('loading-config')
    expect(state.error).toBeUndefined()
  })

  it('moves through authenticating and mutation statuses', () => {
    let state = widgetReducer(initialState, { type: 'authenticating' })
    expect(state.status).toBe('authenticating')
    state = widgetReducer(state, {
      type: 'auth/settled',
      session: { valid: true, credential_mode: 'authenticated', user_id: '10' },
    })
    expect(state.status).toBe('ready')
    expect(state.session?.credential_mode).toBe('authenticated')

    state = widgetReducer(state, { type: 'create/pending' })
    expect(state.status).toBe('creating')
    state = widgetReducer(state, { type: 'create/settled' })
    expect(state.status).toBe('ready')

    state = widgetReducer(state, { type: 'delete/pending' })
    expect(state.status).toBe('deleting')
    state = widgetReducer(state, { type: 'delete/settled' })
    expect(state.status).toBe('ready')
  })

  it('stores the probed session', () => {
    const state = widgetReducer(initialState, {
      type: 'session/probed',
      session: { valid: false },
    })
    expect(state.session?.valid).toBe(false)
  })

  it('tracks the popup authorization phase and recovers to ready', () => {
    let state = widgetReducer(initialState, { type: 'auth/opening' })
    expect(state.status).toBe('authenticating')
    expect(state.authPhase).toBe('opening')
    state = widgetReducer(state, { type: 'auth/waiting' })
    expect(state.authPhase).toBe('waiting')
    state = widgetReducer(state, { type: 'auth/exchanging' })
    expect(state.authPhase).toBe('exchanging')
    state = widgetReducer(state, {
      type: 'auth/settled',
      session: { valid: true, credential_mode: 'authenticated', user_id: '10' },
    })
    expect(state.status).toBe('ready')
    expect(state.authPhase).toBe('idle')
  })

  it('records recoverable popup outcomes without losing the thread', () => {
    let state = widgetReducer(initialState, {
      type: 'thread/loaded',
      thread: thread(),
    })
    for (const phase of [
      'cancelled',
      'blocked',
      'closed',
      'expired',
      'unsupported',
    ] as const) {
      state = widgetReducer(state, { type: `auth/${phase}` } as never)
      expect(state.status).toBe('ready')
      expect(state.authPhase).toBe(phase)
    }
  })

  it('stores and clears the pending action', () => {
    let state = widgetReducer(initialState, {
      type: 'pending/set',
      action: { type: 'create', body: 'hi', captchaToken: '' },
    })
    expect(state.pendingAction).toEqual({
      type: 'create',
      body: 'hi',
      captchaToken: '',
    })
    state = widgetReducer(state, { type: 'pending/clear' })
    expect(state.pendingAction).toBeUndefined()
  })

  it('sets and clears the moderation notice', () => {
    let state = widgetReducer(initialState, {
      type: 'notice/set',
      notice: '评论已提交，等待审核。',
    })
    expect(state.notice).toContain('待审核')
    state = widgetReducer(state, { type: 'notice/clear' })
    expect(state.notice).toBeUndefined()
  })

  it('adopts the configured default sort direction from the runtime config', () => {
    const asc = widgetReducer(initialState, {
      type: 'config/loaded',
      config: { comment_sort: 'asc' } as never,
    })
    expect(asc.sort).toBe('asc')

    const desc = widgetReducer(initialState, {
      type: 'config/loaded',
      config: { comment_sort: 'desc' } as never,
    })
    expect(desc.sort).toBe('desc')

    // Pre-rollout backends omit comment_sort; the compatibility default is asc.
    const missing = widgetReducer(initialState, {
      type: 'config/loaded',
      config: {} as never,
    })
    expect(missing.sort).toBe('asc')

    // Unknown values fail closed to asc.
    const invalid = widgetReducer(initialState, {
      type: 'config/loaded',
      config: { comment_sort: 'sideways' } as never,
    })
    expect(invalid.sort).toBe('asc')
  })

  it('switches direction and discards the old cursor and comments', () => {
    let state = widgetReducer(initialState, {
      type: 'thread/loaded',
      thread: thread({
        comments: [comment('1'), comment('2')],
        next_cursor: 'c1',
      }),
    })
    state = widgetReducer(state, { type: 'sort/change', sort: 'desc' })
    expect(state.sort).toBe('desc')
    expect(state.comments).toEqual([])
    expect(state.nextCursor).toBeNull()
    expect(state.thread).toBeUndefined()
    expect(state.status).toBe('ready')
    expect(state.loadingComments).toBe(true)
  })

  it('keeps the current state when switching to the same direction', () => {
    let state = widgetReducer(initialState, {
      type: 'thread/loaded',
      thread: thread({
        comments: [comment('1')],
        next_cursor: 'c1',
      }),
    })
    state = widgetReducer(state, { type: 'sort/change', sort: 'asc' })
    expect(state.comments.map((c) => c.id)).toEqual(['1'])
    expect(state.nextCursor).toBe('c1')
  })

  it('clears a previous success notice when a new submission starts', () => {
    let state = widgetReducer(initialState, {
      type: 'notice/set',
      notice: '评论已发布。',
    })
    state = widgetReducer(state, { type: 'create/pending' })
    expect(state.notice).toBeUndefined()
    expect(state.status).toBe('creating')
  })
})
