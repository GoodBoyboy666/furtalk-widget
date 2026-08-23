/**
 * Typed Widget API client.
 *
 * All cross-origin calls use credentials: "include" so the partitioned CHIPS
 * widget cookie is sent. Paths are resolved against the configured Furtalk
 * service origin. The browser supplies the exact Host Origin; the server's CORS
 * and live origin authorization remain authoritative.
 */

import { normalizeApiError, toWidgetError, WidgetError } from './errors'
import type {
  Comment,
  CommentDeleteResult,
  CommentSort,
  CreateCommentInput,
  LikeResult,
  RuntimeConfig,
  ThreadResponse,
  WidgetSession,
} from './types'

/**
 * Widget comment page size. The widget explicitly requests 10 flat records so
 * the first screen stays light; the server default remains untouched.
 */
export const WIDGET_PAGE_SIZE = 10

export interface ApiClientOptions {
  origin: string
  fetchImpl?: typeof fetch
}

export class ApiClient {
  private readonly fetchImpl: typeof fetch
  private readonly origin: string

  constructor(options: ApiClientOptions) {
    if (!options.origin) throw new Error('api: service origin is required')
    this.origin = options.origin.replace(/\/+$/, '')
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    let response: Response
    try {
      response = await this.fetchImpl(`${this.origin}${path}`, {
        method,
        headers,
        credentials: 'include',
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      throw toWidgetError(error)
    }
    if (response.status === 204) {
      return undefined as T
    }
    let data: unknown = null
    try {
      data = await response.json()
    } catch {
      data = null
    }
    if (!response.ok) {
      throw normalizeApiError(data, response.status)
    }
    return data as T
  }

  runtimeConfig(siteId: string): Promise<RuntimeConfig> {
    return this.request<RuntimeConfig>(
      'GET',
      `/api/v1/widget/sites/${siteId}/runtime-config`,
    )
  }

  listComments(
    siteId: string,
    pageKey: string,
    cursor?: string,
    limit = WIDGET_PAGE_SIZE,
    sort?: CommentSort,
  ): Promise<ThreadResponse> {
    const params = new URLSearchParams({
      page_key: pageKey,
      limit: String(limit),
    })
    if (cursor) params.set('cursor', cursor)
    // A cursor is only meaningful with the direction that produced it; the
    // widget always sends the active sort so first pages and load-more pages
    // agree. The server validates the controlled value.
    if (sort) params.set('sort', sort)
    return this.request<ThreadResponse>(
      'GET',
      `/api/v1/widget/sites/${siteId}/comments?${params.toString()}`,
    )
  }

  widgetSession(): Promise<WidgetSession> {
    return this.request<WidgetSession>('GET', '/api/v1/widget/session')
  }

  clearWidgetSession(): Promise<void> {
    return this.request<void>('DELETE', '/api/v1/widget/session')
  }

  exchangeAuthorization(code: string): Promise<void> {
    return this.request<void>(
      'POST',
      '/api/v1/widget/comment-authorizations/exchange',
      { code },
    )
  }

  /**
   * Creates a root comment or reply through the unified widget comment
   * endpoint. Every request carries the required email/nickname plus the
   * tri-state website URL. A `200` with `{need_auth_code: true}` means the
   * submitted email maps to an administrator that must first complete the
   * first-party authorization flow; a `201` carries the created comment.
   */
  createComment(
    siteId: string,
    input: CreateCommentInput,
    captchaToken: string,
  ): Promise<Comment | { need_auth_code: true }> {
    return this.request<Comment | { need_auth_code: true }>(
      'POST',
      `/api/v1/widget/sites/${siteId}/comments`,
      {
        page_key: input.pageKey,
        page_url: input.pageUrl ?? null,
        page_title: input.pageTitle ?? null,
        parent_id: input.parentId ?? null,
        body_markdown: input.bodyMarkdown,
        captcha_token: captchaToken,
        email: input.email,
        nickname: input.nickname,
        website_url:
          input.websiteUrl === undefined ? undefined : input.websiteUrl || null,
      },
    )
  }

  deleteComment(commentId: string): Promise<CommentDeleteResult> {
    return this.request<CommentDeleteResult>(
      'DELETE',
      `/api/v1/widget/comments/${commentId}`,
    )
  }

  /**
   * Adds a Like to a published comment. The widget cookie supplies the
   * credential; both add and remove are idempotent on the server.
   */
  likeComment(siteId: string, commentId: string): Promise<LikeResult> {
    return this.request<LikeResult>(
      'PUT',
      `/api/v1/widget/sites/${siteId}/comments/${commentId}/like`,
    )
  }

  /** Removes the current viewer's Like from a published comment (idempotent). */
  unlikeComment(siteId: string, commentId: string): Promise<LikeResult> {
    return this.request<LikeResult>(
      'DELETE',
      `/api/v1/widget/sites/${siteId}/comments/${commentId}/like`,
    )
  }
}

export { WidgetError }
