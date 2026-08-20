/**
 * Typed Widget API and popup message contracts.
 *
 * Field names mirror the backend HTTP/JSON contract (docs/swagger and the
 * internal/handler response DTOs). This module is the single owner of the
 * wire shapes consumed by the widget; UI code formats but never redefines
 * these types.
 */

/** Public CAPTCHA rendering projection for one action. */
export interface CaptchaProjection {
  required: boolean
  provider?: string
  site_key?: string
  api_endpoint?: string
}

/**
 * Directional thread ordering used by the public comments query and the
 * widget's sort control. `asc` is the compatibility default.
 */
export type CommentSort = 'asc' | 'desc'

/** Widget runtime configuration (GET /widget/sites/{site_id}/runtime-config). */
export interface RuntimeConfig {
  site_id: string
  name: string
  comment_mode: 'anonymous' | 'authenticated'
  moderation: 'direct' | 'review'
  user_delete_mode: 'soft' | 'hard'
  max_reply_depth: number
  /**
   * Default comment ordering configured by the site administrator. The field
   * is optional on the wire (pre-rollout backends omit it); consumers must
   * fall back to `asc`.
   */
  comment_sort?: CommentSort
  /**
   * Optional instance-wide OwO-compatible expression catalog URL. When present
   * the widget fetches it live on boot and uses it as the sole catalog; an
   * absent/empty value means the expression picker is not shown.
   */
  owo_catalog_url?: string
  captcha: {
    comment: CaptchaProjection
  }
}

/** Thread metadata returned with the public comment list. */
export interface ThreadMeta {
  id: string
  site_id: string
  page_key: string
  page_url: string | null
  page_title: string | null
  comments_enabled: boolean
}

/** A public comment row (no email/IP/UA fields). */
export interface Comment {
  id: string
  site_id: string
  thread_id: string
  user_id: string
  parent_id: string | null
  root_id: string | null
  depth: number
  body: string
  status: 'pending' | 'published' | 'spam' | 'deleted'
  author_nickname: string
  author_website: string | null
  /** Controlled public author role; missing while a pre-rollout backend serves this comment. */
  author_role?: 'admin' | 'user'
  avatar_url: string
  /** The replied-to author id; null for roots and hard-deleted targets. */
  reply_to_user_id: string | null
  /** Current nickname of the replied-to author; null when the target is gone. */
  reply_to_nickname: string | null
  created_at: string
  published_at: string | null
}

/** One page of a thread's flat comment list plus its cursor. */
export interface ThreadResponse {
  thread: ThreadMeta
  comments: Comment[]
  next_cursor: string | null
}

/**
 * Widget session probe result (GET /widget/session).
 *
 * Only `widget_authenticated` credentials exist after the anonymous-credential
 * simplification; a valid session therefore always reports
 * `credential_mode: 'authenticated'`. Anonymous visitors have no session at
 * all and never receive a Widget Cookie.
 */
export interface WidgetSession {
  valid: boolean
  credential_mode?: 'authenticated'
  user_id?: string
  site_id?: string
  role?: 'admin' | 'user'
  expires_at?: string
}

/** Comment delete result. */
export interface CommentDeleteResult {
  deleted_root_id: string
  hard: boolean
}

/**
 * Author fields carried by every widget comment create request.
 *
 * `websiteUrl` is tri-state on the wire: omitted keeps the user's current
 * website, `null`/empty clears it, and a valid non-empty URL replaces it.
 * The widget always has the current local value, so it sends the normalized
 * string or `null`; the omission shape exists for callers that do not know
 * the current value.
 */
export interface CreateCommentInput {
  pageKey: string
  pageUrl?: string
  pageTitle?: string
  parentId?: string
  bodyMarkdown: string
  email: string
  nickname: string
  websiteUrl?: string | null
}

/** Editable visitor profile hints persisted in the embedding origin's storage. */
export interface ProfileHints {
  email: string
  nickname: string
  website_url: string
}

/**
 * Authorization popup postMessage protocol.
 *
 * `furtalk:authorization-init` carries only the high-entropy request id and an
 * optional email hint used to prefill the first-party login form. The email
 * hint is never an authentication assertion: the authorized subject always
 * comes from the actual first-party session, and nickname/website are no
 * longer transported (profile writes happen only inside the comment
 * transaction).
 */
export type AuthorizationMessage =
  | {
      type: 'furtalk:authorization-init'
      request_id: string
      email?: string
    }
  | { type: 'furtalk:authorization-ready'; request_id: string }
  | { type: 'furtalk:authorization-success'; request_id: string; code: string }
  | { type: 'furtalk:authorization-cancelled'; request_id: string }

export type AuthorizationMessageType = AuthorizationMessage['type']

/** Discriminated type guard for the popup protocol; rejects unknown shapes. */
export function isAuthorizationMessage(
  value: unknown,
): value is AuthorizationMessage {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.type !== 'string') return false
  if (typeof candidate.request_id !== 'string' || candidate.request_id === '')
    return false
  switch (candidate.type) {
    case 'furtalk:authorization-init':
      return (
        candidate.email === undefined || typeof candidate.email === 'string'
      )
    case 'furtalk:authorization-ready':
      return true
    case 'furtalk:authorization-success':
      return typeof candidate.code === 'string' && candidate.code !== ''
    case 'furtalk:authorization-cancelled':
      return true
    default:
      return false
  }
}
