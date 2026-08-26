/**
 * Widget API 与弹窗消息的类型定义。
 *
 * 字段名与后端 HTTP/JSON 接口保持一致（见 docs/swagger 与 internal/handler
 * 的响应类型）。这些数据结构只在本模块定义；UI 代码只负责格式化，绝不重新定义。
 */

/** 单个动作的公开 CAPTCHA 渲染配置。 */
export interface CaptchaProjection {
  required: boolean
  provider?: string
  site_key?: string
  api_endpoint?: string
}

/**
 * 公开评论查询与 widget 排序控件使用的线程排序。`asc` 是兼容性默认值；
 * `hot` 按每条评论自身的点赞数从多到少排序，点赞数与时间相同则 id 大的在前；
 * 不累计后代的点赞。
 */
export type CommentSort = 'asc' | 'desc' | 'hot'

/** Widget 运行时配置（GET /widget/sites/{site_id}/runtime-config）。 */
export interface RuntimeConfig {
  site_id: string
  name: string
  comment_mode: 'anonymous' | 'authenticated'
  moderation: 'direct' | 'review'
  user_delete_mode: 'soft' | 'hard'
  max_reply_depth: number
  /**
   * 站点管理员配置的默认评论排序。旧版后端可能不返回该字段；
   * 读取方需按 `asc` 处理。
   */
  comment_sort?: CommentSort
  /**
   * 可选的实例级 Furtalk 表情包目录 URL。
   * 配置了该 URL 时，widget 启动即实时拉取并作为唯一目录；
   * 缺失或为空则不显示表情选择器。
   */
  emoji_catalog_url?: string
  captcha: {
    comment: CaptchaProjection
  }
}

/** 随公开评论列表返回的线程元数据。 */
export interface ThreadMeta {
  id: string
  site_id: string
  page_key: string
  page_url: string | null
  page_title: string | null
  comments_enabled: boolean
}

/** 公开评论行（不含 email/IP/UA 字段）。 */
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
  /** 该根评论是否已置顶（显示在普通评论之上）。 */
  is_pinned?: boolean
  author_nickname: string
  author_website: string | null
  /** 公开的作者角色；旧版后端返回的评论没有此字段。 */
  author_role?: 'admin' | 'user'
  avatar_url: string
  /** 被回复的作者 id；根评论以及被彻底删除的回复，该字段为 null。 */
  reply_to_user_id: string | null
  /** 被回复作者的当前昵称；目标已不存在时为 null。 */
  reply_to_nickname: string | null
  /**
   * 该评论的公开点赞数。新版后端才会返回该字段；旧后端过渡期间
   * 按 0 处理，保证渲染正常。
   */
  like_count?: number
  /**
   * 当前浏览者是否已点赞该评论。匿名读者始终为 `false`；只有有效的 widget
   * 会话才会是 `true`。旧版后端不返回该字段时按 false 处理。
   */
  liked_by_me?: boolean
  created_at: string
  published_at: string | null
}

/** 置顶/取消置顶操作的返回结果。 */
export interface PinResult {
  comment_id: string
  is_pinned: boolean
}

/** 点赞/取消赞（PUT/DELETE .../like）的接口返回结果。 */
export interface LikeResult {
  comment_id: string
  like_count: number
  liked: boolean
}

/** 线程平铺评论列表的一页及其游标。 */
export interface ThreadResponse {
  thread: ThreadMeta
  comments: Comment[]
  next_cursor: string | null
}

/**
 * widget 会话探测结果（GET /widget/session）。
 *
 * 匿名凭据简化后只保留 `widget_authenticated` 一种凭据，因此有效会话的
 * `credential_mode` 总是 `'authenticated'`。
 * 匿名访客没有会话，也不会收到 Widget Cookie。
 */
export interface WidgetSession {
  valid: boolean
  credential_mode?: 'authenticated'
  user_id?: string
  site_id?: string
  role?: 'admin' | 'user'
  expires_at?: string
}

/** 评论删除结果。 */
export interface CommentDeleteResult {
  deleted_root_id: string
  hard: boolean
}

/**
 * 每次 widget 评论创建请求携带的作者字段。
 *
 * `websiteUrl` 有三种取值：省略表示保留用户当前的网站，`null` 或空值表示清空，
 * 有效的非空 URL 表示替换。
 * widget 始终知道当前的本地值，因此会发送规范化后的字符串或 `null`；
 * 省略写法适用于不知道当前值的调用方。
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

/** 保存在嵌入页面本地存储中的访客资料。 */
export interface ProfileHints {
  email: string
  nickname: string
  website_url: string
}

/**
 * 授权弹窗 postMessage 协议。
 *
 * `furtalk:authorization-init` 只携带高熵请求 id 与可选的 email 提示，
 * 用于预填第一方登录表单。
 * email 提示只用于预填，绝不作为认证依据：最终身份以第一方会话为准，
 * 且昵称/网站不再传输（资料更新随评论请求一起进行）。
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

/** 弹窗协议的类型判断函数；拒绝无法识别的消息结构。 */
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
