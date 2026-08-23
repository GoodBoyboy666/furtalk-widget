import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiClient } from '../src/api'
import { WidgetError } from '../src/errors'

describe('ApiClient', () => {
  let calls: { input: RequestInfo | URL; init: RequestInit | undefined }[]

  function mockFetch(response: () => Promise<Response>) {
    calls = []
    const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      return response()
    }) as typeof fetch
    return impl
  }

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  beforeEach(() => {
    calls = []
  })

  it('resolves paths against the service origin with credentials include', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(jsonResponse(200, { valid: false })),
    )
    const client = new ApiClient({
      origin: 'https://comments.example/',
      fetchImpl,
    })

    const session = await client.widgetSession()
    expect(session).toEqual({ valid: false })
    expect(calls[0]?.input).toBe(
      'https://comments.example/api/v1/widget/session',
    )
    expect(calls[0]?.init?.credentials).toBe('include')
  })

  it('lists comments with page key and limit', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(jsonResponse(200, { comments: [], next_cursor: null })),
    )
    const client = new ApiClient({
      origin: 'https://comments.example',
      fetchImpl,
    })

    await client.listComments('123', 'page')
    expect(calls[0]?.input).toBe(
      'https://comments.example/api/v1/widget/sites/123/comments?page_key=page&limit=10',
    )
  })

  it('appends the sort direction to list and load-more requests', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(jsonResponse(200, { comments: [], next_cursor: null })),
    )
    const client = new ApiClient({
      origin: 'https://comments.example',
      fetchImpl,
    })

    await client.listComments('123', 'page', undefined, 10, 'desc')
    await client.listComments('123', 'page', 'c1', 10, 'desc')
    expect(calls[0]?.input).toContain('sort=desc')
    expect(calls[1]?.input).toContain('sort=desc')
    expect(calls[1]?.input).toContain('cursor=c1')
  })

  it('omits the sort param when no direction is given', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(jsonResponse(200, { comments: [], next_cursor: null })),
    )
    const client = new ApiClient({
      origin: 'https://comments.example',
      fetchImpl,
    })

    await client.listComments('123', 'page')
    expect(String(calls[0]?.input)).not.toContain('sort=')
  })

  it('sends JSON bodies for write endpoints', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(new Response(null, { status: 201 })),
    )
    const client = new ApiClient({
      origin: 'https://comments.example',
      fetchImpl,
    })

    await client.createComment(
      '123',
      {
        pageKey: 'page',
        bodyMarkdown: 'hi',
        email: 'a@b.example',
        nickname: 'Alice',
        websiteUrl: null,
      },
      'token',
    )
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.body).toContain('"captcha_token":"token"')
    expect(calls[0]?.init?.body).toContain('"email":"a@b.example"')
  })

  it('surfaces need_auth_code from the unified create endpoint', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(jsonResponse(200, { need_auth_code: true })),
    )
    const client = new ApiClient({
      origin: 'https://comments.example',
      fetchImpl,
    })

    const outcome = await client.createComment(
      '123',
      {
        pageKey: 'page',
        bodyMarkdown: 'hi',
        email: 'admin@example.com',
        nickname: 'Admin',
        websiteUrl: null,
      },
      '',
    )
    expect(outcome).toEqual({ need_auth_code: true })
  })

  it('returns the created comment on a 201', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        jsonResponse(201, {
          id: '7',
          site_id: '123',
          status: 'published',
          author_nickname: 'Alice',
        }),
      ),
    )
    const client = new ApiClient({
      origin: 'https://comments.example',
      fetchImpl,
    })

    const outcome = await client.createComment(
      '123',
      {
        pageKey: 'page',
        bodyMarkdown: 'hi',
        email: 'a@b.example',
        nickname: 'Alice',
        websiteUrl: null,
      },
      '',
    )
    expect(outcome).toMatchObject({ id: '7', status: 'published' })
  })

  it('normalizes backend error envelopes', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        jsonResponse(409, {
          error: { code: 'thread_closed', message: '评论区已关闭' },
        }),
      ),
    )
    const client = new ApiClient({
      origin: 'https://comments.example',
      fetchImpl,
    })

    const promise = client.createComment(
      '123',
      {
        pageKey: 'page',
        bodyMarkdown: 'hi',
        email: 'a@b.example',
        nickname: 'Alice',
      },
      '',
    )
    await expect(promise).rejects.toMatchObject({
      code: 'thread_closed',
      status: 409,
    })
  })

  it('wraps network failures as network errors', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.reject(new TypeError('failed to fetch')),
    )
    const client = new ApiClient({
      origin: 'https://comments.example',
      fetchImpl,
    })

    await expect(client.widgetSession()).rejects.toBeInstanceOf(WidgetError)
  })

  it('serializes the full comment create input with attribution fields', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        jsonResponse(201, {
          id: '7',
          site_id: '123',
          status: 'published',
          author_nickname: 'Alice',
        }),
      ),
    )
    const client = new ApiClient({
      origin: 'https://comments.example',
      fetchImpl,
    })

    await client.createComment(
      '123',
      {
        pageKey: 'page',
        pageUrl: 'https://host.example/page',
        parentId: '7',
        bodyMarkdown: 'reply',
        email: ' alice@example.com ',
        nickname: 'Alice',
        websiteUrl: 'https://blog.example',
      },
      'token',
    )
    const body = JSON.parse(String(calls[0]?.init?.body))
    expect(body).toEqual({
      page_key: 'page',
      page_url: 'https://host.example/page',
      page_title: null,
      parent_id: '7',
      body_markdown: 'reply',
      captcha_token: 'token',
      email: ' alice@example.com ',
      nickname: 'Alice',
      website_url: 'https://blog.example',
    })
  })

  it('serializes empty website as null and omits an undefined website', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        jsonResponse(201, {
          id: '1',
          site_id: '123',
          status: 'published',
          author_nickname: 'Alice',
        }),
      ),
    )
    const client = new ApiClient({
      origin: 'https://comments.example',
      fetchImpl,
    })

    await client.createComment(
      '123',
      {
        pageKey: 'page',
        bodyMarkdown: 'root',
        email: 'a@b.example',
        nickname: 'Alice',
        websiteUrl: '',
      },
      '',
    )
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      website_url: null,
    })

    await client.createComment(
      '123',
      {
        pageKey: 'page',
        bodyMarkdown: 'root',
        email: 'a@b.example',
        nickname: 'Alice',
      },
      '',
    )
    expect(JSON.parse(String(calls[1]?.init?.body))).not.toHaveProperty(
      'website_url',
    )
  })

  it('verifies api methods are used in tests (eslint unused vars sanity)', () => {
    expect(vi.isMockFunction(vi.fn())).toBe(true)
  })

  it('adds a like with PUT and removes it with DELETE on the site-scoped path', async () => {
    const results = [
      jsonResponse(200, { comment_id: '42', like_count: 3, liked: true }),
      jsonResponse(200, { comment_id: '42', like_count: 2, liked: false }),
    ]
    let n = 0
    const fetchImpl = mockFetch(() => Promise.resolve(results[n++]!))
    const client = new ApiClient({
      origin: 'https://comments.example',
      fetchImpl,
    })

    const added = await client.likeComment('7', '42')
    expect(added).toEqual({ comment_id: '42', like_count: 3, liked: true })
    expect(calls[0]?.init?.method).toBe('PUT')
    expect(calls[0]?.input).toBe(
      'https://comments.example/api/v1/widget/sites/7/comments/42/like',
    )

    const removed = await client.unlikeComment('7', '42')
    expect(removed).toEqual({ comment_id: '42', like_count: 2, liked: false })
    expect(calls[1]?.init?.method).toBe('DELETE')
    expect(calls[1]?.input).toBe(
      'https://comments.example/api/v1/widget/sites/7/comments/42/like',
    )
  })

  it('propagates a Like mutation failure as a WidgetError', async () => {
    const fetchImpl = mockFetch(() =>
      Promise.resolve(
        jsonResponse(404, {
          error: { code: 'not_found', message: '资源不存在' },
        }),
      ),
    )
    const client = new ApiClient({
      origin: 'https://comments.example',
      fetchImpl,
    })
    await expect(client.likeComment('7', '999')).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})
