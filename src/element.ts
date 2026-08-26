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
import type { ConfigError, WidgetConfig } from './config'
import { parseWidgetConfig } from './config'
import { toWidgetError, WidgetError } from './errors'
import { loadEmojiCatalog, type EmojiCatalog, type EmojiItem } from './emoji'
import { renderCommentContent as renderCommentBody } from './emoji-renderer'
import {
  formatRelativeTime,
  LANGUAGE_LABELS,
  localMessage,
  prefixMessage,
  rawMessage,
  renderMessage,
  resolveLanguage,
  SUPPORTED_LANGUAGES,
  translate,
  type DisplayMessage,
  type SupportedLanguage,
  type TranslationKey,
} from './i18n'
import { insertAtSelection } from './insertion'
import { validateProfileHints } from './profile'
import {
  initialState,
  widgetReducer,
  type AuthPhase,
  type PendingAction,
  type WidgetState,
} from './state'
import {
  createProfileStore,
  loadLanguage,
  saveLanguage,
  type ProfileStore,
} from './storage'
import type {
  CaptchaProjection,
  Comment,
  CommentSort,
  ProfileHints,
  RuntimeConfig,
  WidgetSession,
} from './types'

export { formatRelativeTime } from './i18n'

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
  /** Render-time display descriptor; `''` means no error is shown. */
  error: DisplayMessage | ''
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

const AUTH_NOTICE: Record<
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
  'ft-children list-none m-0 mt-3 pl-3.5 [border-left:2px_solid_var(--furtalk-border)] flex flex-col gap-2 [@media(max-width:480px)]:pl-2.5'

/** Natural-height limits for the two independently collapsible regions. */
const COMMENT_CONTENT_MAX_HEIGHT = 300
const COMMENT_CHILDREN_MAX_HEIGHT = 400

/** Complete Tailwind candidates for the collapsed outer region wrappers. */
const CONTENT_COLLAPSED = 'max-h-[300px] overflow-hidden'
const CHILDREN_COLLAPSED = 'max-h-[400px] overflow-hidden'

/** Shared button chrome (sizing, focus ring); color/background are per kind. */
const BASE_BUTTON =
  'border border-solid rounded-(--furtalk-radius) px-3.5 py-1.5 cursor-pointer [font:inherit] text-[13px] font-medium leading-5 transition-all duration-150 disabled:opacity-50 disabled:cursor-default focus-visible:outline-2 focus-visible:outline-(--furtalk-accent) focus-visible:outline-offset-1'

/** Default button: bordered, muted background, inherits the theme text. */
const DEFAULT_BUTTON =
  BASE_BUTTON +
  ' border-(--furtalk-border) bg-(--furtalk-bg) text-(--furtalk-text-muted) hover:text-(--furtalk-text) hover:bg-(--furtalk-bg-muted) active:scale-[0.98] shadow-2xs'

/** Shared presentation for the one-way expansion control. */
const READ_MORE_BUTTON =
  DEFAULT_BUTTON +
  ' ft-read-more mt-2 text-(--furtalk-accent) border-(--furtalk-border) bg-(--furtalk-bg) hover:bg-(--furtalk-bg-muted)'

/** Keeps the subtree control aligned with the existing flattened reply list. */
const CHILDREN_READ_MORE_OFFSET = 'ml-11 [@media(max-width:480px)]:ml-0'

/** Primary action button: accent fill with white text. */
const PRIMARY_BUTTON =
  BASE_BUTTON +
  ' border-(--furtalk-accent) bg-(--furtalk-accent) text-white hover:bg-(--furtalk-accent)/90 active:scale-[0.98] shadow-2xs'

/** Borderless/transparent chrome for ghost buttons. */
const GHOST_BUTTON =
  'border-0 bg-transparent rounded-(--furtalk-radius) cursor-pointer [font:inherit] font-medium transition-all duration-150 disabled:opacity-50 disabled:cursor-default focus-visible:outline-2 focus-visible:outline-(--furtalk-accent) focus-visible:outline-offset-1'

/** Danger chrome (red text, no border); sizing is added per context. */
const DANGER_CHROME =
  'border-0 bg-transparent text-(--furtalk-danger) rounded-(--furtalk-radius) cursor-pointer [font:inherit] font-medium transition-all duration-150 disabled:opacity-50 disabled:cursor-default enabled:hover:bg-(--furtalk-bg-muted) focus-visible:outline-2 focus-visible:outline-(--furtalk-accent) focus-visible:outline-offset-1'

/** Danger button outside the comment actions row (e.g. logout). */
const DANGER_BUTTON =
  GHOST_BUTTON +
  ' text-(--furtalk-text-muted) text-[13px] px-3 py-1.5 leading-5 enabled:hover:text-(--furtalk-danger) enabled:hover:bg-(--furtalk-bg-muted) active:scale-[0.98]'

/** Danger button inside the comment actions row (compact size). */
const ACTION_DANGER_BUTTON = DANGER_CHROME + ' text-[12px] px-1.5 py-0.5'

/** Comment list action buttons (回复 / 取消). */
const ACTION_BUTTON =
  GHOST_BUTTON +
  ' text-(--furtalk-text-muted) text-[12px] px-1.5 py-0.5 rounded-md enabled:hover:bg-(--furtalk-bg-muted) enabled:hover:text-(--furtalk-text)'

/** Sort control buttons within the segmented bar; pressed state gets active tab style. */
const SORT_BUTTON =
  'border-0 bg-transparent text-(--furtalk-text-muted) text-[12px] px-2.5 py-1 rounded-[calc(var(--furtalk-radius)-2px)] cursor-pointer [font:inherit] font-medium transition-all duration-150 hover:text-(--furtalk-text) aria-pressed:bg-(--furtalk-bg) aria-pressed:text-(--furtalk-accent) aria-pressed:font-semibold aria-pressed:shadow-2xs focus-visible:outline-2 focus-visible:outline-(--furtalk-accent) focus-visible:outline-offset-1'

/** Emoji category tab buttons; the selected tab switches to the accent fill. */
const EMOJI_TAB_BUTTON =
  GHOST_BUTTON +
  ' text-(--furtalk-text-muted) text-[12px] px-2.5 py-[4px] hover:bg-(--furtalk-bg-muted) hover:text-(--furtalk-text) aria-selected:bg-(--furtalk-accent) aria-selected:text-white aria-selected:font-medium'

/** Emoji item buttons. */
const EMOJI_ITEM_BUTTON =
  'inline-flex items-center justify-start min-h-8 max-w-full px-2 py-1 border-0 bg-transparent text-(--furtalk-text) text-[14px] leading-none whitespace-nowrap cursor-pointer [font:inherit] rounded-md transition-colors hover:bg-(--furtalk-bg)'

/** Emoji picker trigger button. */
const EMOJI_TRIGGER_BUTTON =
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
  '[font:inherit] border-0 rounded-none px-3 py-2 bg-(--furtalk-bg) text-(--furtalk-text) min-w-0 w-full outline-none focus:outline-none'

/** Root widget surface. */
const WIDGET_ROOT =
  'ft-widget bg-(--furtalk-bg) rounded-(--furtalk-radius) text-[15px]'

/** Icon-only language trigger beside the optional portal link. */
const LANG_TRIGGER_BUTTON =
  'ft-lang-trigger inline-flex items-center p-1.5 border-0 bg-transparent text-(--furtalk-text-muted) rounded-(--furtalk-radius) cursor-pointer [font:inherit] transition-colors hover:text-(--furtalk-text) hover:bg-(--furtalk-bg-muted) aria-expanded:text-(--furtalk-accent) aria-expanded:bg-(--furtalk-bg-muted) focus-visible:outline-2 focus-visible:outline-(--furtalk-accent) focus-visible:outline-offset-1'

/** Language menu panel anchored under the trigger. */
const LANG_MENU =
  'ft-lang-menu absolute right-0 top-full mt-1 z-20 min-w-[8rem] rounded-(--furtalk-radius) p-1 bg-(--furtalk-bg) border border-solid border-(--furtalk-border) shadow-[0_4px_20px_rgba(0,0,0,0.08)]'

/** Radio-style language menu item. */
const LANG_MENU_ITEM =
  'block w-full text-left px-3 py-1.5 border-0 bg-transparent text-(--furtalk-text) text-[13px] rounded-md cursor-pointer [font:inherit] hover:bg-(--furtalk-bg-muted) aria-checked:text-(--furtalk-accent) aria-checked:font-semibold focus-visible:outline-2 focus-visible:outline-(--furtalk-accent) focus-visible:outline-offset-1'

type LimitedRegionKind = 'content' | 'children'

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
  private configError: ConfigError | null = null
  private api: ApiClient | null = null
  private store: ProfileStore | null = null
  private booted = false

  /** Ephemeral per-region presentation state; neither set is persisted. */
  private overflowingRegions = new Set<string>()
  private expandedRegions = new Set<string>()
  private regionResizeObserver: ResizeObserver | null = null
  private observedRegionTargets = new Set<HTMLElement>()
  private regionFallbackCleanup: (() => void) | null = null

  private hints: ProfileHints = { email: '', nickname: '', website_url: '' }

  /** Active display language; resolved before the first render. */
  private language: SupportedLanguage = resolveLanguage(null, [])

  /** Whether the icon-triggered language menu is currently open. */
  private languageMenuOpen = false
  /** Removes the document-level outside-click listener while the menu is open. */
  private languageMenuClose: (() => void) | null = null

  /** Recoverable widget-level notice (logout failures and popup-block fallbacks). */
  private widgetNotice: {
    text: DisplayMessage
    reopenLogout?: boolean
  } | null = null

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

  /** Remote emoji-pack catalog used by the picker; empty until configured. */
  private emojiCatalog: EmojiCatalog | null = null
  /** Catalog load state; failures never block commenting. */
  private emojiState: 'idle' | 'loading' | 'ready' | 'error' = 'idle'
  /** Emoji panel currently open; one panel at a time. */
  private emojiOpenKey: 'root' | 'reply' | null = null
  /** Previous open key, used to restore focus to the triggering composer. */
  private lastEmojiOpenKey: 'root' | 'reply' | null = null
  /** Active category tab id within the emoji panel. */
  private emojiActiveTab = ''
  /** Pending catalog load identity; stale completions are ignored. */
  private emojiLoadToken = 0
  /** Aborts the in-flight catalog request on reboot/retry/disconnect. */
  private emojiAbort: AbortController | null = null

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
        // Best-effort teardown.
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

  /** Boots the widget: resolve language, parse config, load runtime config, thread and session. */
  boot(): void {
    // The initial locale is resolved before the first scheduled render so the
    // widget root carries the correct `lang` and every copy renders localized.
    // A stored preference wins, then the browser language list, then `en`.
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

  /** Loads runtime config then the first thread page. Exposed for retry. */
  async load(): Promise<void> {
    if (!this.api || !this.config) return
    this.state = widgetReducer(this.state, { type: 'config/loading' })
    this.requestUpdate()
    try {
      const config = await this.api.runtimeConfig(this.config.siteId)
      this.state = widgetReducer(this.state, { type: 'config/loaded', config })
      this.requestUpdate()
      this.startEmojiLoad(config)
      await this.loadPage()
      await this.probeSession()
    } catch (error) {
      this.fail(error)
    }
  }

  // startEmojiLoad 在运行时配置可用后独立启动远程表情目录加载。
  // 未配置 URL 时保持空目录（触发器隐藏）；失败不进入全局 fail 路径，
  // 错误只在选择器内提示并可重试。
  private startEmojiLoad(config: RuntimeConfig): void {
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

  private async loadEmojiToken(url: string, token: number): Promise<void> {
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
      // 目录失败非致命：保留空目录并展示重试，评论工作流不受影响。
      this.emojiState = 'error'
      this.requestUpdate()
    }
  }

  private retryEmojiLoad(): void {
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
   * Switches the thread ordering. A change discards the old cursor and
   * comments (via the `sort/change` reducer action) and reloads the first
   * page along the new ordering; subsequent load-more pages reuse the same
   * ordering. This is a per-instance temporary preference and never writes
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

  private get adminWidgetSessionValid(): boolean {
    return this.sessionValid && this.state.session?.role === 'admin'
  }

  private get normalizedHints(): ProfileHints {
    return validateProfileHints(this.hints)
  }

  /** Translates a key in the active locale. */
  private t(
    key: TranslationKey,
    params?: Record<string, string | number>,
  ): string {
    return translate(this.language, key, params)
  }

  // ---- Language menu ------------------------------------------------------

  private toggleLanguageMenu(): void {
    this.setLanguageMenu(!this.languageMenuOpen)
  }

  /** Opens or closes the language menu, wiring outside-click and focus. */
  private setLanguageMenu(open: boolean): void {
    if (open === this.languageMenuOpen) return
    this.languageMenuOpen = open
    if (open) {
      this.languageMenuClose?.()
      const onPointerDown = (event: MouseEvent) => {
        const target = event.target as Node | null
        const control = this.renderRoot?.querySelector('.ft-lang')
        if (control && target && !control.contains(target)) {
          this.setLanguageMenu(false)
          this.focusLanguageTrigger()
        }
      }
      document.addEventListener('mousedown', onPointerDown)
      this.languageMenuClose = () =>
        document.removeEventListener('mousedown', onPointerDown)
      this.requestUpdate()
      requestAnimationFrame(() => {
        this.renderRoot
          ?.querySelector<HTMLElement>('.ft-lang-menu [aria-checked="true"]')
          ?.focus()
      })
    } else {
      this.languageMenuClose?.()
      this.languageMenuClose = null
      this.requestUpdate()
    }
  }

  private focusLanguageTrigger(): void {
    requestAnimationFrame(() => {
      this.renderRoot?.querySelector<HTMLElement>('.ft-lang-trigger')?.focus()
    })
  }

  private moveLanguageFocus(direction: 1 | -1): void {
    const items = [
      ...this.renderRoot.querySelectorAll<HTMLElement>(
        '.ft-lang-menu [role="menuitemradio"]',
      ),
    ]
    if (items.length === 0) return
    const active = this.renderRoot.querySelector<HTMLElement>(
      '.ft-lang-menu [aria-checked="true"]',
    )
    const index = items.indexOf(active ?? items[0]!)
    const next = (index + direction + items.length) % items.length
    items[next]?.focus()
  }

  private selectLanguage(language: SupportedLanguage): void {
    if (language !== this.language) {
      this.language = language
      saveLanguage(language)
      this.requestUpdate()
    }
    this.setLanguageMenu(false)
    this.focusLanguageTrigger()
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
        composer.error = localMessage('validate.captchaUnavailable')
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

  // ---- Long-region measurement ------------------------------------------

  /** Installs event-driven measurement fallbacks for browsers without RO. */
  private setupRegionMeasurementFallback(): void {
    if (this.regionFallbackCleanup) return

    const onResourceLoad = (): void => {
      this.syncLimitedRegions()
    }
    const onWindowResize = (): void => {
      this.syncLimitedRegions()
    }

    // `load` does not bubble from images, so listen in the ShadowRoot capture
    // phase. This also gives ResizeObserver-enabled browsers a deterministic
    // correction as soon as a Markdown image has finished loading.
    this.renderRoot.addEventListener('load', onResourceLoad, true)
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', onWindowResize)
    }
    this.regionFallbackCleanup = () => {
      this.renderRoot.removeEventListener('load', onResourceLoad, true)
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', onWindowResize)
      }
    }
  }

  private regionKey(kind: LimitedRegionKind, commentId: string): string {
    return `${kind}:${commentId}`
  }

  private regionLimit(kind: LimitedRegionKind): number {
    return kind === 'content'
      ? COMMENT_CONTENT_MAX_HEIGHT
      : COMMENT_CHILDREN_MAX_HEIGHT
  }

  private regionId(kind: LimitedRegionKind, commentId: string): string {
    return `ft-${kind}-region-${encodeURIComponent(commentId)}`
  }

  private regionTargetInfo(
    target: Element,
  ): { kind: LimitedRegionKind; commentId: string } | null {
    const kind = target.getAttribute('data-region-kind')
    const commentId = target.getAttribute('data-comment-id')
    if (
      (kind !== 'content' && kind !== 'children') ||
      commentId === null ||
      commentId === ''
    ) {
      return null
    }
    return { kind, commentId }
  }

  /** Returns natural content height, independent of any outer max-height. */
  private naturalRegionHeight(target: HTMLElement): number {
    const rectHeight = target.getBoundingClientRect().height
    return Math.max(target.scrollHeight, target.offsetHeight, rectHeight)
  }

  /** Applies one overflow decision and reports whether the set changed. */
  private updateRegionOverflow(
    kind: LimitedRegionKind,
    commentId: string,
    height: number,
  ): boolean {
    const key = this.regionKey(kind, commentId)
    const next = height > this.regionLimit(kind)
    const previous = this.overflowingRegions.has(key)
    if (next === previous) return false
    if (next) {
      this.overflowingRegions.add(key)
    } else {
      this.overflowingRegions.delete(key)
    }
    return true
  }

  /** Measures all current regions and synchronizes the single RO instance. */
  private syncLimitedRegions(): void {
    const targets = [
      ...this.renderRoot.querySelectorAll<HTMLElement>(
        '.ft-region-measurement[data-region-kind][data-comment-id]',
      ),
    ]
    const seenKeys = new Set<string>()
    let changed = false
    for (const target of targets) {
      const info = this.regionTargetInfo(target)
      if (!info) continue
      const key = this.regionKey(info.kind, info.commentId)
      seenKeys.add(key)
      changed =
        this.updateRegionOverflow(
          info.kind,
          info.commentId,
          this.naturalRegionHeight(target),
        ) || changed
    }
    // An item removed by sorting, deletion, or pagination must not leave an
    // eligibility bit behind that could affect a later id reuse.
    for (const key of [...this.overflowingRegions]) {
      if (!seenKeys.has(key)) {
        this.overflowingRegions.delete(key)
        changed = true
      }
    }
    this.syncRegionResizeObserver(targets)
    if (changed) this.requestUpdate()
  }

  private syncRegionResizeObserver(targets: HTMLElement[]): void {
    if (typeof ResizeObserver === 'undefined') {
      this.regionResizeObserver?.disconnect()
      this.regionResizeObserver = null
      this.observedRegionTargets.clear()
      return
    }
    if (!this.regionResizeObserver) {
      this.regionResizeObserver = new ResizeObserver((entries) => {
        this.handleRegionResize(entries)
      })
    }

    const sameTargets =
      targets.length === this.observedRegionTargets.size &&
      targets.every((target) => this.observedRegionTargets.has(target))
    if (sameTargets) return

    this.regionResizeObserver.disconnect()
    this.observedRegionTargets = new Set(targets)
    for (const target of targets) {
      this.regionResizeObserver.observe(target)
    }
  }

  private handleRegionResize(entries: ResizeObserverEntry[]): void {
    if (!this.isConnected) return
    let changed = false
    for (const entry of entries) {
      const target = entry.target
      if (
        !(target instanceof HTMLElement) ||
        !this.renderRoot.contains(target)
      ) {
        continue
      }
      const info = this.regionTargetInfo(target)
      if (!info) continue
      changed =
        this.updateRegionOverflow(
          info.kind,
          info.commentId,
          this.naturalRegionHeight(target),
        ) || changed
    }
    if (changed) this.requestUpdate()
  }

  private isRegionOverflowing(
    kind: LimitedRegionKind,
    commentId: string,
  ): boolean {
    return this.overflowingRegions.has(this.regionKey(kind, commentId))
  }

  private isRegionExpanded(
    kind: LimitedRegionKind,
    commentId: string,
  ): boolean {
    return this.expandedRegions.has(this.regionKey(kind, commentId))
  }

  private expandRegion(kind: LimitedRegionKind, commentId: string): void {
    const key = this.regionKey(kind, commentId)
    if (this.expandedRegions.has(key)) return
    this.expandedRegions.add(key)
    this.requestUpdate()
  }

  /** Shared two-layer renderer for comment bodies and root reply regions. */
  private renderLimitedRegion(
    kind: LimitedRegionKind,
    commentId: string,
    content: unknown,
  ): TemplateResult {
    const regionId = this.regionId(kind, commentId)
    const overflowing = this.isRegionOverflowing(kind, commentId)
    const expanded = this.isRegionExpanded(kind, commentId)
    const collapsed = overflowing && !expanded
    const collapsedClass =
      kind === 'content' ? CONTENT_COLLAPSED : CHILDREN_COLLAPSED

    return html`
      <div
        id=${regionId}
        class="ft-region ${collapsed ? collapsedClass : ''}"
        data-region-kind=${kind}
        data-comment-id=${commentId}
      >
        <div
          class="ft-region-measurement flow-root"
          data-region-kind=${kind}
          data-comment-id=${commentId}
        >
          ${content}
        </div>
      </div>
      ${
        collapsed
          ? html`
              <button
                type="button"
                class="${READ_MORE_BUTTON} ${kind === 'children' ? CHILDREN_READ_MORE_OFFSET : ''}"
                aria-controls=${regionId}
                aria-expanded="false"
                @click=${() => this.expandRegion(kind, commentId)}
              >
                ${this.t('comment.readMore')}
              </button>
            `
          : nothing
      }
    `
  }

  // ---- Comment creation ---------------------------------------------------

  private submitRoot(): void {
    if (this.state.status === 'creating' || this.state.status === 'deleting') {
      return
    }
    if (this.captchaMaskKey === 'root') return
    if (this.root.body.trim() === '') {
      this.root.error = localMessage('validate.bodyEmpty')
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
      this.reply.error = localMessage('validate.replyEmpty')
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
      composer.error = localMessage('validate.email')
      this.requestUpdate()
      return false
    }
    if (!hints.nickname) {
      composer.error = localMessage('validate.nickname')
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
        text: prefixMessage('notice.logoutFailed', this.composeMessage(error)),
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
        text: localMessage('notice.logoutBlocked'),
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
      composer.error = localMessage('validate.captcha')
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
          composer.error = localMessage('validate.authNotEffective')
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
      const noticeKey = submissionNotice(created.status)
      this.state = widgetReducer(
        this.state,
        noticeKey
          ? { type: 'notice/set', notice: localMessage(noticeKey) }
          : { type: 'notice/clear' },
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
        composer.error = localMessage('validate.captcha')
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
      composer.error = this.composeMessage(error)
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
    if (this.emojiOpenKey === 'reply') {
      this.emojiOpenKey = null
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
    } else if (action.type === 'delete') {
      await this.deleteComment(action.commentId)
    } else {
      await this.performLike(action.commentId, action.like)
    }
  }

  // ---- Like --------------------------------------------------------------

  /**
   * Entry point for a Like toggle on a published comment. Repeat clicks on a
   * comment with an in-flight mutation are suppressed. In anonymous mode only
   * a valid administrator session may interact (ordinary visitors see the
   * read-only count). In authenticated mode a missing/expired session starts
   * the existing authorization popup and resumes exactly this Like.
   */
  private handleLike(commentId: string, like: boolean): void {
    if (!this.api || !this.config) return
    if (this.state.pendingLikeIds[commentId]) return
    if (this.mode === 'anonymous') {
      if (!this.authenticatedSessionValid) return
      void this.performLike(commentId, like)
      return
    }
    if (!this.authenticatedSessionValid) {
      const action: PendingAction = { type: 'like', commentId, like }
      void this.ensureAuthenticated(action).then((ok) => {
        if (ok) void this.performLike(commentId, like)
      })
      return
    }
    void this.performLike(commentId, like)
  }

  /**
   * Executes one Like add/remove against the authoritative endpoint. On
   * success the comment's count and viewer state are replaced with the
   * response; in a Hot view the page is reloaded from page one so the visible
   * ranking matches the new count. Authentication and request failures keep
   * the current list and surface the recoverable error.
   */
  private async performLike(commentId: string, like: boolean): Promise<void> {
    if (!this.api || !this.config) return
    if (this.state.pendingLikeIds[commentId]) return
    this.state = widgetReducer(this.state, {
      type: 'like/pending',
      commentId,
    })
    this.requestUpdate()
    try {
      const result = like
        ? await this.api.likeComment(this.config.siteId, commentId)
        : await this.api.unlikeComment(this.config.siteId, commentId)
      this.state = widgetReducer(this.state, {
        type: 'like/settled',
        commentId,
        result,
      })
      this.state = widgetReducer(this.state, { type: 'pending/clear' })
      this.requestUpdate()
      if (this.state.sort === 'hot') {
        await this.loadPage()
      }
    } catch (error) {
      this.state = widgetReducer(this.state, {
        type: 'like/error',
        commentId,
      })
      this.requestUpdate()
      const widgetError = toWidgetError(error)
      if (
        this.mode === 'authenticated' &&
        widgetError.code === 'unauthorized'
      ) {
        // The widget session expired between the probe and the write:
        // recover via the popup authorization flow before retrying the Like.
        this.handleSessionExpired({ type: 'like', commentId, like })
        return
      }
      this.widgetNotice = {
        text: prefixMessage('notice.likeFailed', this.composeMessage(error)),
      }
      this.requestUpdate()
    }
  }

  // ---- Pin ---------------------------------------------------------------

  /** Executes a root-comment pin toggle for an already-authorized administrator. */
  private handlePin(commentId: string, pinned: boolean): void {
    if (!this.api || !this.config || !this.adminWidgetSessionValid) return
    if (this.state.pendingPinIds?.[commentId]) return
    void this.performPin(commentId, pinned)
  }

  /** Updates the authoritative pin state and reloads the first page afterward. */
  private async performPin(commentId: string, pinned: boolean): Promise<void> {
    if (!this.api || !this.config || !this.adminWidgetSessionValid) return
    if (this.state.pendingPinIds?.[commentId]) return
    this.state = widgetReducer(this.state, {
      type: 'pin/pending',
      commentId,
    })
    this.requestUpdate()
    try {
      const result = pinned
        ? await this.api.pinComment(this.config.siteId, commentId)
        : await this.api.unpinComment(this.config.siteId, commentId)
      this.state = widgetReducer(this.state, {
        type: 'pin/settled',
        commentId,
        result,
      })
      this.widgetNotice = {
        text: localMessage(
          result.is_pinned ? 'notice.pinned' : 'notice.unpinned',
        ),
      }
      this.requestUpdate()
      await this.loadPage()
    } catch (error) {
      this.state = widgetReducer(this.state, {
        type: 'pin/error',
        commentId,
      })
      this.widgetNotice = {
        text: prefixMessage(
          pinned ? 'notice.pinFailed' : 'notice.unpinFailed',
          this.composeMessage(error),
        ),
      }
      this.requestUpdate()
    }
  }

  // ---- Rendering -------------------------------------------------------------

  private renderError(error: WidgetError): TemplateResult {
    return html`
      <div class="${WIDGET_ROOT}" lang=${this.language}>
        <div class="${STATE_ERROR}" role="alert">
          <strong>${this.t('config.error.loadComments')}</strong>
          <p class="ft-note ${NOTE_TEXT}">${error.message}</p>
          <button
            type="button"
            class="${DEFAULT_BUTTON}"
            @click=${() => this.boot()}
          >
            ${this.t('common.retry')}
          </button>
        </div>
      </div>
    `
  }

  private renderAuthBanner(phase: AuthPhase): TemplateResult | typeof nothing {
    if (phase === 'idle') return nothing
    const notice = AUTH_NOTICE[phase]
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
        <strong class="block mb-0.5">${this.t(notice.title)}</strong>
        <span class="ft-note text-inherit text-[13px]"
          >${this.t(notice.detail)}</span
        >
        ${
          recoverable
            ? html`<button
                type="button"
                class="${DEFAULT_BUTTON} mt-2"
                @click=${() => void this.retryPending()}
              >
                ${this.t('common.retry')}
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
            class="ft-input ${INPUT_TEXT} rounded-l-(--furtalk-radius) focus:bg-(--furtalk-bg) focus:outline-none focus:ring-0"
            type="text"
            autocomplete="nickname"
            maxlength="100"
            placeholder=${this.t('profile.nickname')}
            aria-label=${this.t('profile.nickname')}
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
            class="ft-input ${INPUT_TEXT} focus:bg-(--furtalk-bg) focus:outline-none focus:ring-0"
            type="email"
            autocomplete="email"
            placeholder=${this.t('profile.email')}
            aria-label=${this.t('profile.email')}
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
            class="ft-input ${INPUT_TEXT} rounded-r-(--furtalk-radius) focus:bg-(--furtalk-bg) focus:outline-none focus:ring-0"
            type="url"
            autocomplete="url"
            placeholder=${this.t('profile.website')}
            aria-label=${this.t('profile.website')}
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
    const panelOpen = this.emojiOpenKey === key
    return html`
      <textarea
        class="ft-textarea ${INPUT_TEXT} min-h-[90px] resize-y [border-bottom:1px_solid_var(--furtalk-border)] focus:outline-2 focus:outline-(--furtalk-accent) focus:outline-offset-1 text-[14px] leading-relaxed"
        data-composer=${key}
        placeholder=${this.t('composer.placeholder')}
        aria-label=${this.t('composer.ariaLabel')}
        .value=${composer.body}
        @input=${(event: Event) => {
          composer.body = (event.target as HTMLTextAreaElement).value
          composer.error = ''
          this.requestUpdate()
        }}
      ></textarea>
      ${panelOpen ? this.renderEmojiPanel(key) : nothing}
      ${
        composer.error
          ? html`<p
              class="ft-error-text m-0 mt-1 text-(--furtalk-danger) text-[13px]"
              role="alert"
            >
              ${renderMessage(composer.error, this.language)}
            </p>`
          : nothing
      }
      ${
        busy
          ? html`<p class="ft-note ${NOTE_TEXT}">
              ${
                this.state.status === 'creating'
                  ? this.t('composer.busyCreating')
                  : this.t('composer.busyProcessing')
              }
            </p>`
          : nothing
      }
    `
  }

  /** Whether a remote emoji-pack catalog URL is configured; the picker is only
   *  offered when a deployer-supplied catalog is available. */
  private get hasEmojiCatalog(): boolean {
    return (this.state.config?.emoji_catalog_url ?? '').trim() !== ''
  }

  private renderEmojiTrigger(
    key: 'root' | 'reply',
  ): TemplateResult | typeof nothing {
    if (!this.hasEmojiCatalog) return nothing
    const panelOpen = this.emojiOpenKey === key
    return html`
      <button
        type="button"
        class="ft-emoji-trigger ${EMOJI_TRIGGER_BUTTON}"
        aria-label=${this.t('emoji.trigger.aria')}
        aria-expanded=${panelOpen}
        aria-controls="ft-emoji-panel-${key}"
        @click=${() => this.toggleEmojiPanel(key)}
      >
        <svg
          class="ft-emoji-icon size-[18px]"
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

  private toggleEmojiPanel(key: 'root' | 'reply'): void {
    this.emojiOpenKey = this.emojiOpenKey === key ? null : key
    this.requestUpdate()
  }

  private closeEmojiPanel(): void {
    this.emojiOpenKey = null
    this.requestUpdate()
  }

  private renderEmojiPanel(key: 'root' | 'reply'): TemplateResult {
    const packs = this.emojiCatalog?.packs ?? []
    const activeTab =
      this.emojiActiveTab &&
      packs.some((pack) => pack.id === this.emojiActiveTab)
        ? this.emojiActiveTab
        : (packs[0]?.id ?? '')
    const activePack = packs.find((pack) => pack.id === activeTab) ?? packs[0]
    return html`
      <div
        id="ft-emoji-panel-${key}"
        class="ft-emoji-panel absolute inset-x-0 top-full mt-2 z-20 rounded-(--furtalk-radius) p-3 flex flex-col gap-2.5 bg-(--furtalk-bg) border border-solid border-(--furtalk-border) shadow-[0_4px_20px_rgba(0,0,0,0.08)] max-h-80"
        role="dialog"
        aria-modal="false"
        aria-label=${this.t('emoji.panel.aria')}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            this.closeEmojiPanel()
          }
        }}
      >
        <div
          class="ft-emoji-tabs flex gap-1.5 flex-wrap [border-bottom:1px_solid_var(--furtalk-border)] pb-2"
          role="tablist"
          aria-label=${this.t('emoji.tabs.aria')}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            const index = packs.findIndex((pack) => pack.id === activeTab)
            const direction = event.key === 'ArrowRight' ? 1 : -1
            const nextIndex = (index + direction + packs.length) % packs.length
            this.emojiActiveTab = packs[nextIndex]?.id ?? ''
            this.requestUpdate()
          }}
        >
          ${packs.map(
            (pack) => html`
              <button
                type="button"
                role="tab"
                class="ft-emoji-tab ${EMOJI_TAB_BUTTON}"
                aria-selected=${pack.id === activeTab}
                @click=${() => {
                  this.emojiActiveTab = pack.id
                  this.requestUpdate()
                }}
              >
                ${pack.name}
              </button>
            `,
          )}
        </div>
        <div class="ft-emoji-scroll min-h-0 overflow-y-auto grid gap-2.5">
          <div class="ft-emoji-status">
            ${
              this.emojiState === 'loading'
                ? html`<p class="ft-note ${NOTE_TEXT}">
                    ${this.t('emoji.loading')}
                  </p>`
                : this.emojiState === 'error'
                  ? html`
                      <div class="ft-emoji-msg grid gap-2 py-1" role="status">
                        <p class="ft-note m-0 ${NOTE_TEXT}">
                          ${this.t('emoji.loadFailed')}
                        </p>
                        <button
                          type="button"
                          class="ft-btn ${DEFAULT_BUTTON}"
                          @click=${() => this.retryEmojiLoad()}
                        >
                          ${this.t('common.retry')}
                        </button>
                      </div>
                    `
                  : nothing
            }
          </div>
          ${
            activePack && activePack.items.length > 0
              ? html`
                  <div class="ft-emoji-grid flex flex-wrap gap-1.5" role="list">
                    ${activePack.items.map((item) => this.renderEmojiItem(key, item))}
                  </div>
                `
              : html`<p class="ft-note ${NOTE_TEXT}">
                  ${this.t('emoji.emptyCategory')}
                </p>`
          }
        </div>
      </div>
    `
  }

  private renderEmojiItem(
    key: 'root' | 'reply',
    item: EmojiItem,
  ): TemplateResult {
    const content =
      item.kind === 'image'
        ? html`<img
            class="ft-emoji-image max-w-10 max-h-10 object-contain"
            src=${item.src}
            alt=""
            loading="lazy"
            decoding="async"
            referrerpolicy="no-referrer"
          />`
        : item.content
    return html`
      <button
        type="button"
        class="ft-emoji-item ${EMOJI_ITEM_BUTTON}"
        aria-label=${item.name}
        title=${item.name}
        @click=${() => this.insertEmojiItem(key, item)}
      >
        ${content}
      </button>
    `
  }

  // insertEmojiItem 把选中表情插入到所属 composer 的 textarea 当前选区：
  // 文本项插入原样 content，图片项插入 `:<id>:`；替换选中文本、保留周边
  // 内容、更新对应草稿并恢复焦点与光标。
  private insertEmojiItem(key: 'root' | 'reply', item: EmojiItem): void {
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
    this.closeEmojiPanel()
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
        ${this.t('thread.closed')}
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
          ${this.renderEmojiTrigger('root')}
          <div
            class="ft-command-group flex flex-wrap items-center gap-2 ml-auto [@media(max-width:480px)]:ml-0 [@media(max-width:480px)]:justify-end"
          >
            ${
              this.mode === 'authenticated' && this.authenticatedSessionValid
                ? html`
                    <button
                      type="button"
                      class="ft-btn-danger ${DANGER_BUTTON}"
                      ?disabled=${busy}
                      @click=${() => this.handleLogout()}
                    >
                      ${this.t('composer.logout')}
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
              ${
                this.state.status === 'creating'
                  ? this.t('composer.submitting')
                  : this.t('composer.submit')
              }
            </button>
          </div>
        </div>
      </div>
    `
  }

  /**
   * Renders the sort-bar trailing control group: the optional portal link
   * (admin / my-comments) followed by the always-present language trigger and
   * its menu. Anonymous ordinary visitors have no portal link but the
   * language control stays visible.
   */
  private renderTrailingControls(): TemplateResult {
    return html`
      <div class="ft-trailing-controls inline-flex items-center gap-1 ml-auto">
        ${this.renderPortalLink()}
        <div class="ft-lang relative">
          <button
            type="button"
            class="${LANG_TRIGGER_BUTTON}"
            aria-haspopup="menu"
            aria-expanded=${this.languageMenuOpen}
            aria-label=${this.t('lang.button.aria')}
            title=${this.t('lang.button.aria')}
            @click=${() => this.toggleLanguageMenu()}
            @keydown=${(event: KeyboardEvent) => {
              if (
                event.key === 'ArrowDown' ||
                event.key === 'Enter' ||
                event.key === ' '
              ) {
                event.preventDefault()
                this.setLanguageMenu(true)
              }
            }}
          >
            <svg
              class="ft-lang-icon size-[18px]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10"></circle>
              <path d="M2 12h20"></path>
              <path
                d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
              ></path>
            </svg>
          </button>
          ${
            this.languageMenuOpen
              ? html`
                  <div
                    class="${LANG_MENU}"
                    role="menu"
                    aria-label=${this.t('lang.menu.aria')}
                    @keydown=${(event: KeyboardEvent) => {
                      if (event.key === 'Escape') {
                        event.stopPropagation()
                        this.setLanguageMenu(false)
                        this.focusLanguageTrigger()
                      } else if (event.key === 'ArrowDown') {
                        event.preventDefault()
                        this.moveLanguageFocus(1)
                      } else if (event.key === 'ArrowUp') {
                        event.preventDefault()
                        this.moveLanguageFocus(-1)
                      }
                    }}
                  >
                    ${SUPPORTED_LANGUAGES.map(
                      (language) => html`
                        <button
                          type="button"
                          role="menuitemradio"
                          class="${LANG_MENU_ITEM}"
                          aria-checked=${language === this.language}
                          @click=${() => this.selectLanguage(language)}
                        >
                          ${LANGUAGE_LABELS[language]}
                        </button>
                      `,
                    )}
                  </div>
                `
              : nothing
          }
        </div>
      </div>
    `
  }

  private renderPortalLink(): TemplateResult | typeof nothing {
    const origin = (this.config?.serviceOrigin ?? '').trim()
    const isAdmin =
      this.state.session?.valid === true && this.state.session?.role === 'admin'

    if (isAdmin) {
      const href = origin ? `${origin}/admin` : '/admin'
      return html`
        <a
          class="ft-portal-link text-(--furtalk-text-muted) hover:text-(--furtalk-accent) text-[12px] no-underline hover:underline transition-colors"
          href=${href}
          target="_blank"
          rel="noreferrer noopener"
        >
          ${this.t('portal.admin')}
        </a>
      `
    }

    if (this.mode === 'authenticated') {
      const href = origin ? `${origin}/account/comments` : '/account/comments'
      return html`
        <a
          class="ft-portal-link text-(--furtalk-text-muted) hover:text-(--furtalk-accent) text-[12px] no-underline hover:underline transition-colors"
          href=${href}
          target="_blank"
          rel="noreferrer noopener"
        >
          ${this.t('portal.myComments')}
        </a>
      `
    }

    return nothing
  }

  // renderCaptchaMask 渲染 Shadow DOM 内的验证码掩膜层。
  // 掩膜只在某个 composer 需要验证码且没有有效 token 时出现，包含稳定的
  // 宿主容器、取消按钮与 pending action 文案；掩膜遮挡下方 Widget 交互。
  private renderCaptchaMask(): TemplateResult | typeof nothing {
    const key = this.captchaMaskKey
    if (!key) return nothing
    const composer = key === 'reply' ? this.reply : this.root
    const pendingLabel =
      key === 'reply'
        ? this.t('captcha.pending.reply')
        : this.t('captcha.pending.comment')
    return html`
      <div
        class="ft-captcha-mask fixed inset-0 z-[2147483647] bg-[rgba(17,24,39,0.45)] backdrop-blur-xs flex p-4 overflow-y-auto"
      >
        <div
          class="ft-captcha-mask-panel m-auto w-full max-w-[360px] bg-(--furtalk-bg) border border-solid border-(--furtalk-border) rounded-(--furtalk-radius) shadow-[0_10px_30px_rgba(0,0,0,0.15)] p-4.5 grid gap-3 outline-none"
          role="dialog"
          aria-modal="true"
          aria-label=${this.t('captcha.mask.title')}
          tabindex="-1"
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === 'Escape') this.cancelCaptchaMask()
          }}
        >
          <p class="ft-captcha-mask-title m-0 font-semibold">
            ${this.t('captcha.mask.title')}
          </p>
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
                  ${renderMessage(composer.error, this.language)}
                </p>`
              : nothing
          }
          <div class="ft-captcha-mask-actions flex justify-end">
            <button
              type="button"
              class="${DEFAULT_BUTTON}"
              @click=${() => this.cancelCaptchaMask()}
            >
              ${this.t('common.cancel')}
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

  /**
   * Renders the Like control for a published comment. The count is always
   * visible. An interactive button appears in authenticated mode for every
   * reader; in anonymous mode only a valid administrator session gets the
   * button, and ordinary visitors see a read-only count. `aria-pressed` plus
   * an accessible label describe the state without relying on color alone.
   */
  private renderLikeControl(node: CommentNode, busy: boolean): TemplateResult {
    const likePending = Boolean(this.state.pendingLikeIds[node.id])
    const count = node.like_count ?? 0
    const canLike =
      this.mode === 'authenticated' ||
      (this.mode === 'anonymous' && this.authenticatedSessionValid)
    if (!canLike) {
      return html`
        <span
          class="ft-like ft-like-count text-(--furtalk-text-muted) text-[12px] px-1.5"
        >
          ${this.t('like.count', { count })}
        </span>
      `
    }
    const liked = node.liked_by_me === true
    const label = liked ? this.t('like.unlike') : this.t('like.like')
    return html`
      <button
        type="button"
        class="ft-like ${ACTION_BUTTON}"
        aria-pressed=${liked}
        aria-label=${label}
        ?disabled=${busy || likePending}
        @click=${() => this.handleLike(node.id, !liked)}
      >
        <span class="ft-like-label">${label}</span>
        <span class="ft-like-count">${count}</span>
      </button>
    `
  }

  /** Renders the administrator-only pin control for a root comment. */
  private renderPinControl(
    node: CommentNode,
    busy: boolean,
    isRoot: boolean,
  ): TemplateResult | typeof nothing {
    const pinned = node.is_pinned === true
    if (
      !isRoot ||
      !this.adminWidgetSessionValid ||
      (!pinned && node.status !== 'published')
    ) {
      return nothing
    }
    const pending = Boolean(this.state.pendingPinIds?.[node.id])
    return html`
      <button
        type="button"
        class="${ACTION_BUTTON} ${pinned ? 'text-(--furtalk-accent)' : ''}"
        ?disabled=${busy || pending}
        aria-label=${pinned ? this.t('pin.unpin') : this.t('pin.pin')}
        @click=${() => this.handlePin(node.id, !pinned)}
      >
        ${
          pending
            ? this.t('common.processing')
            : pinned
              ? this.t('pin.unpin')
              : this.t('pin.pin')
        }
      </button>
    `
  }

  private renderCommentContent(
    node: CommentNode,
    session: WidgetSession | undefined,
    isRoot: boolean,
  ): TemplateResult {
    const deleted = node.status === 'deleted'
    const pending = node.status === 'pending'
    // 已删除占位文本保持普通转义文本；Markdown 渲染输出只在这里经
    // unsafeHTML 注入 DOM。renderCommentBody 是唯一输入源：markdown-it 已
    // 禁用原始 HTML 并限制链接目标，目录图片 token 也只经该边界展开。
    const body = deleted
      ? this.t('comment.deleted')
      : unsafeHTML(renderCommentBody(node.body, this.emojiCatalog))
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
      ? 'ft-body [word-break:break-word] text-[14px] leading-relaxed [&_p]:m-0 [&_p]:mb-2 [&_a]:text-(--furtalk-accent) [&_a]:underline-offset-2 [&_a]:hover:underline [&_img]:max-w-full [&_img]:h-auto [&_.ft-emoji-image]:max-w-[64px] [&_.ft-emoji-image]:h-auto [&_.ft-emoji-image]:align-middle [&_blockquote]:my-2 [&_blockquote]:py-1 [&_blockquote]:px-3 [&_blockquote]:[border-left:3px_solid_var(--furtalk-accent)] [&_blockquote]:bg-(--furtalk-bg-muted) [&_blockquote]:rounded-r-md [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:bg-(--furtalk-bg-muted) [&_code]:rounded-md [&_code]:text-xs [&_code]:font-mono'
      : 'ft-body [word-break:break-word] text-[13.5px] leading-relaxed [&_p]:m-0 [&_p]:mb-1.5 [&_a]:text-(--furtalk-accent) [&_a]:underline-offset-2 [&_a]:hover:underline [&_img]:max-w-full [&_img]:h-auto [&_.ft-emoji-image]:max-w-[64px] [&_.ft-emoji-image]:h-auto [&_.ft-emoji-image]:align-middle [&_blockquote]:my-2 [&_blockquote]:py-1 [&_blockquote]:px-3 [&_blockquote]:[border-left:3px_solid_var(--furtalk-accent)] [&_blockquote]:bg-(--furtalk-bg-muted) [&_blockquote]:rounded-r-md [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:bg-(--furtalk-bg-muted) [&_code]:rounded-md [&_code]:text-xs [&_code]:font-mono'

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
                  >${this.t('badge.admin')}</span
                >`
              : nothing
          }
          ${
            isRoot && node.is_pinned === true
              ? html`<span
                  class="ft-pinned inline-flex items-center gap-0.5 text-[11px] font-medium text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/40 rounded-full px-2 py-0.5"
                  aria-label=${this.t('badge.pinned')}
                  >📌 ${this.t('badge.pinned')}</span
                >`
              : nothing
          }
          ${
            pending
              ? html`<span
                  class="ft-pending inline-block text-[11px] font-medium text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/40 rounded-full px-2 py-0.5"
                  >${this.t('badge.pending')}</span
                >`
              : nothing
          }
          ${
            node.parent_id
              ? html`
                  <span class="ft-reply-to text-xs text-(--furtalk-text-muted)">
                    ${
                      node.reply_to_nickname
                        ? this.t('reply.to', {
                            nickname: node.reply_to_nickname,
                          })
                        : this.t('reply.toDeletedUser')
                    }
                  </span>
                `
              : nothing
          }
          <time
            class="ft-time text-xs text-(--furtalk-text-muted)"
            datetime=${node.created_at}
          >
            ${formatRelativeTime(node.created_at, this.language)}
          </time>
        </div>
        ${this.renderLimitedRegion(
          'content',
          node.id,
          html`<div
            class="${bodyClass} ${deleted ? 'ft-deleted text-(--furtalk-text-muted) italic' : ''}"
          >
            ${body}
          </div>`,
        )}
        ${
          !deleted || owned
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
                            ${this.t('reply.reply')}
                          </button>
                        `
                      : nothing
                  }
                  ${!deleted ? this.renderLikeControl(node, busy) : nothing}
                  ${this.renderPinControl(node, busy, isRoot)}
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
                                    ${this.t('delete.confirm')}
                                  </button>
                                  <button
                                    type="button"
                                    class="${ACTION_BUTTON}"
                                    ?disabled=${busy}
                                    @click=${() => this.cancelDelete()}
                                  >
                                    ${this.t('delete.cancel')}
                                  </button>
                                `
                              : html`
                                  <button
                                    type="button"
                                    class="ft-btn-danger ${ACTION_DANGER_BUTTON}"
                                    ?disabled=${busy}
                                    @click=${() => this.requestDelete(node.id)}
                                  >
                                    ${this.t('delete.delete')}
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
                    ${this.renderEmojiTrigger('reply')}
                    <div
                      class="ft-command-group flex flex-wrap items-center gap-2 ml-auto [@media(max-width:480px)]:ml-0 [@media(max-width:480px)]:justify-end"
                    >
                      <button
                        type="button"
                        class="${DEFAULT_BUTTON}"
                        @click=${() => this.closeReply()}
                      >
                        ${this.t('reply.cancelReply')}
                      </button>
                      <button
                        type="button"
                        class="ft-btn-primary ${PRIMARY_BUTTON}"
                        ?disabled=${busy}
                        @click=${() => this.submitReply()}
                      >
                        ${this.t('reply.reply')}
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
            ? this.renderLimitedRegion(
                'children',
                node.id,
                html`<ul
                  class="${CHILDREN_LIST} ml-11 [@media(max-width:480px)]:ml-0"
                >
                  ${descendants.map(
                    (descendant) => html`
                      <li class="ft-item flex items-start gap-2.5 py-1.5">
                        ${this.renderCommentContent(descendant, session, false)}
                      </li>
                    `,
                  )}
                </ul>`,
              )
            : nothing
        }
      </li>
    `
  }

  override updated(): void {
    this.syncCaptchas()
    this.syncMaskFocus()
    this.syncEmojiFocus()
    this.syncLimitedRegions()
  }

  // syncEmojiFocus 在表情面板打开时把焦点移入面板，
  // 关闭时把焦点还给触发 composer 的 textarea。
  private syncEmojiFocus(): void {
    const key = this.emojiOpenKey
    if (key === this.lastEmojiOpenKey) return
    const previous = this.lastEmojiOpenKey
    this.lastEmojiOpenKey = key
    if (key) {
      const tab = this.renderRoot.querySelector<HTMLElement>(
        `#ft-emoji-panel-${key} .ft-emoji-tab[aria-selected="true"]`,
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

  /** Translates a stable configuration-error code into the active locale. */
  private configErrorMessage(): string {
    const error = this.configError
    if (!error) return ''
    switch (error.code) {
      case 'invalid_site_id':
        return this.t('config.error.invalidSiteId')
      case 'missing_page_key':
        return this.t('config.error.missingPageKey')
      case 'page_key_too_long':
        return this.t('config.error.pageKeyTooLong', error.params)
      case 'invalid_service_origin':
        return this.t('config.error.invalidServiceOrigin')
    }
  }

  override render(): TemplateResult | typeof nothing {
    if (this.configError) {
      return html`
        <div class="${WIDGET_ROOT}" lang=${this.language}>
          <div class="${STATE_ERROR}" role="alert">
            <strong>${this.t('config.invalid')}</strong>
            <p class="ft-note ${NOTE_TEXT}">${this.configErrorMessage()}</p>
          </div>
        </div>
      `
    }
    const { status, comments, thread, session, error, loadingMore } = this.state
    switch (status) {
      case 'boot':
      case 'loading-config':
      case 'loading-thread':
        return html`<div class="${WIDGET_ROOT}" lang=${this.language}>
          <div class="${STATE_TEXT}">${this.t('state.loading')}</div>
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
      <div class="${WIDGET_ROOT}" lang=${this.language}>
        ${
          notice
            ? html`<div
                class="ft-success border border-solid border-[#bbf7d0] bg-[#f0fdf4] text-[#166534] p-3.5 rounded-(--furtalk-radius) mb-3 text-[13.5px]"
                role="status"
              >
                ${renderMessage(notice, this.language)}
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
                ${renderMessage(this.widgetNotice.text, this.language)}
                ${
                  this.widgetNotice.reopenLogout
                    ? html`<button
                        type="button"
                        class="${DEFAULT_BUTTON}"
                        @click=${() => this.openLogoutPage()}
                      >
                        ${this.t('notice.openLogoutPage')}
                      </button>`
                    : nothing
                }
              </div>`
            : nothing
        }
        ${this.renderRootComposer()}
        <div
          class="ft-sort flex flex-wrap items-center justify-between gap-2 mb-3.5"
          role="group"
          aria-label=${this.t('sort.aria')}
        >
          <div
            class="inline-flex items-center p-0.5 bg-(--furtalk-bg-muted) rounded-(--furtalk-radius) border border-solid border-(--furtalk-border)"
          >
            <button
              type="button"
              class="${SORT_BUTTON}"
              data-sort="asc"
              aria-pressed=${this.state.sort === 'asc'}
              @click=${() => this.changeSort('asc')}
            >
              ${this.t('sort.asc')}
            </button>
            <button
              type="button"
              class="${SORT_BUTTON}"
              data-sort="desc"
              aria-pressed=${this.state.sort === 'desc'}
              @click=${() => this.changeSort('desc')}
            >
              ${this.t('sort.desc')}
            </button>
            <button
              type="button"
              class="${SORT_BUTTON}"
              data-sort="hot"
              aria-pressed=${this.state.sort === 'hot'}
              @click=${() => this.changeSort('hot')}
            >
              ${this.t('sort.hot')}
            </button>
          </div>
          ${this.renderTrailingControls()}
        </div>
        ${
          this.state.loadingComments
            ? html`<div class="${STATE_TEXT}">${this.t('state.loading')}</div>`
            : tree.length === 0
              ? html`<div class="${STATE_TEXT}">${this.t('state.empty')}</div>`
              : html`
                  <ul class="ft-list list-none m-0 p-0">
                    ${tree.map((node) => this.renderNode(node, session))}
                  </ul>
                `
        }
        ${
          !this.state.loadingComments && hasNextPage(thread)
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
                    ${loadingMore ? this.t('state.loading') : this.t('state.loadMore')}
                  </button>
                </div>
              `
            : nothing
        }
        ${this.renderCaptchaMask()}
      </div>
    `
  }

  /** Builds a render-time display descriptor from an unknown error value. */
  private composeMessage(error: unknown): DisplayMessage {
    if (error instanceof Error && error.message)
      return rawMessage(error.message)
    return localMessage('common.operationFailed')
  }
}

export type { RuntimeConfig, WidgetState }
