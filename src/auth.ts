/**
 * 授权流程编排。
 *
 * 在嵌入页面运行完整的 widget → 第一方握手流程：生成高熵请求 id，打开全新的
 * 未命名窗口（普通新标签页；不附加 popup/size 等窗口特性），持续重试
 * `authorization-init` 直到 `authorization-ready`，然后等待
 * `authorization-success` / `authorization-cancelled` / 窗口关闭。
 * 即使不提供任何弹窗特性，浏览器或用户设置仍可能选择打开独立窗口。
 *
 * 每条消息都会校验 Furtalk 源、窗口来源、协议结构以及 request_id 是否与预期匹配。
 * 任何消息都不使用 targetOrigin="*"。
 * 部署时必须保留 `window.opener`（不可使用 noopener，也不可设置
 * `Cross-Origin-Opener-Policy: same-origin`）。
 */

import {
  acceptAuthorizationMessage,
  authorizationUrl,
  generateRequestId,
  type MessageValidation,
} from './popup'
import type { AuthorizationMessage, ProfileHints } from './types'
import { isAuthorizationMessage } from './types'

export const INIT_RETRY_INTERVAL_MS = 150
export const INIT_TIMEOUT_MS = 30_000
export const RESULT_TIMEOUT_MS = 5 * 60_000
/**
 * 传给 `window.open` 的窗口特性。
 * 刻意留空：省略 popup 与尺寸特性表示期望打开普通新标签页，同时保留
 * `window.opener`。浏览器或用户设置仍可能打开独立窗口；不可添加 `noopener`。
 */
export const POPUP_FEATURES = ''

export type AuthorizationOutcome =
  | { status: 'success'; code: string; requestId: string }
  | { status: 'cancelled'; requestId: string }
  | { status: 'blocked' }
  | { status: 'closed'; requestId: string }
  | { status: 'timeout'; requestId: string }

export interface AuthorizationFlowOptions {
  /** 确切的 Furtalk 服务源（每条消息的 targetOrigin）。 */
  furtalkOrigin: string
  siteId: string
  hints: ProfileHints
  open?: (url: string, name: string, features: string) => Window | null
  timeoutMs?: number
  resultTimeoutMs?: number
}

export interface AuthorizationFlowHooks {
  /** 向弹窗发送一条已通过校验、且带精确 target origin 的消息。 */
  postMessage: (target: Window, message: AuthorizationMessage) => void
  /** 注册消息监听器；返回一个移除函数。 */
  listen: (listener: (event: MessageEvent) => void) => () => void
  /** 报告弹窗窗口是否已关闭。 */
  isClosed: (target: Window) => boolean
}

/**
 * 在新打开的窗口/标签页中运行授权流程。
 * 用户在显式批准时返回可交换的 code，否则返回可恢复的结果
 * （blocked/cancelled/closed/timeout）。
 */
export function runAuthorizationFlow(
  options: AuthorizationFlowOptions,
  hooks?: AuthorizationFlowHooks,
): Promise<AuthorizationOutcome> {
  const open =
    options.open ??
    ((url, name, features) => {
      try {
        return window.open(url, name, features)
      } catch {
        return null
      }
    })
  const postMessage =
    hooks?.postMessage ??
    ((target, message) => target.postMessage(message, options.furtalkOrigin))
  const listen =
    hooks?.listen ??
    ((listener) => {
      window.addEventListener('message', listener)
      return () => window.removeEventListener('message', listener)
    })
  const isClosed = hooks?.isClosed ?? ((target) => target.closed)

  const requestId = generateRequestId()
  const url = authorizationUrl(options.furtalkOrigin, options.siteId, requestId)
  const popup = open(url, '_blank', POPUP_FEATURES)
  if (!popup) {
    return Promise.resolve({ status: 'blocked' })
  }

  const initTimeout = options.timeoutMs ?? INIT_TIMEOUT_MS
  const resultTimeout = options.resultTimeoutMs ?? RESULT_TIMEOUT_MS

  return new Promise<AuthorizationOutcome>((resolve) => {
    let settled = false
    let ready = false
    let initTimer: ReturnType<typeof setInterval> | null = null
    let resultTimer: ReturnType<typeof setTimeout> | null = null
    let readyTimer: ReturnType<typeof setTimeout> | null = null
    let closeTimer: ReturnType<typeof setInterval> | null = null
    let removeListener: (() => void) | null = null

    const settle = (outcome: AuthorizationOutcome) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(outcome)
    }

    const cleanup = () => {
      if (initTimer !== null) clearInterval(initTimer)
      if (resultTimer !== null) clearTimeout(resultTimer)
      if (readyTimer !== null) clearTimeout(readyTimer)
      if (closeTimer !== null) clearInterval(closeTimer)
      if (removeListener) removeListener()
    }

    const validation: MessageValidation = {
      expectedOrigin: options.furtalkOrigin,
      expectedSource: popup,
      requestId,
    }

    const sendInit = () => {
      const message: AuthorizationMessage = {
        type: 'furtalk:authorization-init',
        request_id: requestId,
        email: options.hints.email || undefined,
      }
      postMessage(popup, message)
    }

    // 持续重试初始化握手，直到弹窗确认，然后停止。
    initTimer = setInterval(() => {
      if (settled) return
      if (ready) {
        if (initTimer !== null) clearInterval(initTimer)
        return
      }
      sendInit()
    }, INIT_RETRY_INTERVAL_MS)
    sendInit()

    const onMessage = (event: MessageEvent) => {
      if (settled) return
      const message = acceptAuthorizationMessage(event, validation)
      if (!message) return
      switch (message.type) {
        case 'furtalk:authorization-ready':
          ready = true
          if (readyTimer !== null) clearTimeout(readyTimer)
          // 等待用户决定；由弹窗驱动成功/取消。
          return
        case 'furtalk:authorization-success':
          settle({ status: 'success', code: message.code, requestId })
          return
        case 'furtalk:authorization-cancelled':
          settle({ status: 'cancelled', requestId })
          return
        default:
          return
      }
    }
    removeListener = listen(onMessage)

    // 侦测弹窗是否未发送协议消息而被直接关闭。
    closeTimer = setInterval(() => {
      if (settled) return
      if (isClosed(popup)) {
        settle({ status: 'closed', requestId })
      }
    }, 250)

    // 始终未就绪的弹窗视为握手失败。
    readyTimer = setTimeout(() => {
      if (settled || ready) return
      settle({ status: 'timeout', requestId })
    }, initTimeout)

    // 整个流程的绝对时限，与弹窗状态无关。
    resultTimer = setTimeout(() => {
      if (settled) return
      settle({ status: 'timeout', requestId })
    }, resultTimeout)
  })
}

/**
 * 当消息为有效的授权协议消息时返回 true。
 * 为 widget 入口重新导出，使各消费方共享同一个解码器。
 */
export { isAuthorizationMessage }
