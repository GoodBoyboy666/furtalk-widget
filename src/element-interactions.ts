import { html, nothing, type TemplateResult } from 'lit'

import { runAuthorizationFlow, type AuthorizationOutcome } from './auth'
import { mountCaptcha } from './captcha'
import { submissionNotice } from './comments'
import {
  COMMENT_CHILDREN_MAX_HEIGHT,
  COMMENT_CONTENT_MAX_HEIGHT,
  emptyComposer,
  isNeedAuthCodeResult,
  type ComposerState,
  type LimitedRegionKind,
} from './element-model'
import { ElementRuntime } from './element-runtime'
import {
  CHILDREN_COLLAPSED,
  CHILDREN_READ_MORE_OFFSET,
  CONTENT_COLLAPSED,
  READ_MORE_BUTTON,
} from './element-styles'
import { toWidgetError } from './errors'
import { localMessage, prefixMessage, type SupportedLanguage } from './i18n'
import { widgetReducer, type PendingAction } from './state'
import { saveLanguage } from './storage'
import type { CaptchaProjection, ProfileHints, WidgetSession } from './types'

export class ElementInteractions extends ElementRuntime {
  // ---- 语言菜单 ----------------------------------------------------

  protected toggleLanguageMenu(): void {
    this.setLanguageMenu(!this.languageMenuOpen)
  }

  /** 打开或关闭语言菜单，并处理好外部点击与焦点。 */
  protected setLanguageMenu(open: boolean): void {
    if (open === this.languageMenuOpen) return
    this.languageMenuOpen = open
    if (open) {
      this.languageMenuClose?.()
      const onPointerDown = (event: MouseEvent) => {
        const target = event.target as Node | null
        const control = this.renderRoot?.querySelector('.ft-lang')
        // 本组件 Shadow root 内派发的事件到达 document 时会被重定向到自定义元素宿主，
        // 因此检查 composed path，将语言项的点击仍判定为控件内部；
        // 对不冒泡的事件和旧的事件实现，以 target/contains 判断作为回退。
        const path = event.composedPath()
        const isInside = control
          ? path.length > 0
            ? path.includes(control)
            : Boolean(target && control.contains(target))
          : false
        if (control && !isInside) {
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

  protected focusLanguageTrigger(): void {
    requestAnimationFrame(() => {
      this.renderRoot?.querySelector<HTMLElement>('.ft-lang-trigger')?.focus()
    })
  }

  protected moveLanguageFocus(direction: 1 | -1): void {
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

  protected selectLanguage(language: SupportedLanguage): void {
    if (language !== this.language) {
      this.language = language
      saveLanguage(language)
      this.requestUpdate()
    }
    this.setLanguageMenu(false)
    this.focusLanguageTrigger()
  }

  // ---- 资料 ---------------------------------------------------------

  protected saveProfile(): void {
    const normalized = this.normalizedHints
    this.hints = { ...normalized }
    this.store?.save(this.hints)
    this.requestUpdate()
  }

  protected onProfileInput(field: keyof ProfileHints, value: string): void {
    this.hints = { ...this.hints, [field]: value }
    this.requestUpdate()
  }

  // ---- CAPTCHA -------------------------------------------------------

  protected commentCaptchaProjection(): CaptchaProjection | undefined {
    return this.state.config?.captcha?.comment
  }

  protected isCommentCaptchaRequired(): boolean {
    return Boolean(this.commentCaptchaProjection()?.required)
  }

  /** 每个编辑器固定的验证码容器标识（目前只有 `comment` 一种动作）。 */
  protected composerKey(composer: ComposerState | null): 'root' | 'reply' {
    return composer?.replyTargetId ? 'reply' : 'root'
  }

  /** 渲染后把验证码组件挂载到各自的容器里。 */
  protected syncCaptchas(): void {
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
    // 清理不再渲染的容器（包括已挂载和已失败的）。
    for (const key of [...this.captchaMounted, ...this.captchaFailed]) {
      if (!seen.has(key)) this.teardownCaptcha(key)
    }
  }

  protected teardownCaptcha(key: string): void {
    const wasMounted = this.captchaMounted.delete(key)
    const wasFailed = this.captchaFailed.delete(key)
    if (!wasMounted && !wasFailed) return
    const handle = this.captchaHandles.get(key)
    if (handle) {
      try {
        handle.reset()
      } catch {
        // 忽略清理期间的重置失败。
      }
      this.captchaHandles.delete(key)
    }
    // 清空容器，避免在同一容器里重复渲染验证码组件。
    const host = this.renderRoot?.querySelector<HTMLElement>(
      `[data-captcha-host="${key}"]`,
    )
    if (host) host.replaceChildren()
  }

  protected async mountOneCaptcha(
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
      // 掩膜内完成验证：写入 token 后，挂起的提交只恢复执行一次。
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
        // 策略要求验证码，但没有可用的验证码服务（或脚本加载失败）。
        // 最终以服务端为准；在掩膜内展示可恢复的错误。
        this.captchaFailed.add(key)
        composer.error = localMessage('validate.captchaUnavailable')
        this.requestUpdate()
      }
    }
  }

  // ---- CAPTCHA 掩膜 ---------------------------------------------

  /**
   * 为某个编辑器打开 Shadow DOM 内的验证码掩膜，并保存一次性恢复回调。
   * 挂起的提交只在收到非空 token 后执行；取消、关闭回复与失败都会丢弃该回调。
   */
  protected openCaptchaMask(key: 'root' | 'reply', resume: () => void): void {
    this.captchaFailed.delete(key)
    this.captchaMaskKey = key
    this.pendingMaskedSubmit = resume
    this.requestUpdate()
  }

  /** 把保存的挂起提交执行一次，然后关闭掩膜。 */
  protected resumeMaskedSubmit(): void {
    const resume = this.pendingMaskedSubmit
    this.pendingMaskedSubmit = null
    this.captchaMaskKey = null
    this.requestUpdate()
    resume?.()
  }

  /** 取消打开的掩膜：丢弃挂起的提交，并清理验证码容器。 */
  protected cancelCaptchaMask(): void {
    if (!this.captchaMaskKey) return
    const key = this.captchaMaskKey
    this.pendingMaskedSubmit = null
    this.captchaMaskKey = null
    this.teardownCaptcha(key)
    this.requestUpdate()
  }

  // ---- 长区域测量 --------------------------------------------------

  /** 给不支持 ResizeObserver 的浏览器提供基于事件的测量方案。 */
  protected override setupRegionMeasurementFallback(): void {
    if (this.regionFallbackCleanup) return

    const onResourceLoad = (): void => {
      this.syncLimitedRegions()
    }
    const onWindowResize = (): void => {
      this.syncLimitedRegions()
    }

    // `load` 事件不会从图片冒泡，故在 ShadowRoot 捕获阶段监听，
    // 使支持 ResizeObserver 的浏览器也能在图片加载完成后重新测量。
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

  protected regionKey(kind: LimitedRegionKind, commentId: string): string {
    return `${kind}:${commentId}`
  }

  protected regionLimit(kind: LimitedRegionKind): number {
    return kind === 'content'
      ? COMMENT_CONTENT_MAX_HEIGHT
      : COMMENT_CHILDREN_MAX_HEIGHT
  }

  protected regionId(kind: LimitedRegionKind, commentId: string): string {
    return `ft-${kind}-region-${encodeURIComponent(commentId)}`
  }

  protected regionTargetInfo(
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

  /** 返回自然内容高度，与任何外部 max-height 无关。 */
  protected naturalRegionHeight(target: HTMLElement): number {
    const rectHeight = target.getBoundingClientRect().height
    return Math.max(target.scrollHeight, target.offsetHeight, rectHeight)
  }

  /** 做一次溢出判断，并返回判断结果是否有变化。 */
  protected updateRegionOverflow(
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

  /** 测量当前所有区域，并只用一个 ResizeObserver 实例来监听。 */
  protected syncLimitedRegions(): void {
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
    // 被排序、删除或分页移除的条目，不能残留溢出标记，
    // 以免之后同一条评论再次出现时状态错乱。
    for (const key of [...this.overflowingRegions]) {
      if (!seenKeys.has(key)) {
        this.overflowingRegions.delete(key)
        changed = true
      }
    }
    this.syncRegionResizeObserver(targets)
    if (changed) this.requestUpdate()
  }

  protected syncRegionResizeObserver(targets: HTMLElement[]): void {
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

  protected handleRegionResize(entries: ResizeObserverEntry[]): void {
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

  protected isRegionOverflowing(
    kind: LimitedRegionKind,
    commentId: string,
  ): boolean {
    return this.overflowingRegions.has(this.regionKey(kind, commentId))
  }

  protected isRegionExpanded(
    kind: LimitedRegionKind,
    commentId: string,
  ): boolean {
    return this.expandedRegions.has(this.regionKey(kind, commentId))
  }

  protected expandRegion(kind: LimitedRegionKind, commentId: string): void {
    const key = this.regionKey(kind, commentId)
    if (this.expandedRegions.has(key)) return
    this.expandedRegions.add(key)
    this.requestUpdate()
  }

  /** 评论正文和根回复区域共用的折叠渲染方法（外层限高、内层承载内容）。 */
  protected renderLimitedRegion(
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

  // ---- 评论创建 -----------------------------------------------------

  protected submitRoot(): void {
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

  protected submitReply(): void {
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
   * 在任何请求发出前校验必填的作者信息。
   * 统一创建接口要求昵称且以服务端为准，但空值或无效值绝不静默提交。
   */
  protected validateAttribution(composer: ComposerState): boolean {
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

  protected async createComment(composer: ComposerState): Promise<void> {
    if (!this.api || !this.config) return
    if (!this.validateAttribution(composer)) return
    const action: PendingAction = {
      type: 'create',
      parentId: composer.replyTargetId ?? undefined,
      body: composer.body,
      captchaToken: composer.comment,
    }
    if (this.mode === 'anonymous') {
      // 匿名模式是直接的一次请求提交：普通访客不需要会话、资料更新或预检。
      // 管理员邮箱会从创建端点收到 need_auth_code，转而执行弹窗授权流程并重试同一评论。
      this.saveProfile()
      await this.commentWithCaptchaGate(action, composer)
      return
    }
    // 认证模式：先将登录提示保存到本地，并确保会话在验证码之前有效，
    // 使掩膜只在提交时出现，而非在授权弹窗之前。
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
   * 提交时的验证码检查。评论策略要求验证码且编辑器尚无 token 时，打开掩膜，
   * 待 token 就绪后再提交；否则直接提交。
   * 恢复回调以新 token 重建请求，使请求始终携带刚验证通过的值。
   */
  protected async commentWithCaptchaGate(
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

  protected async ensureAuthenticated(action: PendingAction): Promise<boolean> {
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
      // 交换成功但分区 cookie 未生效。
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

  /** 打开授权弹窗并把结果记录到状态中。 */
  protected runAuthorization(): Promise<AuthorizationOutcome> {
    if (!this.config) return Promise.resolve({ status: 'blocked' })
    this.state = widgetReducer(this.state, { type: 'auth/opening' })
    this.requestUpdate()
    return runAuthorizationFlow({
      furtalkOrigin: this.config.serviceOrigin,
      siteId: this.config.siteId,
      hints: this.normalizedHints,
    }).then((outcome) => {
      if (outcome.status === 'success') {
        // 弹窗确认批准后立即进入 exchanging，使代码交换期间横幅不会停留在“opening”。
        this.state = widgetReducer(this.state, { type: 'auth/exchanging' })
        this.requestUpdate()
      } else {
        this.state = widgetReducer(this.state, this.outcomeToAction(outcome))
        this.requestUpdate()
      }
      return outcome
    })
  }

  protected outcomeToAction(
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
        // 成功的情况由调用方在交换代码后处理。
        return { type: 'auth/closed' }
    }
  }

  // ---- 双层退出登录 -----------------------------------------------

  /**
   * 退出认证 widget 会话与第一方账号。两个动作在同一个用户操作中启动：
   * widget 会话 DELETE 会清除该站点分区的 CHIPS cookie，而同步打开的新标签页
   * 运行第一方 /logout 页面。
   * 两个会话处于不同的 cookie 上下文，结果互不影响；widget 只反映自身会话的结果。
   */
  protected handleLogout(): void {
    if (this.mode !== 'authenticated' || !this.authenticatedSessionValid) return
    this.widgetNotice = null
    this.requestUpdate()
    void this.clearWidgetSession()
    this.openLogoutPage()
  }

  /** 清除 CHIPS widget 会话，成功后允许编辑资料字段。 */
  protected async clearWidgetSession(): Promise<void> {
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

  /** 在同一个用户操作中，在新标签页里打开第一方 /logout 页面。 */
  protected openLogoutPage(): void {
    const origin = this.config?.serviceOrigin
    if (!origin) return
    let opened = false
    try {
      opened = window.open(`${origin}/logout`, '_blank', '') !== null
    } catch {
      opened = false
    }
    if (!opened) {
      // widget 会话仍由自己的请求清除；此时告知用户第一方账号仍处于登录状态，
      // 并给出手动操作入口。
      this.widgetNotice = {
        text: localMessage('notice.logoutBlocked'),
        reopenLogout: true,
      }
      this.requestUpdate()
    }
  }

  protected async performCreate(
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
        // 该邮箱对应管理员但缺少有效的 widget 凭据：先执行第一方
        // popup -> exchange -> probe 流程，再重试同一条评论。
        // 该分支发生在验证码校验之前，token 尚未使用，策略要求时可复用。
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
      // 成功文案取决于评论状态：pending 表示等待审核，published 表示已上线。
      // 其他状态不显示成功提示（失败从不显示成功）。
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
        // widget 会话在探测与写入之间过期：将会话标记为失效，并展示可恢复的过期状态；
        // 重试时重新执行弹窗授权，然后再创建。
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

  /** 把会话标记为过期，并记录这次要执行的动作，供重试使用。 */
  protected handleSessionExpired(action: PendingAction): void {
    this.state = widgetReducer(this.state, {
      type: 'session/probed',
      session: { valid: false },
    })
    this.state = widgetReducer(this.state, { type: 'pending/set', action })
    this.state = widgetReducer(this.state, { type: 'auth/expired' })
    this.requestUpdate()
  }
}
