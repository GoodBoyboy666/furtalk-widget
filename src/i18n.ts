/**
 * Widget 国际化核心。
 *
 * widget 支持的语言、静态 zh-CN/en 文案目录、浏览器/存储语言解析、插值、
 * 相对时间与日期格式化，以及带类型标记的消息展示结构，都由本模块统一负责。
 *
 * 文案键是语义化的，与展示文本相互独立。`en` 目录的键必须与 `zh-CN` 一致
 * （编译期强制），因此某语言新增或删除一个键，另一语言也要同步修改。
 * 后端或外部返回的原始文本不进文案目录，而是用 `rawMessage` 包装后原样渲染。
 */

export const SUPPORTED_LANGUAGES = ['zh-CN', 'en'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]
export const FALLBACK_LANGUAGE: SupportedLanguage = 'en'

/** 简体中文源目录。其键集定义了 `TranslationKey`。 */
const zhCN = {
  'profile.nickname': '昵称',
  'profile.email': '邮箱',
  'profile.website': '网站（可选）',
  'composer.placeholder': '写下你的评论…',
  'composer.ariaLabel': '评论内容',
  'composer.busyCreating': '正在发表…',
  'composer.busyProcessing': '正在处理…',
  'composer.submit': '发表评论',
  'composer.submitting': '发表中…',
  'composer.logout': '退出登录',
  'emoji.trigger.aria': '表情',
  'emoji.panel.aria': '选择表情',
  'emoji.tabs.aria': '表情分类',
  'emoji.loading': '正在加载表情…',
  'emoji.loadFailed': '表情加载失败。',
  'emoji.emptyCategory': '该分类暂无表情。',
  'thread.closed': '评论区已关闭，仅可查看历史评论。',
  'reply.reply': '回复',
  'reply.cancelReply': '取消回复',
  'reply.to': '回复 {nickname}',
  'reply.toDeletedUser': '回复 已注销用户',
  'delete.confirm': '确认删除',
  'delete.cancel': '取消',
  'delete.delete': '删除',
  'pin.pin': '置顶',
  'pin.unpin': '取消置顶',
  'like.count': '赞 {count}',
  'like.like': '点赞',
  'like.unlike': '取消点赞',
  'sort.aria': '评论排序',
  'sort.asc': '最早',
  'sort.desc': '最新',
  'sort.hot': '最热',
  'state.loading': '加载中…',
  'state.empty': '还没有评论，来抢沙发吧',
  'state.loadMore': '加载更多',
  'badge.admin': '管理员',
  'badge.pinned': '已置顶',
  'badge.pending': '待审核',
  'comment.deleted': '（该评论已被删除）',
  'comment.readMore': '阅读更多',
  'config.invalid': '配置无效',
  'config.error.loadComments': '无法加载评论',
  'config.error.invalidSiteId': 'site-id 必须是正整数',
  'config.error.missingPageKey':
    '缺少 page-key（使用 "location" 从当前页面推导）',
  'config.error.pageKeyTooLong': 'page-key 不能超过 {max} 个字符',
  'config.error.invalidServiceOrigin': 'service-origin 必须是绝对 https 源',
  'common.retry': '重试',
  'common.cancel': '取消',
  'common.processing': '处理中…',
  'common.operationFailed': '操作失败，请稍后重试',
  'notice.submissionPending': '评论已提交，等待审核。',
  'notice.submissionPublished': '评论已发布。',
  'notice.logoutFailed': '退出登录失败：',
  'notice.logoutBlocked':
    '登出页面被浏览器拦截，主站登录尚未退出，请手动打开登出页。',
  'notice.openLogoutPage': '打开登出页',
  'notice.likeFailed': '点赞失败：',
  'notice.pinFailed': '置顶失败：',
  'notice.unpinFailed': '取消置顶失败：',
  'notice.pinned': '评论已置顶。',
  'notice.unpinned': '评论已取消置顶。',
  'auth.opening.title': '正在打开授权窗口…',
  'auth.opening.detail': '请在弹出窗口中完成授权。',
  'auth.waiting.title': '等待授权…',
  'auth.waiting.detail': '授权窗口已打开，请完成登录与授权。',
  'auth.exchanging.title': '正在完成授权…',
  'auth.exchanging.detail': '正在建立评论会话，请稍候。',
  'auth.cancelled.title': '已取消授权',
  'auth.cancelled.detail': '取消授权后无法以账号身份发表评论。',
  'auth.blocked.title': '授权窗口被拦截',
  'auth.blocked.detail': '请允许本站点弹出窗口后重试。',
  'auth.closed.title': '授权窗口已关闭',
  'auth.closed.detail': '可以重新发起授权。',
  'auth.expired.title': '登录状态已过期',
  'auth.expired.detail': '请重新授权后再发表评论。',
  'auth.unsupported.title': '浏览器不支持评论会话',
  'auth.unsupported.detail':
    '当前浏览器未保存评论会话 Cookie（可能禁用了第三方 Cookie 或分区 Cookie）。请允许后重试。',
  'captcha.mask.title': '人机验证',
  'captcha.pending.comment': '完成验证后即可发表评论。',
  'captcha.pending.reply': '完成验证后即可发布回复。',
  'validate.bodyEmpty': '评论内容不能为空',
  'validate.replyEmpty': '回复内容不能为空',
  'validate.email': '请填写有效的邮箱地址',
  'validate.nickname': '请填写有效的昵称',
  'validate.captcha': '请先完成人机验证',
  'validate.captchaUnavailable': '人机验证暂不可用，请稍后重试',
  'validate.authNotEffective': '授权未生效，请重试',
  'portal.admin': '后台管理',
  'portal.myComments': '我的评论',
  'lang.button.aria': '切换语言',
  'lang.menu.aria': '选择语言',
  'lang.zhCN': '简体中文',
  'lang.en': 'English',
  'time.secondsAgo': '{n}秒前',
  'time.minutesAgo': '{n}分钟前',
  'time.hoursAgo': '{n}小时前',
  'time.daysAgo': '{n}天前',
} as const

export type TranslationKey = keyof typeof zhCN

/** 英文文案目录。它的键必须与 zh-CN 完全一致（编译期强制）。 */
const en: Record<TranslationKey, string> = {
  'profile.nickname': 'Nickname',
  'profile.email': 'Email',
  'profile.website': 'Website (optional)',
  'composer.placeholder': 'Write a comment…',
  'composer.ariaLabel': 'Comment content',
  'composer.busyCreating': 'Posting…',
  'composer.busyProcessing': 'Processing…',
  'composer.submit': 'Post comment',
  'composer.submitting': 'Posting…',
  'composer.logout': 'Log out',
  'emoji.trigger.aria': 'Emoji',
  'emoji.panel.aria': 'Choose an emoji',
  'emoji.tabs.aria': 'Emoji categories',
  'emoji.loading': 'Loading emoji…',
  'emoji.loadFailed': 'Failed to load emoji.',
  'emoji.emptyCategory': 'No emoji in this category.',
  'thread.closed': 'Comments are closed. You can only view past comments.',
  'reply.reply': 'Reply',
  'reply.cancelReply': 'Cancel reply',
  'reply.to': 'Reply to {nickname}',
  'reply.toDeletedUser': 'Reply to a deleted user',
  'delete.confirm': 'Confirm delete',
  'delete.cancel': 'Cancel',
  'delete.delete': 'Delete',
  'pin.pin': 'Pin',
  'pin.unpin': 'Unpin',
  'like.count': 'Like {count}',
  'like.like': 'Like',
  'like.unlike': 'Unlike',
  'sort.aria': 'Sort comments',
  'sort.asc': 'Oldest',
  'sort.desc': 'Newest',
  'sort.hot': 'Hot',
  'state.loading': 'Loading…',
  'state.empty': 'No comments yet. Be the first!',
  'state.loadMore': 'Load more',
  'badge.admin': 'Admin',
  'badge.pinned': 'Pinned',
  'badge.pending': 'Pending',
  'comment.deleted': '(This comment has been deleted)',
  'comment.readMore': 'Read more',
  'config.invalid': 'Invalid configuration',
  'config.error.loadComments': 'Failed to load comments',
  'config.error.invalidSiteId': 'site-id must be a positive integer',
  'config.error.missingPageKey':
    'page-key is required (use "location" to derive it from the current page)',
  'config.error.pageKeyTooLong': 'page-key must not exceed {max} characters',
  'config.error.invalidServiceOrigin':
    'service-origin must be an absolute https origin',
  'common.retry': 'Retry',
  'common.cancel': 'Cancel',
  'common.processing': 'Processing…',
  'common.operationFailed': 'Operation failed. Please try again.',
  'notice.submissionPending':
    'Your comment has been submitted and is awaiting moderation.',
  'notice.submissionPublished': 'Your comment has been published.',
  'notice.logoutFailed': 'Logout failed: ',
  'notice.logoutBlocked':
    'The logout page was blocked by the browser. Your account is still signed in. Please open the logout page manually.',
  'notice.openLogoutPage': 'Open logout page',
  'notice.likeFailed': 'Like failed: ',
  'notice.pinFailed': 'Pin failed: ',
  'notice.unpinFailed': 'Unpin failed: ',
  'notice.pinned': 'Comment pinned.',
  'notice.unpinned': 'Comment unpinned.',
  'auth.opening.title': 'Opening authorization window…',
  'auth.opening.detail': 'Complete authorization in the popup window.',
  'auth.waiting.title': 'Waiting for authorization…',
  'auth.waiting.detail':
    'The authorization window is open. Please sign in and authorize.',
  'auth.exchanging.title': 'Completing authorization…',
  'auth.exchanging.detail': 'Establishing your comment session, please wait.',
  'auth.cancelled.title': 'Authorization cancelled',
  'auth.cancelled.detail':
    'Comments can only be posted as an account after authorizing.',
  'auth.blocked.title': 'Authorization window blocked',
  'auth.blocked.detail': 'Allow popups for this site and try again.',
  'auth.closed.title': 'Authorization window closed',
  'auth.closed.detail': 'You can start authorization again.',
  'auth.expired.title': 'Session expired',
  'auth.expired.detail': 'Please authorize again to post comments.',
  'auth.unsupported.title': 'Comment sessions not supported',
  'auth.unsupported.detail':
    'This browser could not store the comment session cookie (third-party or partitioned cookies may be blocked). Enable cookies and try again.',
  'captcha.mask.title': 'Human verification',
  'captcha.pending.comment': 'Complete verification to post your comment.',
  'captcha.pending.reply': 'Complete verification to post your reply.',
  'validate.bodyEmpty': 'Comment cannot be empty',
  'validate.replyEmpty': 'Reply cannot be empty',
  'validate.email': 'Please enter a valid email address',
  'validate.nickname': 'Please enter a valid nickname',
  'validate.captcha': 'Please complete human verification first',
  'validate.captchaUnavailable':
    'Human verification is temporarily unavailable. Please try again later.',
  'validate.authNotEffective':
    'Authorization did not take effect. Please try again.',
  'portal.admin': 'Admin',
  'portal.myComments': 'My comments',
  'lang.button.aria': 'Change language',
  'lang.menu.aria': 'Choose a language',
  'lang.zhCN': '简体中文',
  'lang.en': 'English',
  'time.secondsAgo': '{n} seconds ago',
  'time.minutesAgo': '{n} minutes ago',
  'time.hoursAgo': '{n} hours ago',
  'time.daysAgo': '{n} days ago',
}

/** 语言菜单中显示的语言名称（两种语言下写法相同）。 */
export const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  'zh-CN': zhCN['lang.zhCN'],
  en: zhCN['lang.en'],
}

/** 返回某语言的文案键集合（运行时用来核对两套键是否一致）。 */
export function catalogKeys(
  lang: SupportedLanguage,
): readonly TranslationKey[] {
  return Object.keys(lang === 'zh-CN' ? zhCN : en) as TranslationKey[]
}

/** 报告值是否正好是受支持的语言标签之一。 */
export function isSupportedLanguage(
  value: unknown,
): value is SupportedLanguage {
  return value === 'zh-CN' || value === 'en'
}

/**
 * 将浏览器语言标签规范化为受支持语言。
 * 任何 `zh-*` 变成 `zh-CN`，任何 `en-*` 变成 `en`；不支持的标签返回 null。
 */
export function normalizeLanguage(
  value: string | null | undefined,
): SupportedLanguage | null {
  if (!value) return null
  const lower = value.toLowerCase()
  if (lower === 'en' || lower.startsWith('en')) return 'en'
  if (lower.startsWith('zh')) return 'zh-CN'
  return null
}

/**
 * 解析当前语言：有效的已存偏好优先，然后按顺序检查浏览器语言列表，
 * 最后回退到 `en`。
 */
export function resolveLanguage(
  stored: string | null | undefined,
  navigatorLanguages: readonly string[] | null | undefined,
): SupportedLanguage {
  if (isSupportedLanguage(stored)) return stored
  for (const lang of navigatorLanguages ?? []) {
    const normalized = normalizeLanguage(lang)
    if (normalized) return normalized
  }
  return FALLBACK_LANGUAGE
}

/**
 * 在目标语言中翻译文案键，并替换其中的 `{name}` 占位符。
 * 未找到的键直接显示键名本身，避免因缺少译文导致界面空白。
 */
export function translate(
  lang: SupportedLanguage,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  const catalog = lang === 'zh-CN' ? zhCN : en
  let template: string = catalog[key] ?? en[key] ?? key
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      template = template.split(`{${name}}`).join(String(value))
    }
  }
  return template
}

/**
 * 将时间戳格式化为相对时间（<7 天）或语言相关的日期（>=7 天）。
 * 无效时间戳原样返回。
 */
export function formatRelativeTime(
  isoString: string,
  lang: SupportedLanguage,
  now: number = Date.now(),
): string {
  const timestamp = Date.parse(isoString)
  if (Number.isNaN(timestamp)) return isoString
  const diffMs = Math.max(0, now - timestamp)
  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) {
    return translate(lang, 'time.secondsAgo', { n: Math.max(1, seconds) })
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return translate(lang, 'time.minutesAgo', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return translate(lang, 'time.hoursAgo', { n: hours })
  const days = Math.floor(hours / 24)
  if (days < 7) return translate(lang, 'time.daysAgo', { n: days })
  return new Date(timestamp).toLocaleDateString(
    lang === 'zh-CN' ? 'zh-CN' : 'en-US',
  )
}

/**
 * 一种可以跨多次渲染保存的展示消息：本地翻译键在切换语言时重新翻译，
 * 不参与翻译的原始文本则原样保留。
 * `prefix` 把本地前缀（如“退出登录失败：”）与另一条消息组合起来，
 * 不在事件发生时立刻拼出完整文本。
 */
export type DisplayMessage =
  | {
      kind: 'local'
      key: TranslationKey
      params?: Record<string, string | number>
    }
  | { kind: 'raw'; text: string }
  | { kind: 'prefix'; prefix: TranslationKey; message: DisplayMessage }

/** 根据文案键构建一条消息，渲染时按当前语言翻译。 */
export function localMessage(
  key: TranslationKey,
  params?: Record<string, string | number>,
): DisplayMessage {
  return { kind: 'local', key, params }
}

/** 构建一条原样渲染的不透明原始消息（后端/外部文本）。 */
export function rawMessage(text: string): DisplayMessage {
  return { kind: 'raw', text }
}

/** 将一条本地前缀与另一条消息组合。 */
export function prefixMessage(
  prefix: TranslationKey,
  message: DisplayMessage,
): DisplayMessage {
  return { kind: 'prefix', prefix, message }
}

/** 渲染时把消息翻译成当前语言。 */
export function renderMessage(
  message: DisplayMessage | null | undefined,
  lang: SupportedLanguage,
): string {
  if (!message) return ''
  switch (message.kind) {
    case 'local':
      return translate(lang, message.key, message.params)
    case 'raw':
      return message.text
    case 'prefix':
      return (
        translate(lang, message.prefix) + renderMessage(message.message, lang)
      )
  }
}
