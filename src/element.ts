/**
 * <furtalk-comments> custom element.
 *
 * Framework-independent, style-isolated via Shadow DOM. Boots by loading the
 * widget runtime config, the current thread, and the widget session, then
 * renders the discussion with root/reply composers, profile editing, CAPTCHA
 * rendering, popup authorization (authenticated sessions and the anonymous
 * administrator-email retry), owner delete, and every recoverable state.
 *
 * Anonymous mode is an untrusted attribution model: ordinary visitors submit
 * one create request carrying email/nickname/website plus the comment CAPTCHA,
 * with no session establishment, profile PATCH or preflight. An administrator
 * email without a valid widget credential receives `need_auth_code` from the
 * create endpoint, which runs the first-party popup -> exchange -> probe flow
 * and retries the same comment.
 *
 * All cross-origin calls use credentials: "include" so the partitioned CHIPS
 * cookie is sent. The server's CORS and live origin authorization remain
 * authoritative; runtime-config CAPTCHA data is a render hint only.
 */

import { LitElement, html, nothing, unsafeCSS, type TemplateResult } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'

// The widget stylesheet is compiled by Tailwind during the Vite build and
// imported as a trusted string via the ?inline query. Lit adopts it inside the
// component's Shadow DOM; no page-level <style> is injected.
import widgetCss from './styles.css?inline'

import { ApiClient, WIDGET_PAGE_SIZE } from './api'
import { runAuthorizationFlow, type AuthorizationOutcome } from './auth'
import { mountCaptcha, type CaptchaHandle } from './captcha'
import {
  buildCommentTree,
  hasNextPage,
  isOwnedBy,
  submissionNotice,
  type CommentNode,
} from './comments'
import type { WidgetConfig } from './config'
import { parseWidgetConfig } from './config'
import { toWidgetError, WidgetError } from './errors'
import { renderMarkdown } from './markdown'
import { loadCatalog, type EmojiGroup, type EmojiItem } from './owo'
import { insertAtSelection } from './insertion'
import { validateProfileHints } from './profile'
import {
  initialState,
  widgetReducer,
  type AuthPhase,
  type PendingAction,
  type WidgetState,
} from './state'
import { createProfileStore, type ProfileStore } from './storage'
import type {
  CaptchaProjection,
  Comment,
  CommentSort,
  ProfileHints,
  RuntimeConfig,
  WidgetSession,
} from './types'

/** Derives the Furtalk service origin from the script URL (import.meta.url). */
export function defaultServiceOrigin(): string {
  try {
    return new URL('.', import.meta.url).origin
  } catch {
    return ''
  }
}

/** Per-composer CAPTCHA token for the unified `comment` action. */
interface ComposerTokens {
  comment: string
}

interface ComposerState extends ComposerTokens {
  body: string
  error: string
  /** Non-null when this is the reply composer for a specific comment. */
  replyTargetId: string | null
}

const emptyComposer = (replyTargetId: string | null = null): ComposerState => ({
  comment: '',
  body: '',
  error: '',
  replyTargetId,
})

/**
 * Narrowing guard for the unified create response: a `200` with
 * `{need_auth_code: true}` means the submitted email maps to an administrator
 * without a valid widget credential, not a created comment.
 */
function isNeedAuthCodeResult(
  result: Comment | { need_auth_code: true },
): result is { need_auth_code: true } {
  return (result as { need_auth_code?: boolean }).need_auth_code === true
}

const AUTH_NOTICE: Record<AuthPhase, { title: string; detail: string }> = {
  idle: { title: '', detail: '' },
  opening: { title: '正在打开授权窗口…', detail: '请在弹出窗口中完成授权。' },
  waiting: { title: '等待授权…', detail: '授权窗口已打开，请完成登录与授权。' },
  exchanging: { title: '正在完成授权…', detail: '正在建立评论会话，请稍候。' },
  cancelled: {
    title: '已取消授权',
    detail: '取消授权后无法以账号身份发表评论。',
  },
  blocked: {
    title: '授权窗口被拦截',
    detail: '请允许本站点弹出窗口后重试。',
  },
  closed: {
    title: '授权窗口已关闭',
    detail: '可以重新发起授权。',
  },
  expired: {
    title: '登录状态已过期',
    detail: '请重新授权后再发表评论。',
  },
  unsupported: {
    title: '浏览器不支持评论会话',
    detail:
      '当前浏览器未保存评论会话 Cookie（可能禁用了第三方 Cookie 或分区 Cookie）。请允许后重试。',
  },
}

// ---- Static Tailwind presentation constants ---------------------------------
// Component presentation lives as complete static utility candidates on the
// rendered elements (see design.md). Constants below only group genuinely
// repeated foundations; every candidate stays literal and scanner-visible.

/** Profile row: three equal columns that collapse to one narrow column. */
const PROFILE_ROW =
  'grid grid-cols-3 [border-bottom:1px_solid_var(--furtalk-border)] [@media(max-width:480px)]:grid-cols-1'

/** Divider between adjacent profile fields (desktop left, narrow top). */
const FIELD_DIVIDER =
  '[border-left:1px_solid_var(--furtalk-border)] [@media(max-width:480px)]:[border-left:0] [@media(max-width:480px)]:[border-top:1px_solid_var(--furtalk-border)]'

/** Comment actions row (spreads across; stacks vertically when narrow). */
const ACTIONS_ROW =
  'flex flex-wrap items-center justify-between gap-2 [@media(max-width:480px)]:flex-col [@media(max-width:480px)]:items-stretch [@media(max-width:480px)]:gap-2'

/** Nested comment list for flat replies under a root comment. */
const CHILDREN_LIST =
  'ft-children list-none m-0 mt-3 pl-3.5 [border-left:2px_solid_var(--furtalk-border)] flex flex-col gap-2 w-full [@media(max-width:480px)]:pl-2.5'

/** Shared button chrome (sizing, focus ring); color/background are per kind. */
const BASE_BUTTON =
  'border border-solid rounded-(--furtalk-radius) px-3.5 py-[7px] cursor-pointer [font:inherit] font-medium transition-all duration-150 disabled:opacity-50 disabled:cursor-default focus-visible:outline-2 focus-visible:outline-(--furtalk-accent) focus-visible:outline-offset-1'

/** Default button: bordered, muted background, inherits the theme text. */
const DEFAULT_BUTTON =
  BASE_BUTTON +
  ' border-(--furtalk-border) bg-(--furtalk-bg-muted) text-(--furtalk-text) hover:bg-(--furtalk-border)/40'

/** Primary action button: accent fill with white text. */
const PRIMARY_BUTTON =
  BASE_BUTTON +
  ' border-(--furtalk-accent) bg-(--furtalk-accent) text-white text-[13px] hover:brightness-105 active:scale-[0.99] shadow-2xs'

/** Borderless/transparent chrome for ghost buttons. */
const GHOST_BUTTON =
  'border-0 bg-transparent rounded-(--furtalk-radius) cursor-pointer [font:inherit] font-medium transition-all duration-150 disabled:opacity-50 disabled:cursor-default focus-visible:outline-2 focus-visible:outline-(--furtalk-accent) focus-visible:outline-offset-1'

/** Danger chrome (red text, no border); sizing is added per context. */
const DANGER_CHROME =
  'border-0 bg-transparent text-(--furtalk-danger) rounded-(--furtalk-radius) cursor-pointer [font:inherit] font-medium transition-all duration-150 disabled:opacity-50 disabled:cursor-default enabled:hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-(--furtalk-accent) focus-visible:outline-offset-1'

/** Danger button outside the comment actions row (e.g. logout). */
const DANGER_BUTTON = DANGER_CHROME + ' text-[13px] px-3.5 py-[7px]'

/** Danger button inside the comment actions row (compact size). */
const ACTION_DANGER_BUTTON = DANGER_CHROME + ' text-[12px] px-1.5 py-0.5'

/** Comment list action buttons (回复 / 取消). */
const ACTION_BUTTON =
  GHOST_BUTTON +
  ' text-(--furtalk-text-muted) text-[12px] px-1.5 py-0.5 rounded-md enabled:hover:bg-(--furtalk-bg-muted) enabled:hover:text-(--furtalk-text)'

/** Sort control buttons; the pressed button switches to the accent fill. */
const SORT_BUTTON =
  GHOST_BUTTON +
  ' text-(--furtalk-text-muted) text-[12px] px-2.5 py-1 hover:bg-(--furtalk-bg-muted) hover:text-(--furtalk-text) aria-pressed:bg-(--furtalk-accent) aria-pressed:text-white aria-pressed:font-semibold'

/** OwO category tab buttons; the selected tab switches to the accent fill. */
const OWO_TAB_BUTTON =
  GHOST_BUTTON +
  ' text-(--furtalk-text-muted) text-[12px] px-2.5 py-[4px] hover:bg-(--furtalk-bg-muted) hover:text-(--furtalk-text) aria-selected:bg-(--furtalk-accent) aria-selected:text-white aria-selected:font-medium'

/** OwO emoji item buttons. */
const OWO_ITEM_BUTTON =
  'inline-flex items-center justify-start min-h-8 max-w-full px-2 py-1 border-0 bg-transparent text-[14px] leading-none whitespace-nowrap cursor-pointer [font:inherit] rounded-md transition-colors hover:bg-(--furtalk-bg)'

/** OwO picker trigger button. */
const OWO_TRIGGER_BUTTON =
  'inline-flex items-center p-1.5 border-0 bg-transparent text-(--furtalk-text-muted) rounded-(--furtalk-radius) cursor-pointer [font:inherit] transition-colors hover:text-(--furtalk-text) hover:bg-(--furtalk-bg-muted) aria-expanded:text-(--furtalk-accent) aria-expanded:bg-(--furtalk-bg-muted) focus-visible:outline-2 focus-visible:outline-(--furtalk-accent) focus-visible:outline-offset-1'

/** Load-more button. */
const LOAD_MORE_BUTTON =
  GHOST_BUTTON +
  ' mx-auto text-(--furtalk-text-muted) text-[13px] px-4 py-2 border border-solid border-(--furtalk-border) bg-(--furtalk-bg) hover:text-(--furtalk-text) hover:bg-(--furtalk-bg-muted)'

/** Muted helper copy. */
const NOTE_TEXT = 'text-(--furtalk-text-muted) text-[13px]'

/** Neutral centered state box (loading / empty). */
const STATE_TEXT =
  'ft-state px-4 py-8 text-center text-(--furtalk-text-muted) text-[14px]'

/** Error state box (keeps the ft-state hook alongside ft-error). */
const STATE_ERROR =
  'ft-state ft-error border border-solid border-[#fecaca] bg-[#fef2f2] text-[#b91c1c] p-3.5 rounded-(--furtalk-radius) text-center text-[14px]'

/** Text inputs and textarea baseline. */
const INPUT_TEXT =
  '[font:inherit] border-0 rounded-none px-3 py-2 bg-(--furtalk-bg) text-(--furtalk-text) min-w-0 w-full'

/** Root widget surface. */
const WIDGET_ROOT =
  'ft-widget bg-(--furtalk-bg) rounded-(--furtalk-radius) text-[15px]'

/** Formats a timestamp as relative time (<7d) or localized date string (>=7d). */
export function formatRelativeTime(
  isoString: string,
  now: number = Date.now(),
): string {
  const timestamp = Date.parse(isoString)
  if (Number.isNaN(timestamp)) return isoString
  const diffMs = Math.max(0, now - timestamp)
  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return `${Math.max(1, seconds)}秒前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}天前`
  return new Date(timestamp).toLocaleDateString()
}

export class FurtalkCommentsElement extends LitElement {
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

  private state: WidgetState = initialState
  private config: WidgetConfig | null = null
  private configError: string | null = null
  private api: ApiClient | null = null
  private store: ProfileStore | null = null
  private booted = false

  private hints: ProfileHints = { email: '', nickname: '', website_url: '' }

  /** Recoverable widget-level notice (logout failures and popup-block fallbacks). */
  private widgetNotice: { text: string; reopenLogout?: boolean } | null = null

  private root: ComposerState = emptyComposer()
  private reply: ComposerState | null = null
  private deletingId: string | null = null

  private captchaHandles = new Map<string, CaptchaHandle>()
  private captchaMounted = new Set<string>()
  /** Keys whose required CAPTCHA could not be rendered; do not retry in a loop. */
  private captchaFailed = new Set<string>()
  /** Composer key ('root' | 'reply') whose CAPTCHA mask is currently open. */
  private captchaMaskKey: 'root' | 'reply' | null = null
  /** Previous mask key, used to restore focus to the triggering composer. */
  private lastMaskKey: 'root' | 'reply' | null = null
  /** One-shot resume of the pending composer action after the mask solves. */
  private pendingMaskedSubmit: (() => void) | null = null

  /** Remote catalog used by the picker; empty until a URL is configured. */
  private owoCatalog: EmojiGroup[] = []
  /** Catalog load state; failures never block commenting. */
  private owoState: 'idle' | 'loading' | 'ready' | 'error' = 'idle'
  /** Picker panel currently open; one panel at a time. */
  private owoOpenKey: 'root' | 'reply' | null = null
  /** Previous open key, used to restore focus to the triggering composer. */
  private lastOwoOpenKey: 'root' | 'reply' | null = null
  /** Active category tab label within the picker. */
  private owoActiveTab = ''
  /** Pending catalog load identity; stale completions are ignored. */
  private owoLoadToken = 0
  /** Aborts the in-flight catalog request on reboot/retry/disconnect. */
  private owoAbort: AbortController | null = null

  override connectedCallback(): void {
    super.connectedCallback()
    if (!this.booted) {
      this.booted = true
      this.boot()
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    for (const handle of this.captchaHandles.values()) {
      try {
        handle.reset()
      } catch {
        // Best-effort teardown.
      }
    }
    this.captchaHandles.clear()
    this.captchaMounted.clear()
    this.captchaFailed.clear()
    this.captchaMaskKey = null
    this.lastMaskKey = null
    this.pendingMaskedSubmit = null
    this.owoOpenKey = null
    this.lastOwoOpenKey = null
    this.owoLoadToken += 1
    this.owoAbort?.abort()
    this.owoAbort = null
  }

  /** Boots the widget: parse config, load runtime config, thread and session. */
  boot(): void {
    this.state = initialState
    this.configError = null
    this.root = emptyComposer()
    this.reply = null
    this.deletingId = null
    this.widgetNotice = null
    this.captchaFailed.clear()
    this.captchaMaskKey = null
    this.lastMaskKey = null
    this.pendingMaskedSubmit = null
    this.owoCatalog = []
    this.owoState = 'idle'
    this.owoOpenKey = null
    this.lastOwoOpenKey = null
    this.owoActiveTab = ''
    this.owoLoadToken += 1
    this.owoAbort?.abort()
    this.owoAbort = null
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
    if ('error' in parsed) {
      this.configError = parsed.error
      this.requestUpdate()
      return
    }
    this.config = parsed
    this.api = new ApiClient({ origin: parsed.serviceOrigin })
    this.store = createProfileStore(parsed.serviceOrigin, parsed.siteId)
    this.hints = { ...this.store.load() }
    void this.load()
  }

  /** Loads runtime config then the first thread page. Exposed for retry. */
  async load(): Promise<void> {
    if (!this.api || !this.config) return
    this.state = widgetReducer(this.state, { type: 'config/loading' })
    this.requestUpdate()
    try {
      const config = await this.api.runtimeConfig(this.config.siteId)
      this.state = widgetReducer(this.state, { type: 'config/loaded', config })
      this.requestUpdate()
      this.startCatalogLoad(config)
      await this.loadPage()
      await this.probeSession()
    } catch (error) {
      this.fail(error)
    }
  }

  // startCatalogLoad 在运行时配置可用后独立启动远程目录加载。
  // 未配置 URL 时保持空目录（触发器隐藏）；失败不进入全局 fail 路径，
  // 错误只在选择器内提示并可重试。
  private startCatalogLoad(config: RuntimeConfig): void {
    const url = (config.owo_catalog_url ?? '').trim()
    if (url === '') {
      this.owoCatalog = []
      this.owoState = 'idle'
      this.owoActiveTab = ''
      return
    }
    this.owoState = 'loading'
    this.owoActiveTab = ''
    const token = ++this.owoLoadToken
    this.owoAbort?.abort()
    this.owoAbort = new AbortController()
    void this.loadCatalogToken(url, token)
  }

  private async loadCatalogToken(url: string, token: number): Promise<void> {
    const signal = this.owoAbort?.signal
    try {
      const groups = await loadCatalog({ url, signal })
      if (token !== this.owoLoadToken) return
      this.owoCatalog = groups
      this.owoState = 'ready'
      const first = this.owoCatalog[0]
      if (first) {
        this.owoActiveTab = first.id
      }
      this.requestUpdate()
    } catch {
      if (token !== this.owoLoadToken) return
      // 目录失败非致命：保留空目录并展示重试，评论工作流不受影响。
      this.owoState = 'error'
      this.requestUpdate()
    }
  }

  private retryCatalogLoad(): void {
    if (!this.config) return
    this.owoAbort?.abort()
    this.owoAbort = new AbortController()
    this.loadCatalogToken(
      (this.state.config?.owo_catalog_url ?? '').trim(),
      ++this.owoLoadToken,
    )
    this.owoState = 'loading'
    this.requestUpdate()
  }

  /** Loads one cursor page (first page when cursor is null). */
  async loadPage(cursor?: string): Promise<void> {
    if (!this.api || !this.config) return
    if (cursor) {
      this.state = widgetReducer(this.state, { type: 'thread/load-more' })
    } else {
      this.state = widgetReducer(this.state, { type: 'thread/loading' })
    }
    this.requestUpdate()
    try {
      const thread = await this.api.listComments(
        this.config.siteId,
        this.config.pageKey,
        cursor,
        WIDGET_PAGE_SIZE,
        this.state.sort,
      )
      this.state = widgetReducer(this.state, {
        type: cursor ? 'thread/appended' : 'thread/loaded',
        thread,
      })
      this.requestUpdate()
    } catch (error) {
      if (cursor) {
        // A failed load-more keeps the visible thread; just stop the spinner.
        this.state = { ...this.state, loadingMore: false }
      } else {
        this.fail(error)
      }
      this.requestUpdate()
    }
  }

  /**
   * Switches the thread direction. A direction change discards the old cursor
   * and comments (via the `sort/change` reducer action) and reloads the first
   * page along the new direction; subsequent load-more pages reuse the same
   * direction. This is a per-instance temporary preference and never writes
   * the admin-configured default.
   */
  private changeSort(sort: CommentSort): void {
    if (this.state.sort === sort) return
    this.state = widgetReducer(this.state, { type: 'sort/change', sort })
    this.requestUpdate()
    void this.loadPage()
  }

  /**
   * Probes the widget session. Exposed for retry and after exchange. Returns
   * whether the probe request itself succeeded so fresh-session establishment
   * can treat a probe failure as authoritative (never reuse stale state).
   */
  async probeSession(): Promise<boolean> {
    if (!this.api) return false
    try {
      const session = await this.api.widgetSession()
      this.state = widgetReducer(this.state, {
        type: 'session/probed',
        session,
      })
      this.requestUpdate()
      return true
    } catch {
      // Session probing is best-effort for the general load path; write flows
      // that establish fresh credentials must use the boolean result.
      return false
    }
  }

  private fail(error: unknown): void {
    const widgetError = toWidgetError(error)
    this.state = widgetReducer(this.state, {
      type: 'error',
      error: widgetError,
    })
    this.requestUpdate()
  }

  private get mode(): 'anonymous' | 'authenticated' {
    return this.state.config?.comment_mode ?? 'anonymous'
  }

  private get threadClosed(): boolean {
    return Boolean(
      this.state.thread && !this.state.thread.thread.comments_enabled,
    )
  }

  private get sessionValid(): boolean {
    return this.state.session?.valid === true
  }

  private get authenticatedSessionValid(): boolean {
    return (
      this.sessionValid &&
      this.state.session?.credential_mode === 'authenticated'
    )
  }

  private get normalizedHints(): ProfileHints {
    return validateProfileHints(this.hints)
  }

  // ---- Profile -----------------------------------------------------------

  private saveProfile(): void {
    const normalized = this.normalizedHints
    this.hints = { ...normalized }
    this.store?.save(this.hints)
    this.requestUpdate()
  }

  private onProfileInput(field: keyof ProfileHints, value: string): void {
    this.hints = { ...this.hints, [field]: value }
    this.requestUpdate()
  }

  // ---- CAPTCHA -----------------------------------------------------------

  private commentCaptchaProjection(): CaptchaProjection | undefined {
    return this.state.config?.captcha?.comment
  }

  private isCommentCaptchaRequired(): boolean {
    return Boolean(this.commentCaptchaProjection()?.required)
  }

  /** Stable CAPTCHA host key per composer (only the `comment` action exists). */
  private composerKey(composer: ComposerState | null): 'root' | 'reply' {
    return composer?.replyTargetId ? 'reply' : 'root'
  }

  /** Mounts CAPTCHA widgets into their stable hosts after a render. */
  private syncCaptchas(): void {
    const root = this.renderRoot
    if (!root) return
    const hosts = root.querySelectorAll<HTMLElement>('[data-captcha-host]')
    const seen = new Set<string>()
    for (const host of hosts) {
      const key = host.dataset.captchaHost
      if (!key || seen.has(key)) continue
      seen.add(key)
      if (this.captchaFailed.has(key)) continue
      const composer = key === 'reply' ? this.reply : this.root
      if (!this.isCommentCaptchaRequired()) {
        this.teardownCaptcha(key)
        continue
      }
      if (this.captchaMounted.has(key)) continue
      this.captchaMounted.add(key)
      void this.mountOneCaptcha(key, host, composer)
    }
    // Tear down hosts that are no longer rendered (mounted or failed).
    for (const key of [...this.captchaMounted, ...this.captchaFailed]) {
      if (!seen.has(key)) this.teardownCaptcha(key)
    }
  }

  private teardownCaptcha(key: string): void {
    const wasMounted = this.captchaMounted.delete(key)
    const wasFailed = this.captchaFailed.delete(key)
    if (!wasMounted && !wasFailed) return
    const handle = this.captchaHandles.get(key)
    if (handle) {
      try {
        handle.reset()
      } catch {
        // Ignore reset failures during teardown.
      }
      this.captchaHandles.delete(key)
    }
    // 清空宿主容器，避免同一容器内重复渲染 provider 组件。
    const host = this.renderRoot?.querySelector<HTMLElement>(
      `[data-captcha-host="${key}"]`,
    )
    if (host) host.replaceChildren()
  }

  private async mountOneCaptcha(
    key: string,
    container: HTMLElement,
    composer: ComposerState | null,
  ): Promise<void> {
    const projection = this.commentCaptchaProjection()
    if (!projection) {
      this.captchaMounted.delete(key)
      return
    }
    const handle = await mountCaptcha(container, projection, (token) => {
      if (composer) composer.comment = token
      // 掩膜内解决：写入 token 后恢复挂起的提交恰好一次。
      if (token && this.captchaMaskKey === key) {
        this.resumeMaskedSubmit()
        return
      }
      this.requestUpdate()
    })
    if (handle) {
      this.captchaHandles.set(key, handle)
    } else {
      this.captchaMounted.delete(key)
      if (projection.required && composer) {
        // The policy requires CAPTCHA but no renderable provider is
        // configured (or the provider script failed to load). The server
        // stays authoritative; show a recoverable error inside the mask.
        this.captchaFailed.add(key)
        composer.error = '人机验证暂不可用，请稍后重试'
        this.requestUpdate()
      }
    }
  }

  // ---- CAPTCHA mask -------------------------------------------------------

  /**
   * Opens the in-Shadow-DOM CAPTCHA mask for a composer and stores a one-shot
   * resume callback. The pending submit runs only after a non-empty token
   * arrives; cancel, reply close, and failure paths drop the callback.
   */
  private openCaptchaMask(key: 'root' | 'reply', resume: () => void): void {
    this.captchaFailed.delete(key)
    this.captchaMaskKey = key
    this.pendingMaskedSubmit = resume
    this.requestUpdate()
  }

  /** Consumes and runs the stored pending submit once, then closes the mask. */
  private resumeMaskedSubmit(): void {
    const resume = this.pendingMaskedSubmit
    this.pendingMaskedSubmit = null
    this.captchaMaskKey = null
    this.requestUpdate()
    resume?.()
  }

  /** Cancels the open mask: drops the pending submit and tears down its host. */
  private cancelCaptchaMask(): void {
    if (!this.captchaMaskKey) return
    const key = this.captchaMaskKey
    this.pendingMaskedSubmit = null
    this.captchaMaskKey = null
    this.teardownCaptcha(key)
    this.requestUpdate()
  }

  // ---- Comment creation ---------------------------------------------------

  private submitRoot(): void {
    if (this.state.status === 'creating' || this.state.status === 'deleting') {
      return
    }
    if (this.captchaMaskKey === 'root') return
    if (this.root.body.trim() === '') {
      this.root.error = '评论内容不能为空'
      this.requestUpdate()
      return
    }
    if (!this.validateAttribution(this.root)) return
    void this.createComment(this.root)
  }

  private submitReply(): void {
    if (
      !this.reply ||
      this.state.status === 'creating' ||
      this.state.status === 'deleting'
    ) {
      return
    }
    if (this.captchaMaskKey === 'reply') return
    if (this.reply.body.trim() === '') {
      this.reply.error = '回复内容不能为空'
      this.requestUpdate()
      return
    }
    if (!this.validateAttribution(this.reply)) return
    void this.createComment(this.reply)
  }

  /**
   * Validates the required attribution fields before any request. Nickname is
   * required by the unified create contract and the server remains
   * authoritative, but an empty/invalid value must never silently submit.
   */
  private validateAttribution(composer: ComposerState): boolean {
    const hints = this.normalizedHints
    if (!hints.email) {
      composer.error = '请填写有效的邮箱地址'
      this.requestUpdate()
      return false
    }
    if (!hints.nickname) {
      composer.error = '请填写有效的昵称'
      this.requestUpdate()
      return false
    }
    return true
  }

  private async createComment(composer: ComposerState): Promise<void> {
    if (!this.api || !this.config) return
    if (!this.validateAttribution(composer)) return
    const action: PendingAction = {
      type: 'create',
      parentId: composer.replyTargetId ?? undefined,
      body: composer.body,
      captchaToken: composer.comment,
    }
    if (this.mode === 'anonymous') {
      // Anonymous mode is a direct one-request submission: ordinary visitors
      // need no session, no profile PATCH and no preflight. An administrator
      // email returns need_auth_code from the create endpoint, which routes
      // through the popup authorization flow and retries the same comment.
      this.saveProfile()
      await this.commentWithCaptchaGate(action, composer)
      return
    }
    // Authenticated mode: persist login hints locally and ensure a valid
    // session BEFORE the CAPTCHA challenge, so the mask only appears at the
    // moment of submission instead of before the authorization popup.
    this.saveProfile()
    if (!this.authenticatedSessionValid) {
      const ok = await this.ensureAuthenticated(action)
      if (!ok) return
      const fresh =
        this.reply?.replyTargetId === composer.replyTargetId
          ? this.reply
          : this.root
      await this.commentWithCaptchaGate(action, fresh)
      return
    }
    await this.commentWithCaptchaGate(action, composer)
  }

  /**
   * The CAPTCHA gate at the moment of submission. When the comment policy is
   * required and the composer has no token, open the mask and defer the
   * submit until a token arrives; otherwise submit directly. The resume
   * callback rebuilds the action with the fresh composer token so the write
   * always carries a just-solved value.
   */
  private async commentWithCaptchaGate(
    action: Extract<PendingAction, { type: 'create' }>,
    composer: ComposerState,
  ): Promise<void> {
    if (this.isCommentCaptchaRequired() && !composer.comment) {
      this.openCaptchaMask(this.composerKey(composer), () => {
        void this.performCreate(
          { ...action, captchaToken: composer.comment },
          composer,
        )
      })
      return
    }
    await this.performCreate(action, composer)
  }

  private async ensureAuthenticated(action: PendingAction): Promise<boolean> {
    if (!this.api || !this.config) return false
    this.state = widgetReducer(this.state, { type: 'pending/set', action })
    this.requestUpdate()
    const outcome = await this.runAuthorization()
    if (outcome.status !== 'success') {
      return false
    }
    try {
      await this.api.exchangeAuthorization(outcome.code)
    } catch (error) {
      this.state = widgetReducer(this.state, { type: 'auth/closed' })
      this.requestUpdate()
      this.root.error = this.composeMessage(error)
      return false
    }
    await this.probeSession()
    if (!this.authenticatedSessionValid) {
      // The exchange succeeded but the partitioned cookie did not stick.
      this.state = widgetReducer(this.state, { type: 'auth/unsupported' })
      this.requestUpdate()
      return false
    }
    this.state = widgetReducer(this.state, {
      type: 'auth/settled',
      session: this.state.session as WidgetSession,
    })
    this.requestUpdate()
    return true
  }

  /** Opens the authorization popup and records the outcome in the state. */
  private runAuthorization(): Promise<AuthorizationOutcome> {
    if (!this.config) return Promise.resolve({ status: 'blocked' })
    this.state = widgetReducer(this.state, { type: 'auth/opening' })
    this.requestUpdate()
    return runAuthorizationFlow({
      furtalkOrigin: this.config.serviceOrigin,
      siteId: this.config.siteId,
      hints: this.normalizedHints,
    }).then((outcome) => {
      if (outcome.status === 'success') {
        // Enter exchanging immediately when the popup reports approval, so the
        // banner never lingers on "opening" while the code exchange runs.
        this.state = widgetReducer(this.state, { type: 'auth/exchanging' })
        this.requestUpdate()
      } else {
        this.state = widgetReducer(this.state, this.outcomeToAction(outcome))
        this.requestUpdate()
      }
      return outcome
    })
  }

  private outcomeToAction(
    outcome: AuthorizationOutcome,
  ):
    | { type: 'auth/cancelled' }
    | { type: 'auth/blocked' }
    | { type: 'auth/closed' }
    | { type: 'auth/unsupported' } {
    switch (outcome.status) {
      case 'cancelled':
        return { type: 'auth/cancelled' }
      case 'blocked':
        return { type: 'auth/blocked' }
      case 'closed':
        return { type: 'auth/closed' }
      case 'timeout':
        return { type: 'auth/closed' }
      case 'success':
        // Success is handled by the caller after exchanging the code.
        return { type: 'auth/closed' }
    }
  }

  // ---- Two-layer logout ---------------------------------------------------

  /**
   * Logs out of the authenticated widget session and the first-party account.
   * Both actions start in the same user gesture: the widget session DELETE
   * clears the CHIPS cookie for this top-level site partition, while a
   * synchronously opened new tab runs the first-party /logout page. The two
   * sessions live in different cookie contexts, so their outcomes stay
   * independent; the widget reflects only its own session result.
   */
  private handleLogout(): void {
    if (this.mode !== 'authenticated' || !this.authenticatedSessionValid) return
    this.widgetNotice = null
    this.requestUpdate()
    void this.clearWidgetSession()
    this.openLogoutPage()
  }

  /** Clears the CHIPS widget session and unlocks the profile fields on success. */
  private async clearWidgetSession(): Promise<void> {
    if (!this.api) return
    try {
      await this.api.clearWidgetSession()
      this.state = widgetReducer(this.state, {
        type: 'auth/settled',
        session: { valid: false },
      })
      this.state = widgetReducer(this.state, { type: 'pending/clear' })
      this.requestUpdate()
    } catch (error) {
      this.widgetNotice = {
        text: '退出登录失败：' + this.composeMessage(error),
        reopenLogout: true,
      }
      this.requestUpdate()
    }
  }

  /** Opens the first-party /logout page in a new tab within the user gesture. */
  private openLogoutPage(): void {
    const origin = this.config?.serviceOrigin
    if (!origin) return
    let opened = false
    try {
      opened = window.open(`${origin}/logout`, '_blank', '') !== null
    } catch {
      opened = false
    }
    if (!opened) {
      // The widget session is still cleared by its own request; tell the user
      // the first-party account remains logged in and offer a manual action.
      this.widgetNotice = {
        text: '登出页面被浏览器拦截，主站登录尚未退出，请手动打开登出页。',
        reopenLogout: true,
      }
      this.requestUpdate()
    }
  }

  private async performCreate(
    action: Extract<PendingAction, { type: 'create' }>,
    composer: ComposerState,
    fromAuthRetry = false,
  ): Promise<void> {
    if (!this.api || !this.config) return
    const projection = this.commentCaptchaProjection()
    if (projection?.required && !action.captchaToken) {
      composer.error = '请先完成人机验证'
      this.requestUpdate()
      return
    }
    const hints = this.normalizedHints
    this.state = widgetReducer(this.state, { type: 'create/pending' })
    this.requestUpdate()
    try {
      const created = await this.api.createComment(
        this.config.siteId,
        {
          pageKey: this.config.pageKey,
          pageUrl: this.config.pageUrl,
          pageTitle: this.config.pageTitle,
          parentId: action.parentId,
          bodyMarkdown: action.body,
          email: hints.email,
          nickname: hints.nickname,
          websiteUrl: hints.website_url,
        },
        projection?.required ? action.captchaToken : '',
      )
      if (isNeedAuthCodeResult(created)) {
        // The email maps to an administrator and no valid widget credential
        // was attached: run the first-party popup -> exchange -> probe flow,
        // then retry the exact same comment. The need_auth_code branch runs
        // before CAPTCHA verification, so the still-unconsumed composer token
        // is reused for the retry when the policy requires one.
        this.state = widgetReducer(this.state, { type: 'create/settled' })
        this.state = widgetReducer(this.state, { type: 'pending/set', action })
        this.requestUpdate()
        if (fromAuthRetry) {
          composer.error = '授权未生效，请重试'
          this.requestUpdate()
          return
        }
        const ok = await this.ensureAuthenticated(action)
        if (!ok) return
        await this.performCreate(action, composer, true)
        return
      }
      this.state = widgetReducer(this.state, { type: 'create/settled' })
      this.state = widgetReducer(this.state, { type: 'pending/clear' })
      // Success copy is derived from the created comment status: pending means
      // the comment awaits moderation, published means it is live. Any other
      // status clears stale success feedback (failure never shows success).
      const notice = submissionNotice(created.status)
      this.state = widgetReducer(
        this.state,
        notice ? { type: 'notice/set', notice } : { type: 'notice/clear' },
      )
      if (composer.replyTargetId) {
        this.teardownCaptcha(this.composerKey(composer))
        this.reply = null
      } else {
        this.teardownCaptcha(this.composerKey(composer))
        this.root = emptyComposer()
      }
      this.requestUpdate()
      await this.loadPage()
    } catch (error) {
      this.state = widgetReducer(this.state, { type: 'create/settled' })
      this.requestUpdate()
      const widgetError = toWidgetError(error)
      if (
        widgetError.code === 'captcha_required' ||
        widgetError.code === 'captcha_failed'
      ) {
        composer.error = '请先完成人机验证'
        this.teardownCaptcha(this.composerKey(composer))
        return
      }
      if (
        widgetError.code === 'unauthorized' &&
        this.mode === 'authenticated'
      ) {
        // The widget session expired between the probe and the write.
        // Invalidate it and show a recoverable expired state; the retry
        // button re-runs the popup authorization then redoes the create.
        this.handleSessionExpired({
          type: 'create',
          parentId: action.parentId,
          body: action.body,
          captchaToken: action.captchaToken,
        })
        return
      }
      composer.error = widgetError.message
      this.requestUpdate()
    }
  }

  // ---- Deletion -----------------------------------------------------------

  private requestDelete(commentId: string): void {
    if (this.state.status === 'creating' || this.state.status === 'deleting') {
      return
    }
    this.deletingId = commentId
    this.requestUpdate()
  }

  /** Records a recoverable session-expired state for the pending action. */
  private handleSessionExpired(action: PendingAction): void {
    this.state = widgetReducer(this.state, {
      type: 'session/probed',
      session: { valid: false },
    })
    this.state = widgetReducer(this.state, { type: 'pending/set', action })
    this.state = widgetReducer(this.state, { type: 'auth/expired' })
    this.requestUpdate()
  }

  private cancelDelete(): void {
    this.deletingId = null
    this.requestUpdate()
  }

  private confirmDelete(): void {
    const commentId = this.deletingId
    if (!commentId) return
    this.deletingId = null
    void this.deleteComment(commentId)
  }

  private async deleteComment(commentId: string): Promise<void> {
    if (!this.api || !this.config) return
    if (this.mode === 'authenticated' && !this.authenticatedSessionValid) {
      const action: PendingAction = { type: 'delete', commentId }
      const ok = await this.ensureAuthenticated(action)
      if (!ok) return
    }
    this.state = widgetReducer(this.state, { type: 'delete/pending' })
    this.requestUpdate()
    try {
      await this.api.deleteComment(commentId)
      this.state = widgetReducer(this.state, { type: 'delete/settled' })
      this.requestUpdate()
      await this.loadPage()
    } catch (error) {
      this.state = widgetReducer(this.state, { type: 'delete/settled' })
      this.requestUpdate()
      const widgetError = toWidgetError(error)
      if (
        this.mode === 'authenticated' &&
        widgetError.code === 'unauthorized'
      ) {
        // Session expired between the probe and the delete: recover via
        // the popup authorization flow before retrying the delete.
        this.handleSessionExpired({ type: 'delete', commentId })
        return
      }
      this.fail(error)
    }
  }

  // ---- Reply composer -------------------------------------------------------

  private openReply(commentId: string): void {
    this.reply = emptyComposer(commentId)
    this.deletingId = null
    this.requestUpdate()
    requestAnimationFrame(() => {
      const textarea = this.renderRoot.querySelector<HTMLTextAreaElement>(
        '.ft-reply-form .ft-textarea',
      )
      textarea?.focus()
    })
  }

  private closeReply(): void {
    // 关闭回复时若掩膜正对回复打开，先取消掩膜并丢弃 pending 提交。
    if (this.captchaMaskKey === 'reply') {
      this.cancelCaptchaMask()
    }
    if (this.owoOpenKey === 'reply') {
      this.owoOpenKey = null
    }
    this.teardownCaptcha(this.composerKey(this.reply))
    this.reply = null
    this.requestUpdate()
  }

  // ---- Retry from recoverable auth states -----------------------------------

  private async retryPending(): Promise<void> {
    const action = this.state.pendingAction
    if (!action) {
      this.state = widgetReducer(this.state, { type: 'pending/clear' })
      this.requestUpdate()
      return
    }
    if (!this.authenticatedSessionValid) {
      // Every pending write needs a valid authenticated widget session: the
      // popup -> exchange -> probe flow covers authenticated-mode creates and
      // deletes as well as the anonymous administrator-email retry.
      const ok = await this.ensureAuthenticated(action)
      if (!ok) return
    }
    await this.performPendingAction(action)
  }

  private async performPendingAction(action: PendingAction): Promise<void> {
    this.state = widgetReducer(this.state, { type: 'pending/clear' })
    this.requestUpdate()
    if (action.type === 'create') {
      const replyComposer = action.parentId !== undefined ? this.reply : null
      const composer = replyComposer !== null ? replyComposer : this.root
      composer.comment = action.captchaToken
      composer.body = action.body
      composer.error = ''
      // 授权已完成，走到提交前一刻：若策略需要验证码且无 token，先拉起掩膜。
      await this.commentWithCaptchaGate(action, composer)
    } else {
      await this.deleteComment(action.commentId)
    }
  }

  // ---- Rendering -------------------------------------------------------------

  private renderError(error: WidgetError): TemplateResult {
    return html`
      <div class="${WIDGET_ROOT}">
        <div class="${STATE_ERROR}" role="alert">
          <strong>无法加载评论</strong>
          <p class="ft-note ${NOTE_TEXT}">${error.message}</p>
          <button
            type="button"
            class="${DEFAULT_BUTTON}"
            @click=${() => this.boot()}
          >
            重试
          </button>
        </div>
      </div>
    `
  }

  private renderAuthBanner(phase: AuthPhase): TemplateResult | typeof nothing {
    const notice = AUTH_NOTICE[phase]
    if (phase === 'idle') return nothing
    const recoverable =
      phase === 'cancelled' ||
      phase === 'blocked' ||
      phase === 'closed' ||
      phase === 'expired' ||
      phase === 'unsupported'
    return html`
      <div
        class="ft-auth-banner border border-solid border-[#bfdbfe] bg-[#eff6ff] text-[#1e40af] p-3.5 rounded-(--furtalk-radius) mb-3 text-[13.5px]"
        role="status"
      >
        <strong class="block mb-0.5">${notice.title}</strong>
        <span class="ft-note text-inherit text-[13px]">${notice.detail}</span>
        ${
          recoverable
            ? html`<button
                type="button"
                class="${DEFAULT_BUTTON} mt-2"
                @click=${() => void this.retryPending()}
              >
                重试
              </button>`
            : nothing
        }
      </div>
    `
  }

  private renderProfile(): TemplateResult {
    const locked =
      this.mode === 'authenticated' && this.authenticatedSessionValid
    return html`
      <div class="ft-profile ${PROFILE_ROW}">
        <div class="ft-field grid min-w-0">
          <input
            id="ft-nickname"
            class="ft-input ${INPUT_TEXT} rounded-l-(--furtalk-radius) focus:bg-(--furtalk-bg)"
            type="text"
            autocomplete="nickname"
            maxlength="100"
            placeholder="昵称"
            aria-label="昵称"
            .value=${this.hints.nickname}
            ?disabled=${locked}
            @input=${(event: Event) =>
              this.onProfileInput(
                'nickname',
                (event.target as HTMLInputElement).value,
              )}
          />
        </div>
        <div class="ft-field grid min-w-0 ${FIELD_DIVIDER}">
          <input
            id="ft-email"
            class="ft-input ${INPUT_TEXT} focus:bg-(--furtalk-bg)"
            type="email"
            autocomplete="email"
            placeholder="邮箱"
            aria-label="邮箱"
            .value=${this.hints.email}
            ?disabled=${locked}
            @input=${(event: Event) =>
              this.onProfileInput(
                'email',
                (event.target as HTMLInputElement).value,
              )}
          />
        </div>
        <div class="ft-field grid min-w-0 ${FIELD_DIVIDER}">
          <input
            id="ft-website"
            class="ft-input ${INPUT_TEXT} rounded-r-(--furtalk-radius) focus:bg-(--furtalk-bg)"
            type="url"
            autocomplete="url"
            placeholder="网站（可选）"
            aria-label="网站（可选）"
            .value=${this.hints.website_url}
            ?disabled=${locked}
            @input=${(event: Event) =>
              this.onProfileInput(
                'website_url',
                (event.target as HTMLInputElement).value,
              )}
          />
        </div>
      </div>
    `
  }

  private renderComposerBody(
    composer: ComposerState,
    key: 'root' | 'reply',
  ): TemplateResult {
    const busy =
      this.state.status === 'creating' || this.state.status === 'deleting'
    const panelOpen = this.owoOpenKey === key
    return html`
      <textarea
        class="ft-textarea ${INPUT_TEXT} min-h-[90px] resize-y [border-bottom:1px_solid_var(--furtalk-border)] focus:outline-2 focus:outline-(--furtalk-accent) focus:outline-offset-1 text-[14px] leading-relaxed"
        data-composer=${key}
        placeholder="写下你的评论…"
        aria-label="评论内容"
        .value=${composer.body}
        @input=${(event: Event) => {
          composer.body = (event.target as HTMLTextAreaElement).value
          composer.error = ''
          this.requestUpdate()
        }}
      ></textarea>
      ${panelOpen ? this.renderOwoPanel(key) : nothing}
      ${
        composer.error
          ? html`<p
              class="ft-error-text m-0 mt-1 text-(--furtalk-danger) text-[13px]"
              role="alert"
            >
              ${composer.error}
            </p>`
          : nothing
      }
      ${
        busy
          ? html`<p class="ft-note ${NOTE_TEXT}">
              ${this.state.status === 'creating' ? '正在发表…' : '正在处理…'}
            </p>`
          : nothing
      }
    `
  }

  /** Whether a remote expression catalog URL is configured; the picker is only
   *  offered when a deployer-supplied catalog is available. */
  private get hasOwoCatalog(): boolean {
    return (this.state.config?.owo_catalog_url ?? '').trim() !== ''
  }

  private renderOwoTrigger(
    key: 'root' | 'reply',
  ): TemplateResult | typeof nothing {
    if (!this.hasOwoCatalog) return nothing
    const panelOpen = this.owoOpenKey === key
    return html`
      <button
        type="button"
        class="ft-owo-trigger ${OWO_TRIGGER_BUTTON}"
        aria-label="表情"
        aria-expanded=${panelOpen}
        aria-controls="ft-owo-panel-${key}"
        @click=${() => this.toggleOwoPanel(key)}
      >
        <svg
          class="ft-owo-icon size-[18px]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10"></circle>
          <path d="M8 14s1.5 2 4 2 4-2 4-2"></path>
          <line x1="9" y1="9" x2="9.01" y2="9"></line>
          <line x1="15" y1="9" x2="15.01" y2="9"></line>
        </svg>
      </button>
    `
  }

  private toggleOwoPanel(key: 'root' | 'reply'): void {
    this.owoOpenKey = this.owoOpenKey === key ? null : key
    this.requestUpdate()
  }

  private closeOwoPanel(): void {
    this.owoOpenKey = null
    this.requestUpdate()
  }

  private renderOwoPanel(key: 'root' | 'reply'): TemplateResult {
    const groups = this.owoCatalog
    const activeTab =
      this.owoActiveTab &&
      groups.some((group) => group.id === this.owoActiveTab)
        ? this.owoActiveTab
        : (groups[0]?.id ?? '')
    const activeGroup =
      groups.find((group) => group.id === activeTab) ?? groups[0]
    return html`
      <div
        id="ft-owo-panel-${key}"
        class="ft-owo-panel absolute inset-x-0 top-full mt-2 z-20 rounded-(--furtalk-radius) p-3 grid gap-2.5 bg-(--furtalk-bg) border border-solid border-(--furtalk-border) shadow-[0_4px_20px_rgba(0,0,0,0.08)] max-h-80 overflow-y-auto"
        role="dialog"
        aria-modal="false"
        aria-label="选择表情"
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            this.closeOwoPanel()
          }
        }}
      >
        <div
          class="ft-owo-tabs flex gap-1.5 flex-wrap [border-bottom:1px_solid_var(--furtalk-border)] pb-2"
          role="tablist"
          aria-label="表情分类"
          @keydown=${(event: KeyboardEvent) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            const index = groups.findIndex((group) => group.id === activeTab)
            const direction = event.key === 'ArrowRight' ? 1 : -1
            const nextIndex =
              (index + direction + groups.length) % groups.length
            this.owoActiveTab = groups[nextIndex]?.id ?? ''
            this.requestUpdate()
          }}
        >
          ${groups.map(
            (group) => html`
              <button
                type="button"
                role="tab"
                class="ft-owo-tab ${OWO_TAB_BUTTON}"
                aria-selected=${group.id === activeTab}
                @click=${() => {
                  this.owoActiveTab = group.id
                  this.requestUpdate()
                }}
              >
                ${group.label}
              </button>
            `,
          )}
        </div>
        <div class="ft-owo-status">
          ${
            this.owoState === 'loading'
              ? html`<p class="ft-note ${NOTE_TEXT}">正在加载表情…</p>`
              : this.owoState === 'error'
                ? html`
                    <div class="ft-owo-msg grid gap-2 py-1" role="status">
                      <p class="ft-note m-0 ${NOTE_TEXT}">表情加载失败。</p>
                      <button
                        type="button"
                        class="ft-btn ${DEFAULT_BUTTON}"
                        @click=${() => this.retryCatalogLoad()}
                      >
                        重试
                      </button>
                    </div>
                  `
                : nothing
          }
        </div>
        ${
          activeGroup && activeGroup.items.length > 0
            ? html`
                <div class="ft-owo-grid flex flex-wrap gap-1.5" role="list">
                  ${activeGroup.items.map((item) => this.renderOwoItem(key, item))}
                </div>
              `
            : html`<p class="ft-note ${NOTE_TEXT}">该分类暂无表情。</p>`
        }
      </div>
    `
  }

  private renderOwoItem(
    key: 'root' | 'reply',
    item: EmojiItem,
  ): TemplateResult {
    const content =
      item.kind === 'image' && item.imageUrl
        ? html`<img
            class="ft-owo-image max-w-10 max-h-10 object-contain"
            src=${item.imageUrl}
            alt=""
            loading="lazy"
            decoding="async"
            referrerpolicy="no-referrer"
          />`
        : (item.display ?? item.insertion)
    return html`
      <button
        type="button"
        class="ft-owo-item ${OWO_ITEM_BUTTON}"
        aria-label=${item.label}
        title=${item.label}
        @click=${() => this.insertOwoItem(key, item)}
      >
        ${content}
      </button>
    `
  }

  // insertOwoItem 把选中表情插入到所属 composer 的 textarea 当前选区，
  // 替换选中文本、保留周边内容、更新对应草稿并恢复焦点与光标。
  private insertOwoItem(key: 'root' | 'reply', item: EmojiItem): void {
    const composer = key === 'reply' ? this.reply : this.root
    if (!composer) return
    const textarea = this.renderRoot.querySelector<HTMLTextAreaElement>(
      `textarea[data-composer="${key}"]`,
    )
    if (!textarea) return
    const start = textarea.selectionStart ?? composer.body.length
    const end = textarea.selectionEnd ?? start
    const result = insertAtSelection(composer.body, start, end, item.insertion)
    composer.body = result.next
    composer.error = ''
    this.closeOwoPanel()
    this.requestUpdate()
    void this.updateComplete.then(() => {
      textarea.focus()
      textarea.setSelectionRange(result.caret, result.caret)
    })
  }

  private renderRootComposer(): TemplateResult {
    if (this.threadClosed) {
      return html`<div
        class="ft-closed border border-solid border-(--furtalk-border) rounded-(--furtalk-radius) p-3 mb-4 text-(--furtalk-text-muted) text-[14px]"
      >
        评论区已关闭，仅可查看历史评论。
      </div>`
    }
    const busy =
      this.state.status === 'creating' || this.state.status === 'deleting'
    const submitDisabled = busy
    return html`
      <div
        class="ft-composer relative border border-solid border-(--furtalk-border) rounded-(--furtalk-radius) p-3 mb-4 grid gap-2.5 bg-(--furtalk-bg) shadow-2xs focus-within:border-(--furtalk-accent)/60 transition-colors"
      >
        ${this.renderProfile()} ${this.renderComposerBody(this.root, 'root')}
        <div class="ft-actions-row ${ACTIONS_ROW}">
          ${this.renderOwoTrigger('root')}
          <div class="ft-command-group flex flex-wrap items-center gap-2">
            ${
              this.mode === 'authenticated' && this.authenticatedSessionValid
                ? html`
                    <button
                      type="button"
                      class="ft-btn-danger ${DANGER_BUTTON}"
                      ?disabled=${busy}
                      @click=${() => this.handleLogout()}
                    >
                      退出登录
                    </button>
                  `
                : nothing
            }
            <button
              type="button"
              class="ft-btn-primary ${PRIMARY_BUTTON}"
              ?disabled=${submitDisabled}
              @click=${() => this.submitRoot()}
            >
              ${this.state.status === 'creating' ? '发表中…' : '发表评论'}
            </button>
          </div>
        </div>
      </div>
    `
  }

  // renderCaptchaMask 渲染 Shadow DOM 内的验证码掩膜层。
  // 掩膜只在某个 composer 需要验证码且没有有效 token 时出现，包含稳定的
  // 宿主容器、取消按钮与 pending action 文案；掩膜遮挡下方 Widget 交互。
  private renderCaptchaMask(): TemplateResult | typeof nothing {
    const key = this.captchaMaskKey
    if (!key) return nothing
    const composer = key === 'reply' ? this.reply : this.root
    const pendingLabel =
      key === 'reply' ? '完成验证后即可发布回复。' : '完成验证后即可发表评论。'
    return html`
      <div
        class="ft-captcha-mask fixed inset-0 z-[2147483647] bg-[rgba(17,24,39,0.45)] backdrop-blur-xs flex p-4 overflow-y-auto"
      >
        <div
          class="ft-captcha-mask-panel m-auto w-full max-w-[360px] bg-(--furtalk-bg) border border-solid border-(--furtalk-border) rounded-(--furtalk-radius) shadow-[0_10px_30px_rgba(0,0,0,0.15)] p-4.5 grid gap-3 outline-none"
          role="dialog"
          aria-modal="true"
          aria-label="人机验证"
          tabindex="-1"
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === 'Escape') this.cancelCaptchaMask()
          }}
        >
          <p class="ft-captcha-mask-title m-0 font-semibold">人机验证</p>
          <p class="ft-note ${NOTE_TEXT}">${pendingLabel}</p>
          <div
            class="ft-captcha-host flex min-h-[70px] items-center justify-start"
            data-captcha-host=${key}
          ></div>
          ${
            composer?.error
              ? html`<p
                  class="ft-error-text m-0 mt-1 text-(--furtalk-danger) text-[13px]"
                  role="alert"
                >
                  ${composer.error}
                </p>`
              : nothing
          }
          <div class="ft-captcha-mask-actions flex justify-end">
            <button
              type="button"
              class="${DEFAULT_BUTTON}"
              @click=${() => this.cancelCaptchaMask()}
            >
              取消
            </button>
          </div>
        </div>
      </div>
    `
  }

  private collectDescendants(node: CommentNode): CommentNode[] {
    const result: CommentNode[] = []
    const traverse = (current: CommentNode) => {
      for (const child of current.children) {
        result.push(child)
        traverse(child)
      }
    }
    traverse(node)
    return result
  }

  private renderCommentContent(
    node: CommentNode,
    session: WidgetSession | undefined,
    isRoot: boolean,
  ): TemplateResult {
    const deleted = node.status === 'deleted'
    const pending = node.status === 'pending'
    // 已删除占位文本保持普通转义文本；Markdown 渲染输出只在这里经
    // unsafeHTML 注入 DOM。renderMarkdown 是唯一输入源：markdown-it 已禁用
    // 原始 HTML 并限制链接目标，后端在存储前也拒绝 raw HTML 与不安全目标。
    const body = deleted
      ? '（该评论已被删除）'
      : unsafeHTML(renderMarkdown(node.body))
    const owned = isOwnedBy(node, session ?? null)
    const busy =
      this.state.status === 'creating' || this.state.status === 'deleting'
    const canReply =
      !this.threadClosed &&
      !deleted &&
      node.depth < (this.state.config?.max_reply_depth ?? 0)
    const replying = this.reply?.replyTargetId === node.id
    const confirming = this.deletingId === node.id
    const avatarClass = isRoot
      ? 'ft-avatar size-8 rounded-full align-middle shrink-0 mt-0.5 [border:1px_solid_var(--furtalk-border)] object-cover shadow-2xs'
      : 'ft-avatar size-7 rounded-full align-middle shrink-0 mt-0.5 [border:1px_solid_var(--furtalk-border)] object-cover'
    const authorClass = isRoot
      ? 'ft-author font-semibold text-(--furtalk-text) text-[14px]'
      : 'ft-author font-semibold text-(--furtalk-text) text-[13px]'
    const bodyClass = isRoot
      ? 'ft-body [word-break:break-word] text-[14px] leading-relaxed [&_p]:m-0 [&_p]:mb-2 [&_a]:text-(--furtalk-accent) [&_a]:underline-offset-2 [&_a]:hover:underline [&_img]:max-w-full [&_img]:h-auto [&_blockquote]:my-2 [&_blockquote]:py-1 [&_blockquote]:px-3 [&_blockquote]:[border-left:3px_solid_var(--furtalk-accent)] [&_blockquote]:bg-(--furtalk-bg-muted) [&_blockquote]:rounded-r-md [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:bg-(--furtalk-bg-muted) [&_code]:rounded-md [&_code]:text-xs [&_code]:font-mono'
      : 'ft-body [word-break:break-word] text-[13.5px] leading-relaxed [&_p]:m-0 [&_p]:mb-1.5 [&_a]:text-(--furtalk-accent) [&_a]:underline-offset-2 [&_a]:hover:underline [&_img]:max-w-full [&_img]:h-auto [&_blockquote]:my-2 [&_blockquote]:py-1 [&_blockquote]:px-3 [&_blockquote]:[border-left:3px_solid_var(--furtalk-accent)] [&_blockquote]:bg-(--furtalk-bg-muted) [&_blockquote]:rounded-r-md [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:bg-(--furtalk-bg-muted) [&_code]:rounded-md [&_code]:text-xs [&_code]:font-mono'

    return html`
      <img
        class="${avatarClass}"
        src=${node.avatar_url || ''}
        alt=""
        loading="lazy"
      />
      <div class="ft-content min-w-0 flex-1">
        <div
          class="ft-meta flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-(--furtalk-text-muted) mb-1"
        >
          <span class="${authorClass}">
            ${
              node.author_website
                ? html`
                    <a
                      class="text-(--furtalk-text) no-underline hover:text-(--furtalk-accent) transition-colors"
                      href=${node.author_website}
                      target="_blank"
                      rel="nofollow ugc noopener noreferrer"
                      >${node.author_nickname}</a
                    >
                  `
                : node.author_nickname
            }
          </span>
          ${
            node.author_role === 'admin'
              ? html`<span
                  class="ft-admin inline-block text-[11px] font-medium text-blue-700 bg-blue-100 dark:text-blue-300 dark:bg-blue-900/40 rounded-full px-2 py-0.5"
                  >管理员</span
                >`
              : nothing
          }
          ${
            pending
              ? html`<span
                  class="ft-pending inline-block text-[11px] font-medium text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/40 rounded-full px-2 py-0.5"
                  >待审核</span
                >`
              : nothing
          }
          ${
            node.parent_id
              ? html`
                  <span class="ft-reply-to text-xs text-(--furtalk-text-muted)">
                    ${
                      node.reply_to_nickname
                        ? html`回复 ${node.reply_to_nickname}`
                        : '回复 已注销用户'
                    }
                  </span>
                `
              : nothing
          }
          <time
            class="ft-time text-xs text-(--furtalk-text-muted)"
            datetime=${node.created_at}
          >
            ${formatRelativeTime(node.created_at)}
          </time>
        </div>
        <div
          class="${bodyClass} ${deleted ? 'ft-deleted text-(--furtalk-text-muted) italic' : ''}"
        >
          ${body}
        </div>
        ${
          canReply || owned
            ? html`
                <div
                  class="ft-actions mt-1 -ml-1.5 flex items-center gap-1 text-[13px]"
                >
                  ${
                    canReply
                      ? html`
                          <button
                            type="button"
                            class="${ACTION_BUTTON}"
                            ?disabled=${busy}
                            @click=${() => this.openReply(node.id)}
                          >
                            回复
                          </button>
                        `
                      : nothing
                  }
                  ${
                    owned && !deleted
                      ? html`
                          ${
                            confirming
                              ? html`
                                  <button
                                    type="button"
                                    class="ft-btn-danger ${ACTION_DANGER_BUTTON}"
                                    ?disabled=${busy}
                                    @click=${() => this.confirmDelete()}
                                  >
                                    确认删除
                                  </button>
                                  <button
                                    type="button"
                                    class="${ACTION_BUTTON}"
                                    ?disabled=${busy}
                                    @click=${() => this.cancelDelete()}
                                  >
                                    取消
                                  </button>
                                `
                              : html`
                                  <button
                                    type="button"
                                    class="ft-btn-danger ${ACTION_DANGER_BUTTON}"
                                    ?disabled=${busy}
                                    @click=${() => this.requestDelete(node.id)}
                                  >
                                    删除
                                  </button>
                                `
                          }
                        `
                      : nothing
                  }
                </div>
              `
            : nothing
        }
        ${
          replying && this.reply
            ? html`
                <div
                  class="ft-reply-form relative mt-2 p-3 border border-solid border-(--furtalk-border) rounded-(--furtalk-radius) grid gap-2 bg-(--furtalk-bg) shadow-2xs"
                >
                  ${this.renderComposerBody(this.reply, 'reply')}
                  <div class="ft-actions-row ${ACTIONS_ROW}">
                    ${this.renderOwoTrigger('reply')}
                    <div
                      class="ft-command-group flex flex-wrap items-center gap-2"
                    >
                      <button
                        type="button"
                        class="${DEFAULT_BUTTON}"
                        @click=${() => this.closeReply()}
                      >
                        取消回复
                      </button>
                      <button
                        type="button"
                        class="ft-btn-primary ${PRIMARY_BUTTON}"
                        ?disabled=${busy}
                        @click=${() => this.submitReply()}
                      >
                        回复
                      </button>
                    </div>
                  </div>
                </div>
              `
            : nothing
        }
      </div>
    `
  }

  private renderNode(
    node: CommentNode,
    session: WidgetSession | undefined,
  ): TemplateResult {
    const isRoot = !node.parent_id || node.depth === 0
    const descendants = this.collectDescendants(node)

    return html`
      <li class="ft-item flex flex-col py-3">
        <div class="flex items-start gap-3 w-full">
          ${this.renderCommentContent(node, session, isRoot)}
        </div>
        ${
          descendants.length > 0
            ? html`
                <ul
                  class="${CHILDREN_LIST} ml-11 [@media(max-width:480px)]:ml-0"
                >
                  ${descendants.map(
                    (descendant) => html`
                      <li class="ft-item flex items-start gap-2.5 py-1.5">
                        ${this.renderCommentContent(descendant, session, false)}
                      </li>
                    `,
                  )}
                </ul>
              `
            : nothing
        }
      </li>
    `
  }

  override updated(): void {
    this.syncCaptchas()
    this.syncMaskFocus()
    this.syncOwoFocus()
  }

  // syncOwoFocus 在表情面板打开时把焦点移入面板，
  // 关闭时把焦点还给触发 composer 的 textarea。
  private syncOwoFocus(): void {
    const key = this.owoOpenKey
    if (key === this.lastOwoOpenKey) return
    const previous = this.lastOwoOpenKey
    this.lastOwoOpenKey = key
    if (key) {
      const tab = this.renderRoot.querySelector<HTMLElement>(
        `#ft-owo-panel-${key} .ft-owo-tab[aria-selected="true"]`,
      )
      tab?.focus()
    } else if (previous) {
      const textarea = this.renderRoot.querySelector<HTMLTextAreaElement>(
        previous === 'reply'
          ? '.ft-reply-form .ft-textarea'
          : '.ft-composer .ft-textarea',
      )
      textarea?.focus()
    }
  }

  // syncMaskFocus 在掩膜打开时把焦点移入面板，关闭时把焦点还给触发 composer。
  private syncMaskFocus(): void {
    const key = this.captchaMaskKey
    if (key === this.lastMaskKey) return
    const previous = this.lastMaskKey
    this.lastMaskKey = key
    if (key) {
      const panel = this.renderRoot.querySelector<HTMLElement>(
        '.ft-captcha-mask-panel',
      )
      panel?.focus()
    } else if (previous) {
      const textarea = this.renderRoot.querySelector<HTMLTextAreaElement>(
        previous === 'reply'
          ? '.ft-reply-form .ft-textarea'
          : '.ft-composer .ft-textarea',
      )
      textarea?.focus()
    }
  }

  override render(): TemplateResult | typeof nothing {
    if (this.configError) {
      return html`
        <div class="${WIDGET_ROOT}">
          <div class="${STATE_ERROR}" role="alert">
            <strong>配置无效</strong>
            <p class="ft-note ${NOTE_TEXT}">${this.configError}</p>
          </div>
        </div>
      `
    }
    const { status, comments, thread, session, error, loadingMore } = this.state
    switch (status) {
      case 'boot':
      case 'loading-config':
      case 'loading-thread':
        return html`<div class="${WIDGET_ROOT}">
          <div class="${STATE_TEXT}">加载中…</div>
        </div>`
      case 'error':
        return error ? this.renderError(error) : nothing
      default:
        break
    }
    const tree = buildCommentTree(comments, this.state.sort)
    const authPhase = this.state.authPhase
    const notice = this.state.notice
    return html`
      <div class="${WIDGET_ROOT}">
        ${
          notice
            ? html`<div
                class="ft-success border border-solid border-[#bbf7d0] bg-[#f0fdf4] text-[#166534] p-3.5 rounded-(--furtalk-radius) mb-3 text-[13.5px]"
                role="status"
              >
                ${notice}
              </div>`
            : nothing
        }
        ${authPhase !== 'idle' ? this.renderAuthBanner(authPhase) : nothing}
        ${
          this.widgetNotice
            ? html`<div
                class="ft-closed border border-solid border-(--furtalk-border) rounded-(--furtalk-radius) p-3 mb-4 text-(--furtalk-text-muted) text-[14px]"
                role="status"
              >
                ${this.widgetNotice.text}
                ${
                  this.widgetNotice.reopenLogout
                    ? html`<button
                        type="button"
                        class="${DEFAULT_BUTTON}"
                        @click=${() => this.openLogoutPage()}
                      >
                        打开登出页
                      </button>`
                    : nothing
                }
              </div>`
            : nothing
        }
        ${this.renderRootComposer()}
        <div
          class="ft-sort flex flex-wrap items-center gap-1.5 mb-3.5"
          role="group"
          aria-label="评论排序"
        >
          <button
            type="button"
            class="${SORT_BUTTON}"
            data-sort="asc"
            aria-pressed=${this.state.sort === 'asc'}
            @click=${() => this.changeSort('asc')}
          >
            最早优先
          </button>
          <button
            type="button"
            class="${SORT_BUTTON}"
            data-sort="desc"
            aria-pressed=${this.state.sort === 'desc'}
            @click=${() => this.changeSort('desc')}
          >
            最新优先
          </button>
        </div>
        ${
          tree.length === 0
            ? html`<div class="${STATE_TEXT}">还没有评论，来抢沙发吧</div>`
            : html`
                <ul class="ft-list list-none m-0 p-0">
                  ${tree.map((node) => this.renderNode(node, session))}
                </ul>
              `
        }
        ${
          hasNextPage(thread)
            ? html`
                <div class="ft-loadmore flex mt-2">
                  <button
                    type="button"
                    class="${LOAD_MORE_BUTTON}"
                    ?disabled=${loadingMore}
                    @click=${() =>
                      this.state.nextCursor &&
                      void this.loadPage(this.state.nextCursor)}
                  >
                    ${loadingMore ? '加载中…' : '加载更多'}
                  </button>
                </div>
              `
            : nothing
        }
        ${this.renderCaptchaMask()}
      </div>
    `
  }

  private composeMessage(error: unknown): string {
    if (error instanceof WidgetError) return error.message
    if (error instanceof Error) return error.message
    return '操作失败，请稍后重试'
  }
}

export type { RuntimeConfig, WidgetState }
