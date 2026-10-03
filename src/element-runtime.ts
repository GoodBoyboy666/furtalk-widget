import { LitElement, unsafeCSS } from 'lit'

// Widget 样式表由 Tailwind 在 Vite 构建期间编译，并通过 ?inline 查询以可信字符串形式导入。
// Lit 在组件的 Shadow DOM 内采用它；不会注入页面级 <style>。
import widgetCss from './styles.css?inline'

import { ApiClient, WIDGET_PAGE_SIZE, WIDGET_REPLY_PAGE_SIZE } from './api'
import type { CaptchaHandle } from './captcha'
import type { ConfigError, WidgetConfig } from './config'
import { parseWidgetConfig } from './config'
import { toWidgetError } from './errors'
import { loadEmojiCatalog, type EmojiCatalog } from './emoji'
import {
  localMessage,
  rawMessage,
  resolveLanguage,
  translate,
  type DisplayMessage,
  type SupportedLanguage,
  type TranslationKey,
} from './i18n'
import {
  defaultServiceOrigin,
  emptyComposer,
  type ComposerState,
} from './element-model'
import { validateProfileHints } from './profile'
import { initialState, widgetReducer, type WidgetState } from './state'
import { createProfileStore, loadLanguage, type ProfileStore } from './storage'
import type { CommentSort, ProfileHints, RuntimeConfig } from './types'

export class ElementRuntime extends LitElement {
  static override properties = {
    siteId: { type: String, attribute: 'site-id' },
    pageKey: { type: String, attribute: 'page-key' },
    pageUrl: { type: String, attribute: 'page-url' },
    pageTitle: { type: String, attribute: 'page-title' },
    serviceOrigin: { type: String, attribute: 'service-origin' },
  }

  static override styles = unsafeCSS(widgetCss)

  siteId = ''
  pageKey = ''
  pageUrl = ''
  pageTitle = ''
  serviceOrigin = ''

  protected state: WidgetState = initialState
  protected config: WidgetConfig | null = null
  protected configError: ConfigError | null = null
  protected api: ApiClient | null = null
  protected store: ProfileStore | null = null
  protected booted = false
  /** 评论请求世代；结构或浏览者变化时使旧完成失效。 */
  protected commentGeneration = 0
  protected rootRequestToken = 0
  protected replyRequestTokens = new Map<string, number>()
  /** 配置和会话探测与组件生命周期绑定。 */
  protected lifecycleToken = 0
  protected sessionProbeToken = 0

  /** 每个区域临时的展示状态；两组均不持久化。 */
  protected overflowingRegions = new Set<string>()
  protected expandedRegions = new Set<string>()
  protected regionResizeObserver: ResizeObserver | null = null
  protected observedRegionTargets = new Set<HTMLElement>()
  protected regionFallbackCleanup: (() => void) | null = null

  protected hints: ProfileHints = { email: '', nickname: '', website_url: '' }

  /** 当前展示语言；在首次渲染前解析。 */
  protected language: SupportedLanguage = resolveLanguage(null, [])

  /** 图标触发的语言菜单当前是否打开。 */
  protected languageMenuOpen = false
  /** 菜单关闭时用来移除文档级的外部点击监听器。 */
  protected languageMenuClose: (() => void) | null = null

  /** widget 级提示，用于展示可恢复的情况（如退出登录失败、弹窗被拦截）。 */
  protected widgetNotice: {
    text: DisplayMessage
    reopenLogout?: boolean
  } | null = null

  protected root: ComposerState = emptyComposer()
  protected reply: ComposerState | null = null
  protected deletingId: string | null = null

  protected captchaHandles = new Map<string, CaptchaHandle>()
  protected captchaMounted = new Set<string>()
  /** 无法渲染必需验证码的编辑器；不要在循环里重试。 */
  protected captchaFailed = new Set<string>()
  /** 当前 CAPTCHA 掩膜所属的编辑器键（'root' | 'reply'）。 */
  protected captchaMaskKey: 'root' | 'reply' | null = null
  /** 上一个掩膜键，用于把焦点还给触发编辑器。 */
  protected lastMaskKey: 'root' | 'reply' | null = null
  /** 掩膜验证通过后一次性恢复挂起的编辑器动作。 */
  protected pendingMaskedSubmit: (() => void) | null = null

  /** 选择器使用的远程表情包目录；配置前为空。 */
  protected emojiCatalog: EmojiCatalog | null = null
  /** 目录加载状态；失败从不阻塞评论。 */
  protected emojiState: 'idle' | 'loading' | 'ready' | 'error' = 'idle'
  /** 当前打开的表情面板；同时只开一个。 */
  protected emojiOpenKey: 'root' | 'reply' | null = null
  /** 上一个打开键，用于把焦点还给触发编辑器。 */
  protected lastEmojiOpenKey: 'root' | 'reply' | null = null
  /** 表情面板内当前激活的分类页签 id。 */
  protected emojiActiveTab = ''
  /** 挂起目录加载的标识；过期完成会被忽略。 */
  protected emojiLoadToken = 0
  /** 在重启/重试/断开时中止进行中的目录请求。 */
  protected emojiAbort: AbortController | null = null

  /** 由交互层挂接长区域测量的连接逻辑。 */
  protected setupRegionMeasurementFallback(): void {
    // 交互层覆盖此钩子；基础运行时不单独创建测量资源。
  }

  override connectedCallback(): void {
    super.connectedCallback()
    this.setupRegionMeasurementFallback()
    if (!this.booted) {
      this.booted = true
      this.boot()
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    this.lifecycleToken += 1
    this.invalidatePagination()
    this.booted = false
    this.regionResizeObserver?.disconnect()
    this.regionResizeObserver = null
    this.observedRegionTargets.clear()
    this.regionFallbackCleanup?.()
    this.regionFallbackCleanup = null
    this.languageMenuClose?.()
    this.languageMenuClose = null
    this.languageMenuOpen = false
    for (const handle of this.captchaHandles.values()) {
      try {
        handle.reset()
      } catch {
        // 尽力清理，失败可忽略。
      }
    }
    this.captchaHandles.clear()
    this.captchaMounted.clear()
    this.captchaFailed.clear()
    this.captchaMaskKey = null
    this.lastMaskKey = null
    this.pendingMaskedSubmit = null
    this.emojiOpenKey = null
    this.lastEmojiOpenKey = null
    this.emojiLoadToken += 1
    this.emojiAbort?.abort()
    this.emojiAbort = null
  }

  /** 启动 widget：解析语言、解析配置、加载运行时配置、线程与会话。 */
  boot(): void {
    this.lifecycleToken += 1
    this.invalidatePagination()
    // 首次渲染前解析初始语言，使 widget 根元素携带正确的 `lang` 属性，所有文案按所选语言渲染。
    // 已存偏好优先，其次浏览器语言列表，最后 `en`。
    this.language = resolveLanguage(loadLanguage(), navigator.languages)
    this.state = initialState
    this.overflowingRegions.clear()
    this.expandedRegions.clear()
    this.regionResizeObserver?.disconnect()
    this.regionResizeObserver = null
    this.observedRegionTargets.clear()
    this.configError = null
    this.root = emptyComposer()
    this.reply = null
    this.deletingId = null
    this.widgetNotice = null
    this.languageMenuClose?.()
    this.languageMenuClose = null
    this.languageMenuOpen = false
    this.captchaFailed.clear()
    this.captchaMaskKey = null
    this.lastMaskKey = null
    this.pendingMaskedSubmit = null
    this.emojiCatalog = null
    this.emojiState = 'idle'
    this.emojiOpenKey = null
    this.lastEmojiOpenKey = null
    this.emojiActiveTab = ''
    this.emojiLoadToken += 1
    this.emojiAbort?.abort()
    this.emojiAbort = null
    const parsed = parseWidgetConfig(
      {
        'site-id': this.siteId,
        'page-key': this.pageKey,
        'page-url': this.pageUrl || null,
        'page-title': this.pageTitle || null,
        'service-origin': this.serviceOrigin || null,
      },
      window.location,
      defaultServiceOrigin(),
      { href: window.location.href, title: document.title },
    )
    if ('code' in parsed) {
      this.configError = parsed
      this.requestUpdate()
      return
    }
    this.config = parsed
    this.api = new ApiClient({ origin: parsed.serviceOrigin })
    this.store = createProfileStore(parsed.serviceOrigin, parsed.siteId)
    this.hints = { ...this.store.load() }
    void this.load()
  }

  /** 加载运行时配置，然后加载线程首页。供重试使用。 */
  async load(): Promise<void> {
    if (!this.api || !this.config) return
    const lifecycle = ++this.lifecycleToken
    this.invalidatePagination()
    this.state = widgetReducer(this.state, { type: 'config/loading' })
    this.requestUpdate()
    try {
      const config = await this.api.runtimeConfig(this.config.siteId)
      if (lifecycle !== this.lifecycleToken) return
      this.state = widgetReducer(this.state, { type: 'config/loaded', config })
      this.requestUpdate()
      this.startEmojiLoad(config)
      await this.loadPage()
      if (lifecycle !== this.lifecycleToken) return
      // 首页已经携带当前 Cookie，首次探测只补充会话资料。
      await this.probeSession(false)
    } catch (error) {
      if (lifecycle !== this.lifecycleToken) return
      this.fail(error)
    }
  }

  // startEmojiLoad 在运行时配置就绪后，单独启动远程表情目录的加载。
  // 未配置 URL 时保持空目录（不显示触发按钮）；
  // 加载失败不进入全局错误处理，只在表情面板内提示并允许重试。
  protected startEmojiLoad(config: RuntimeConfig): void {
    const url = (config.emoji_catalog_url ?? '').trim()
    if (url === '') {
      this.emojiCatalog = null
      this.emojiState = 'idle'
      this.emojiActiveTab = ''
      return
    }
    this.emojiState = 'loading'
    this.emojiActiveTab = ''
    const token = ++this.emojiLoadToken
    this.emojiAbort?.abort()
    this.emojiAbort = new AbortController()
    void this.loadEmojiToken(url, token)
  }

  protected async loadEmojiToken(url: string, token: number): Promise<void> {
    const signal = this.emojiAbort?.signal
    try {
      const catalog = await loadEmojiCatalog({ url, signal })
      if (token !== this.emojiLoadToken) return
      this.emojiCatalog = catalog
      this.emojiState = 'ready'
      const first = this.emojiCatalog.packs[0]
      if (first) {
        this.emojiActiveTab = first.id
      }
      this.requestUpdate()
    } catch {
      if (token !== this.emojiLoadToken) return
      // 目录加载失败不影响评论：保留空目录并展示重试，评论流程不受影响。
      this.emojiState = 'error'
      this.requestUpdate()
    }
  }

  protected retryEmojiLoad(): void {
    if (!this.config) return
    this.emojiAbort?.abort()
    this.emojiAbort = new AbortController()
    this.loadEmojiToken(
      (this.state.config?.emoji_catalog_url ?? '').trim(),
      ++this.emojiLoadToken,
    )
    this.emojiState = 'loading'
    this.requestUpdate()
  }

  /** 使当前评论请求失效并清理依赖旧结构的回复缓存。 */
  protected invalidatePagination(): void {
    this.commentGeneration += 1
    this.rootRequestToken += 1
    this.replyRequestTokens.clear()
    this.state = {
      ...this.state,
      repliesByRoot: {},
      loadingMore: false,
      loadingComments: false,
    }
  }

  /** 加载一个根评论游标页；首页刷新会使旧回复请求失效。 */
  async loadPage(cursor?: string): Promise<void> {
    if (!this.api || !this.config) return
    if (cursor && (this.state.loadingMore || this.state.loadingComments)) return
    if (!cursor) this.invalidatePagination()
    const generation = this.commentGeneration
    const token = ++this.rootRequestToken
    const api = this.api
    const { siteId, pageKey } = this.config
    const sort = this.state.sort
    const current = () =>
      generation === this.commentGeneration && token === this.rootRequestToken
    this.state = widgetReducer(this.state, {
      type: cursor ? 'thread/load-more' : 'thread/loading',
    })
    this.requestUpdate()
    try {
      const previousIds = new Set(
        this.state.comments.map((comment) => comment.id),
      )
      const thread = await api.listRootComments(
        siteId,
        pageKey,
        cursor,
        WIDGET_PAGE_SIZE,
        sort,
      )
      if (!current()) return
      this.state = widgetReducer(this.state, {
        type: cursor ? 'thread/appended' : 'thread/loaded',
        thread,
      })
      this.requestUpdate()
      // 根列表先渲染；每条新增根评论直接启动自己的首批回复请求。
      for (const root of thread.comments) {
        if (root.has_replies && (!cursor || !previousIds.has(root.id))) {
          void this.loadReplies(root.id)
        }
      }
    } catch (error) {
      if (!current()) return
      if (this.state.thread) {
        this.state = widgetReducer(this.state, {
          type: 'thread/error',
          error: toWidgetError(error),
          cursor,
        })
      } else {
        this.fail(error)
      }
      this.requestUpdate()
    }
  }

  /** 加载指定根评论的一页回复；失败和重试只影响该根评论。 */
  async loadReplies(rootId: string, append = false): Promise<void> {
    if (
      !this.api ||
      !this.config ||
      !this.state.comments.some((root) => root.id === rootId)
    )
      return
    const page = this.state.repliesByRoot[rootId]
    if (
      page?.loading ||
      (append && !page?.nextCursor) ||
      (!append && page?.loaded)
    )
      return
    const cursor = append ? (page?.nextCursor ?? undefined) : undefined
    const generation = this.commentGeneration
    const token = (this.replyRequestTokens.get(rootId) ?? 0) + 1
    this.replyRequestTokens.set(rootId, token)
    const current = () =>
      generation === this.commentGeneration &&
      token === this.replyRequestTokens.get(rootId) &&
      this.state.comments.some((root) => root.id === rootId)
    const api = this.api
    const { siteId, pageKey } = this.config
    this.state = widgetReducer(this.state, { type: 'replies/loading', rootId })
    this.requestUpdate()
    try {
      const replyPage = await api.listReplies(
        siteId,
        pageKey,
        rootId,
        cursor,
        WIDGET_REPLY_PAGE_SIZE,
      )
      if (!current()) return
      this.state = widgetReducer(this.state, {
        type: 'replies/loaded',
        rootId,
        page: replyPage,
      })
      // 手动追加后展开整个回复区域，使新内容可以直接被找到。
      if (append) this.expandedRegions.add(`children:${rootId}`)
      this.requestUpdate()
    } catch (error) {
      if (!current()) return
      this.state = widgetReducer(this.state, {
        type: 'replies/error',
        rootId,
        error: toWidgetError(error),
      })
      this.requestUpdate()
    }
  }

  /**
   * 切换线程排序。切换会丢弃旧游标与已加载的评论（通过 `sort/change` 动作），
   * 再按新排序重新加载首页；之后的加载更多沿用同一排序。
   * 这只是本次实例的临时偏好，不会改动管理员配置的默认值。
   */
  protected changeSort(sort: CommentSort): void {
    if (this.state.sort === sort) return
    this.state = widgetReducer(this.state, { type: 'sort/change', sort })
    this.requestUpdate()
    void this.loadPage()
  }

  /**
   * 探测 widget 会话，重试和授权交换之后都会调用。
   * 返回探测请求本身是否成功，以便建立新会话时把探测失败当作最终结果，
   * 绝不复用旧状态。
   */
  async probeSession(refreshOnChange = true): Promise<boolean> {
    if (!this.api) return false
    const lifecycle = this.lifecycleToken
    const token = ++this.sessionProbeToken
    try {
      const session = await this.api.widgetSession()
      if (lifecycle !== this.lifecycleToken || token !== this.sessionProbeToken)
        return false
      const previous = this.state.session
      const viewerChanged =
        (previous?.valid === true) !== session.valid ||
        (session.valid &&
          (previous?.user_id !== session.user_id ||
            previous?.site_id !== session.site_id))
      this.state = widgetReducer(this.state, {
        type: 'session/probed',
        session,
      })
      this.requestUpdate()
      if (refreshOnChange && viewerChanged) void this.loadPage()
      return true
    } catch {
      // 普通加载流程里的会话探测只作为参考；建立新凭据的写入流程必须使用返回的布尔结果。
      return false
    }
  }

  protected fail(error: unknown): void {
    const widgetError = toWidgetError(error)
    this.state = widgetReducer(this.state, {
      type: 'error',
      error: widgetError,
    })
    this.requestUpdate()
  }

  protected get mode(): 'anonymous' | 'authenticated' {
    return this.state.config?.comment_mode ?? 'anonymous'
  }

  protected get threadClosed(): boolean {
    return Boolean(
      this.state.thread && !this.state.thread.thread.comments_enabled,
    )
  }

  protected get sessionValid(): boolean {
    return this.state.session?.valid === true
  }

  protected get authenticatedSessionValid(): boolean {
    return (
      this.sessionValid &&
      this.state.session?.credential_mode === 'authenticated'
    )
  }

  protected get adminWidgetSessionValid(): boolean {
    return this.sessionValid && this.state.session?.role === 'admin'
  }

  protected get normalizedHints(): ProfileHints {
    return validateProfileHints(this.hints)
  }

  /** 把文案键翻译成当前语言。 */
  protected t(
    key: TranslationKey,
    params?: Record<string, string | number>,
  ): string {
    return translate(this.language, key, params)
  }

  /** 把未知的错误值转换成用于展示的提示消息。 */
  protected composeMessage(error: unknown): DisplayMessage {
    if (error instanceof Error && error.message) {
      return rawMessage(error.message)
    }
    return localMessage('common.operationFailed')
  }
}
