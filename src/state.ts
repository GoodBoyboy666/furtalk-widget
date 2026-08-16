/**
 * Widget state machine (reducer).
 *
 * Explicit status transitions instead of scattered flags:
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
 * The popup authorization flow adds an `authPhase` facet (opening / waiting /
 * exchanging / cancelled / blocked / closed / expired / unsupported) so the UI
 * can render explicit recoverable states without losing the thread view. A
 * `pendingAction` records what to perform after a widget session is
 * established; it covers authenticated-mode creates/deletes and the anonymous
 * administrator-email `need_auth_code` retry, which share the same
 * popup -> exchange -> probe path.
 */

import { mergeComments } from './comments'
import type { WidgetError } from './errors'
import type {
  Comment,
  CommentSort,
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

/** An action to perform after a widget session is established. */
export type PendingAction =
  | { type: 'create'; parentId?: string; body: string; captchaToken: string }
  | { type: 'delete'; commentId: string }

export interface WidgetState {
  status: WidgetStatus
  config?: RuntimeConfig
  thread?: ThreadResponse
  comments: Comment[]
  nextCursor: string | null
  /** Active thread direction; a cursor is only meaningful with this direction. */
  sort: CommentSort
  session?: WidgetSession
  loadingMore: boolean
  error?: WidgetError
  authPhase: AuthPhase
  pendingAction?: PendingAction
  /** Success notice shown after a comment submission (never on failure). */
  notice?: string
}

export const initialState: WidgetState = {
  status: 'boot',
  comments: [],
  nextCursor: null,
  sort: 'asc',
  loadingMore: false,
  authPhase: 'idle',
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
  | { type: 'notice/set'; notice: string }
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
      // The runtime config owns the default direction; older backends omit
      // `comment_sort` and the compatibility default is asc.
      return {
        ...state,
        status: 'loading-thread',
        config: action.config,
        sort: action.config.comment_sort === 'desc' ? 'desc' : 'asc',
      }
    case 'thread/loading':
      return { ...state, status: 'loading-thread' }
    case 'thread/loaded':
      return {
        ...state,
        status: 'ready',
        thread: action.thread,
        comments: action.thread.comments,
        nextCursor: action.thread.next_cursor,
        loadingMore: false,
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
      }
    }
    case 'sort/change': {
      if (state.sort === action.sort) return state
      // A cursor is only valid for the direction that produced it: switching
      // discards the old cursor and visible comments and reloads the first
      // page along the new direction.
      return {
        ...state,
        sort: action.sort,
        status: 'loading-thread',
        thread: undefined,
        comments: [],
        nextCursor: null,
        loadingMore: false,
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
      // A new submission invalidates any previous success notice so stale
      // feedback can never be attributed to the in-flight request.
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
    case 'notice/set':
      return { ...state, notice: action.notice }
    case 'notice/clear':
      return { ...state, notice: undefined }
    case 'error':
      return { ...state, status: 'error', error: action.error }
    default:
      return state
  }
}
