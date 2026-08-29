import { emptyComposer } from './element-model'
import { ElementInteractions } from './element-interactions'
import { toWidgetError } from './errors'
import { localMessage, prefixMessage } from './i18n'
import { widgetReducer, type PendingAction } from './state'

export class ElementActions extends ElementInteractions {
  // ---- 删除 ---------------------------------------------------------

  protected requestDelete(commentId: string): void {
    if (this.state.status === 'creating' || this.state.status === 'deleting') {
      return
    }
    this.deletingId = commentId
    this.requestUpdate()
  }

  protected cancelDelete(): void {
    this.deletingId = null
    this.requestUpdate()
  }

  protected confirmDelete(): void {
    const commentId = this.deletingId
    if (!commentId) return
    this.deletingId = null
    void this.deleteComment(commentId)
  }

  protected async deleteComment(commentId: string): Promise<void> {
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
        // 会话在探测与删除之间过期：先经弹窗授权流程恢复，再重试删除。
        this.handleSessionExpired({ type: 'delete', commentId })
        return
      }
      this.fail(error)
    }
  }

  // ---- 回复编辑器 ----------------------------------------------------

  protected openReply(commentId: string): void {
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

  protected closeReply(): void {
    // 关闭回复时若掩膜正对回复打开，先取消掩膜并丢弃挂起的提交。
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

  // ---- 从可恢复认证状态重试 -------------------------------------

  protected async retryPending(): Promise<void> {
    const action = this.state.pendingAction
    if (!action) {
      this.state = widgetReducer(this.state, { type: 'pending/clear' })
      this.requestUpdate()
      return
    }
    if (!this.authenticatedSessionValid) {
      // 每个挂起写入都需要有效的认证 widget 会话：popup -> exchange -> probe 流程既覆盖认证模式的创建/删除，也覆盖匿名的管理员邮箱重试。
      const ok = await this.ensureAuthenticated(action)
      if (!ok) return
    }
    await this.performPendingAction(action)
  }

  protected async performPendingAction(action: PendingAction): Promise<void> {
    this.state = widgetReducer(this.state, { type: 'pending/clear' })
    this.requestUpdate()
    if (action.type === 'create') {
      const replyComposer = action.parentId !== undefined ? this.reply : null
      const composer = replyComposer !== null ? replyComposer : this.root
      composer.comment = action.captchaToken
      composer.body = action.body
      composer.error = ''
      // 授权已完成，到达提交前一刻：若策略要求验证码且没有 token，先弹出验证码掩膜。
      await this.commentWithCaptchaGate(action, composer)
    } else if (action.type === 'delete') {
      await this.deleteComment(action.commentId)
    } else {
      await this.performLike(action.commentId, action.like)
    }
  }

  // ---- 点赞 ----------------------------------------------------------

  /**
   * 已发布评论点赞/取消赞的入口。正在操作中的评论会忽略重复点击。
   * 匿名模式下只有有效的管理员会话可以交互（普通访客只看到只读计数）。
   * 认证模式下会话缺失或过期时，会启动现有授权弹窗，授权成功后再继续该点赞。
   */
  protected handleLike(commentId: string, like: boolean): void {
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
   * 对后端接口执行一次点赞或取消赞。
   * 成功后以接口返回的计数与状态更新评论；最热排序下会从第一页重新加载，
   * 使可见排序与最新计数一致。
   * 认证或请求失败时保留当前列表，并展示可恢复的错误。
   */
  protected async performLike(commentId: string, like: boolean): Promise<void> {
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
        // widget 会话在探测与写入之间过期：先经弹窗授权流程恢复，再重试点赞。
        this.handleSessionExpired({ type: 'like', commentId, like })
        return
      }
      this.widgetNotice = {
        text: prefixMessage('notice.likeFailed', this.composeMessage(error)),
      }
      this.requestUpdate()
    }
  }

  // ---- 置顶 ---------------------------------------------------------

  /** 为已授权管理员执行根评论置顶切换。 */
  protected handlePin(commentId: string, pinned: boolean): void {
    if (!this.api || !this.config || !this.adminWidgetSessionValid) return
    if (this.state.pendingPinIds?.[commentId]) return
    void this.performPin(commentId, pinned)
  }

  /** 更新置顶状态（以后端返回为准），随后重新加载首页。 */
  protected async performPin(
    commentId: string,
    pinned: boolean,
  ): Promise<void> {
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
}
