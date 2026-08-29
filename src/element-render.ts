import { html, nothing, type TemplateResult } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'

import {
  buildCommentTree,
  hasNextPage,
  isOwnedBy,
  type CommentNode,
} from './comments'
import { ElementActions } from './element-actions'
import { AUTH_NOTICE, type ComposerState } from './element-model'
import {
  ACTIONS_ROW,
  ACTION_BUTTON,
  ACTION_DANGER_BUTTON,
  CHILDREN_LIST,
  DANGER_BUTTON,
  DEFAULT_BUTTON,
  EMOJI_ITEM_BUTTON,
  EMOJI_TAB_BUTTON,
  EMOJI_TRIGGER_BUTTON,
  FIELD_DIVIDER,
  INPUT_TEXT,
  LANG_MENU,
  LANG_MENU_ITEM,
  LANG_TRIGGER_BUTTON,
  LOAD_MORE_BUTTON,
  NOTE_TEXT,
  PRIMARY_BUTTON,
  PROFILE_ROW,
  SORT_BUTTON,
  STATE_ERROR,
  STATE_TEXT,
  WIDGET_ROOT,
} from './element-styles'
import { WidgetError } from './errors'
import type { EmojiItem } from './emoji'
import { renderCommentContent as renderCommentBody } from './emoji-renderer'
import {
  formatRelativeTime,
  LANGUAGE_LABELS,
  renderMessage,
  SUPPORTED_LANGUAGES,
} from './i18n'
import { insertAtSelection } from './insertion'
import type { AuthPhase } from './state'
import type { WidgetSession } from './types'

export class ElementRender extends ElementActions {
  // ---- 渲染 -------------------------------------------------------------

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

  /** 是否配置了远程表情包目录 URL；只有部署方提供了目录，才显示表情选择器。 */
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

  // insertEmojiItem 把选中的表情插入到所属编辑器的 textarea 当前选区：
  // 文本项插入原始内容，图片项插入 `:<id>:`；
  // 替换选中文本、保留周边内容、更新对应草稿并恢复焦点与光标。
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
   * 渲染排序栏尾部的控件组：可选入口链接（后台 / 我的评论），以及始终可见的
   * 语言切换按钮和菜单。
   * 匿名普通访客没有入口链接，但语言控件保持可见。
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
  // 掩膜只在某个编辑器需要验证码且没有有效 token 时出现，包含固定的验证码容器、
  // 取消按钮与待执行动作的说明；掩膜会遮挡下方 Widget 的交互。
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
   * 渲染已发布评论的点赞控件。计数始终可见。
   * 认证模式下每位读者都能看到交互按钮；匿名模式下只有有效的管理员会话有按钮，
   * 普通访客看到只读计数。
   * `aria-pressed` 加上无障碍标签描述状态，而不只依赖颜色。
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

  /** 渲染仅管理员可见的根评论置顶控件。 */
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
    // 已删除的占位文本保持普通转义文本；只有这里会通过 unsafeHTML
    // 把 Markdown 渲染结果插入 DOM。
    // renderCommentBody 是唯一渲染入口：markdown-it 已禁用原始 HTML 并限制链接地址，
    // 表情目录的图片 token 也只在这里展开。
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

  // syncEmojiFocus 在表情面板打开时把焦点移入面板，关闭时把焦点还给触发
  // 编辑器的 textarea。
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

  // syncMaskFocus 在掩膜打开时把焦点移入面板，关闭时把焦点还给触发编辑器。
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

  /** 把配置错误代码翻译成当前语言。 */
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
}
