/**
 * 类型化的 Widget API 客户端。
 *
 * 所有跨域请求都携带 credentials: "include"，以便发送分区 CHIPS Widget cookie。
 * 请求地址基于配置的 Furtalk 服务源生成；Host Origin 由浏览器提供。
 * 以服务端的 CORS 与实时源授权为准。
 */

import { normalizeApiError, toWidgetError, WidgetError } from './errors'
import type {
  Comment,
  CommentDeleteResult,
  CommentSort,
  CreateCommentInput,
  LikeResult,
  PinResult,
  RuntimeConfig,
  ThreadResponse,
  WidgetSession,
} from './types'

/**
 * Widget 评论分页大小。Widget 显式请求 10 条平铺记录，以保持首屏轻量；
 * 服务端默认值不受影响。
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
    // 游标只对产生它的排序方式有效，因此每次请求都附带当前排序，
    // 保证首页与“加载更多”页排序一致。排序值由服务端校验。
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
   * 通过统一的 Widget 评论端点创建根评论或回复。
   * 每次请求都携带必填的邮箱、昵称，以及网站 URL（三选一：省略表示保留，
   * null/空表示清空，非空 URL 表示替换）。
   * 若返回 `200` 且带 `{need_auth_code: true}`，表示该邮箱对应一位管理员，
   * 须先完成第一方授权流程；返回 `201` 表示评论已创建。
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
   * 为一条已发布评论点赞。Widget cookie 提供凭据；服务端保证添加和取消都是幂等的。
   */
  likeComment(siteId: string, commentId: string): Promise<LikeResult> {
    return this.request<LikeResult>(
      'PUT',
      `/api/v1/widget/sites/${siteId}/comments/${commentId}/like`,
    )
  }

  /** 移除当前浏览者对某条已发布评论的赞（幂等）。 */
  unlikeComment(siteId: string, commentId: string): Promise<LikeResult> {
    return this.request<LikeResult>(
      'DELETE',
      `/api/v1/widget/sites/${siteId}/comments/${commentId}/like`,
    )
  }

  /** 以管理员 Widget 会话置顶一条已发布的根评论。 */
  pinComment(siteId: string, commentId: string): Promise<PinResult> {
    return this.request<PinResult>(
      'PUT',
      `/api/v1/widget/sites/${siteId}/comments/${commentId}/pin`,
    )
  }

  /** 以管理员 Widget 会话将一条根评论移出置顶组。 */
  unpinComment(siteId: string, commentId: string): Promise<PinResult> {
    return this.request<PinResult>(
      'DELETE',
      `/api/v1/widget/sites/${siteId}/comments/${commentId}/pin`,
    )
  }
}

export { WidgetError }
