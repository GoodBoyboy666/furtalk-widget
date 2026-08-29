import type { DisplayMessage, TranslationKey } from './i18n'
import type { AuthPhase } from './state'
import type { Comment } from './types'

/** 从脚本 URL (import.meta.url) 推导 Furtalk 服务源。 */
export function defaultServiceOrigin(): string {
  try {
    return new URL('.', import.meta.url).origin
  } catch {
    return ''
  }
}

/** 统一 `comment` 动作中每个编辑器各自的 CAPTCHA 令牌。 */
export interface ComposerTokens {
  comment: string
}

export interface ComposerState extends ComposerTokens {
  body: string
  /** 用于展示的提示信息；`''` 表示不显示错误。 */
  error: DisplayMessage | ''
  /** 回复目标评论的 id；仅当该编辑器用于回复某条评论时非空（根编辑器为 null）。 */
  replyTargetId: string | null
}

export const emptyComposer = (
  replyTargetId: string | null = null,
): ComposerState => ({
  comment: '',
  body: '',
  error: '',
  replyTargetId,
})

/**
 * 统一创建接口返回值的判断：返回 `200` 且带 `{need_auth_code: true}`，
 * 说明该邮箱对应一位没有有效 widget 凭据的管理员，而不是评论创建成功。
 */
export function isNeedAuthCodeResult(
  result: Comment | { need_auth_code: true },
): result is { need_auth_code: true } {
  return (result as { need_auth_code?: boolean }).need_auth_code === true
}

export const AUTH_NOTICE: Record<
  Exclude<AuthPhase, 'idle'>,
  { title: TranslationKey; detail: TranslationKey }
> = {
  opening: { title: 'auth.opening.title', detail: 'auth.opening.detail' },
  waiting: { title: 'auth.waiting.title', detail: 'auth.waiting.detail' },
  exchanging: {
    title: 'auth.exchanging.title',
    detail: 'auth.exchanging.detail',
  },
  cancelled: {
    title: 'auth.cancelled.title',
    detail: 'auth.cancelled.detail',
  },
  blocked: { title: 'auth.blocked.title', detail: 'auth.blocked.detail' },
  closed: { title: 'auth.closed.title', detail: 'auth.closed.detail' },
  expired: { title: 'auth.expired.title', detail: 'auth.expired.detail' },
  unsupported: {
    title: 'auth.unsupported.title',
    detail: 'auth.unsupported.detail',
  },
}

/** 两个可独立折叠区域的自然高度上限。 */
export const COMMENT_CONTENT_MAX_HEIGHT = 300
export const COMMENT_CHILDREN_MAX_HEIGHT = 400

export type LimitedRegionKind = 'content' | 'children'
