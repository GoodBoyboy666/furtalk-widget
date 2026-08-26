/**
 * Widget 状态机（reducer）。
 *
 * 用显式的状态迁移替代零散的标志位：
 *
 *   boot -> loading-config -> loading-thread -> ready
 *                                   |           |
 *                                   v           v
 *                                 error    authenticating
 *                                              |
 *                                  popup authorization
 *                                              |
 *                                              v
 *                                    creating/deleting -> ready
 *
 * 弹窗授权流程新增 `authPhase` 维度（opening / waiting / exchanging /
 * cancelled / blocked / closed / expired / unsupported），使 UI 在保留线程视图的
 * 同时展示明确的可恢复状态。
 * `pendingAction` 记录 widget 会话建立后要执行的动作：认证模式的创建/删除，
 * 以及匿名模式下管理员邮箱触发的 `need_auth_code` 重试，
 * 两者共用同一条 popup -> exchange -> probe 流程。
 */

import { mergeComments } from './comments'
import type { WidgetError } from './errors'
import type { DisplayMessage } from './i18n'
import type {
  Comment,
  CommentSort,
  LikeResult,
  PinResult,
  RuntimeConfig,
  ThreadResponse,
  WidgetSession,
} from './types'

export type WidgetStatus =
  | 'boot'
  | 'loading-config'
  | 'loading-thread'
  | 'ready'
  | 'error'
  | 'authenticating'
  | 'creating'
  | 'deleting'
  | 'liking'

export type AuthPhase =
  | 'idle'
  | 'opening'
  | 'waiting'
  | 'exchanging'
  | 'cancelled'
  | 'blocked'
  | 'closed'
  | 'expired'
  | 'unsupported'

/** widget 会话建立后要执行的动作。 */
export type PendingAction =
  | { type: 'create'; parentId?: string; body: string; captchaToken: string }
  | { type: 'delete'; commentId: string }
  | { type: 'like'; commentId: string; like: boolean }

export interface WidgetState {
  status: WidgetStatus
  config?: RuntimeConfig
  thread?: ThreadResponse
  comments: Comment[]
  nextCursor: string | null
  /** 当前线程排序；游标仅对该排序有意义。 */
  sort: CommentSort
  session?: WidgetSession
  loadingMore: boolean
  loadingComments?: boolean
  error?: WidgetError
  authPhase: AuthPhase
  pendingAction?: PendingAction
  /**
   * 评论提交后显示的成功提示（失败时不显示）。
   * 保存为展示用描述，切换语言时可以重新翻译；后端返回的原始细节保持原样。
   */
  notice?: DisplayMessage
  /**
   * 正在执行点赞/取消赞操作的评论 id。同一评论上的重复点击会被忽略，
   * 且不影响其他评论的操作。
   */
  pendingLikeIds: Record<string, boolean>
  /** 正在置顶/取消置顶的评论 id。 */
  pendingPinIds?: Record<string, boolean>
}

export const initialState: WidgetState = {
  status: 'boot',
  comments: [],
  nextCursor: null,
  sort: 'asc',
  loadingMore: false,
  loadingComments: false,
  authPhase: 'idle',
  pendingLikeIds: {},
  pendingPinIds: {},
}

export type WidgetAction =
  | { type: 'config/loading' }
  | { type: 'config/loaded'; config: RuntimeConfig }
  | { type: 'thread/loading' }
  | { type: 'thread/loaded'; thread: ThreadResponse }
  | { type: 'thread/load-more' }
  | { type: 'thread/appended'; thread: ThreadResponse }
  | { type: 'sort/change'; sort: CommentSort }
  | { type: 'session/probed'; session: WidgetSession }
  | { type: 'authenticating' }
  | { type: 'auth/opening' }
  | { type: 'auth/waiting' }
  | { type: 'auth/exchanging' }
  | { type: 'auth/cancelled' }
  | { type: 'auth/blocked' }
  | { type: 'auth/closed' }
  | { type: 'auth/expired' }
  | { type: 'auth/unsupported' }
  | { type: 'auth/settled'; session: WidgetSession }
  | { type: 'pending/set'; action: PendingAction }
  | { type: 'pending/clear' }
  | { type: 'create/pending' }
  | { type: 'create/settled' }
  | { type: 'delete/pending' }
  | { type: 'delete/settled' }
  | { type: 'like/pending'; commentId: string }
  | { type: 'like/settled'; commentId: string; result: LikeResult }
  | { type: 'like/error'; commentId: string }
  | { type: 'pin/pending'; commentId: string }
  | { type: 'pin/settled'; commentId: string; result: PinResult }
  | { type: 'pin/error'; commentId: string }
  | { type: 'notice/set'; notice: DisplayMessage }
  | { type: 'notice/clear' }
  | { type: 'error'; error: WidgetError }

export function widgetReducer(
  state: WidgetState,
  action: WidgetAction,
): WidgetState {
  switch (action.type) {
    case 'config/loading':
      return { ...state, status: 'loading-config', error: undefined }
    case 'config/loaded':
      // 默认排序来自运行时配置；旧版后端不返回 `comment_sort` 时，
      // 按兼容默认值 asc 处理。
      return {
        ...state,
        status: 'loading-thread',
        config: action.config,
        sort: normalizeConfigSort(action.config.comment_sort),
      }
    case 'thread/loading':
      if (state.status === 'ready') {
        return { ...state, loadingComments: true, error: undefined }
      }
      return { ...state, status: 'loading-thread' }
    case 'thread/loaded':
      return {
        ...state,
        status: 'ready',
        thread: action.thread,
        comments: action.thread.comments,
        nextCursor: action.thread.next_cursor,
        loadingMore: false,
        loadingComments: false,
        error: undefined,
      }
    case 'thread/load-more':
      return { ...state, loadingMore: true, error: undefined }
    case 'thread/appended': {
      const comments = mergeComments(state.comments, action.thread.comments)
      return {
        ...state,
        thread: { ...action.thread, comments },
        comments,
        nextCursor: action.thread.next_cursor,
        loadingMore: false,
        loadingComments: false,
      }
    }
    case 'sort/change': {
      if (state.sort === action.sort) return state
      // 游标只对产生它的排序有效：切换排序会丢弃旧游标、可见评论以及
      // 任何进行中的点赞操作，然后按新排序重新加载首页。
      return {
        ...state,
        sort: action.sort,
        status: state.status === 'ready' ? 'ready' : state.status,
        loadingComments: true,
        thread: undefined,
        comments: [],
        nextCursor: null,
        loadingMore: false,
        pendingLikeIds: {},
        pendingPinIds: {},
        error: undefined,
      }
    }
    case 'session/probed':
      return { ...state, session: action.session }
    case 'authenticating':
      return { ...state, status: 'authenticating', error: undefined }
    case 'auth/opening':
      return {
        ...state,
        status: 'authenticating',
        authPhase: 'opening',
        error: undefined,
      }
    case 'auth/waiting':
      return { ...state, authPhase: 'waiting' }
    case 'auth/exchanging':
      return { ...state, authPhase: 'exchanging' }
    case 'auth/cancelled':
      return { ...state, status: 'ready', authPhase: 'cancelled' }
    case 'auth/blocked':
      return { ...state, status: 'ready', authPhase: 'blocked' }
    case 'auth/closed':
      return { ...state, status: 'ready', authPhase: 'closed' }
    case 'auth/expired':
      return { ...state, status: 'ready', authPhase: 'expired' }
    case 'auth/unsupported':
      return { ...state, status: 'ready', authPhase: 'unsupported' }
    case 'auth/settled':
      return {
        ...state,
        status: 'ready',
        authPhase: 'idle',
        session: action.session,
        error: undefined,
      }
    case 'pending/set':
      return { ...state, pendingAction: action.action }
    case 'pending/clear':
      return { ...state, pendingAction: undefined }
    case 'create/pending':
      // 新的提交会使之前的成功提示失效，避免将过时反馈归因到本次请求。
      return {
        ...state,
        status: 'creating',
        error: undefined,
        notice: undefined,
      }
    case 'create/settled':
      return { ...state, status: 'ready', error: undefined }
    case 'delete/pending':
      return { ...state, status: 'deleting', error: undefined }
    case 'delete/settled':
      return { ...state, status: 'ready', error: undefined }
    case 'like/pending':
      return {
        ...state,
        pendingLikeIds: {
          ...state.pendingLikeIds,
          [action.commentId]: true,
        },
        error: undefined,
      }
    case 'like/settled': {
      const pendingLikeIds = { ...state.pendingLikeIds }
      delete pendingLikeIds[action.commentId]
      const result = action.result
      const comments = state.comments.map((comment) =>
        comment.id === result.comment_id
          ? {
              ...comment,
              like_count: result.like_count,
              liked_by_me: result.liked,
            }
          : comment,
      )
      return { ...state, pendingLikeIds, comments }
    }
    case 'like/error': {
      const pendingLikeIds = { ...state.pendingLikeIds }
      delete pendingLikeIds[action.commentId]
      return { ...state, pendingLikeIds }
    }
    case 'pin/pending':
      return {
        ...state,
        pendingPinIds: {
          ...(state.pendingPinIds ?? {}),
          [action.commentId]: true,
        },
      }
    case 'pin/settled': {
      const pendingPinIds = { ...(state.pendingPinIds ?? {}) }
      delete pendingPinIds[action.commentId]
      const comments = state.comments.map((comment) =>
        comment.id === action.commentId
          ? { ...comment, is_pinned: action.result.is_pinned }
          : comment,
      )
      return {
        ...state,
        pendingPinIds,
        comments,
        thread: state.thread ? { ...state.thread, comments } : state.thread,
      }
    }
    case 'pin/error': {
      const pendingPinIds = { ...(state.pendingPinIds ?? {}) }
      delete pendingPinIds[action.commentId]
      return { ...state, pendingPinIds }
    }
    case 'notice/set':
      return { ...state, notice: action.notice }
    case 'notice/clear':
      return { ...state, notice: undefined }
    case 'error':
      return {
        ...state,
        status: 'error',
        error: action.error,
        loadingComments: false,
        loadingMore: false,
      }
    default:
      return state
  }
}

/**
 * 把运行时配置中的排序值规范化为 widget 使用的排序。
 * 旧版后端不返回 `comment_sort`，未知值则按兼容默认值 `asc` 处理。
 */
export function normalizeConfigSort(value?: string): CommentSort {
  if (value === 'desc' || value === 'hot') return value
  return 'asc'
}
