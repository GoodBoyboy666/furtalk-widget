/**
 * Authorization flow orchestration.
 *
 * Runs the full widget->first-party handshake from the embedding page:
 * generate a high-entropy request id, open a fresh unnamed window (a normal
 * new tab; no popup/size window features), retry `authorization-init` until
 * `authorization-ready`, then wait for `authorization-success` /
 * `authorization-cancelled` / window close. The browser or user settings may
 * still choose a separate window even when no popup features are supplied.
 *
 * Every message is validated against the expected Furtalk origin, the exact
 * opened window source, the schema, and the matching request_id. No message
 * uses targetOrigin="*". The deployment must preserve `window.opener`
 * (no noopener, no `Cross-Origin-Opener-Policy: same-origin`).
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
 * Window features passed to `window.open`. Intentionally empty: omitting
 * popup and sizing features expresses a normal new-tab preference while
 * keeping `window.opener` intact. Browsers or user settings may still open a
 * separate window; `noopener` is never added.
 */
export const POPUP_FEATURES = ''

export type AuthorizationOutcome =
  | { status: 'success'; code: string; requestId: string }
  | { status: 'cancelled'; requestId: string }
  | { status: 'blocked' }
  | { status: 'closed'; requestId: string }
  | { status: 'timeout'; requestId: string }

export interface AuthorizationFlowOptions {
  /** Exact Furtalk service origin (targetOrigin for every message). */
  furtalkOrigin: string
  siteId: string
  hints: ProfileHints
  open?: (url: string, name: string, features: string) => Window | null
  timeoutMs?: number
  resultTimeoutMs?: number
}

export interface AuthorizationFlowHooks {
  /** Send a validated message to the popup with an exact target origin. */
  postMessage: (target: Window, message: AuthorizationMessage) => void
  /** Register a message listener; returns a remove function. */
  listen: (listener: (event: MessageEvent) => void) => () => void
  /** Report whether the popup window has been closed. */
  isClosed: (target: Window) => boolean
}

/**
 * Runs the authorization flow in a newly opened window/tab. Returns the
 * exchangeable code on explicit approval, or a recoverable outcome for
 * blocked/cancelled/closed/timeout.
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

    // Retry the init handshake until the popup acknowledges, then stop.
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
          // Wait for the user's decision; the popup drives success/cancel.
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

    // Watch for the user closing the popup without a message.
    closeTimer = setInterval(() => {
      if (settled) return
      if (isClosed(popup)) {
        settle({ status: 'closed', requestId })
      }
    }, 250)

    // A popup that never becomes ready is a failed handshake.
    readyTimer = setTimeout(() => {
      if (settled || ready) return
      settle({ status: 'timeout', requestId })
    }, initTimeout)

    // Absolute bound for the whole flow, independent of popup state.
    resultTimer = setTimeout(() => {
      if (settled) return
      settle({ status: 'timeout', requestId })
    }, resultTimeout)
  })
}

/**
 * Returns true when the message is a valid authorization protocol message.
 * Re-exported for the widget entry point so consumers share one decoder.
 */
export { isAuthorizationMessage }
