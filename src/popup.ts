/**
 * 授权 postMessage 协议辅助函数。
 *
 * widget 生成 128 位或更强的随机 request_id，并打开全新的未命名窗口
 * （普通新标签页）。
 * 每条消息都会先校验发送源、窗口来源、协议结构以及 request_id 是否匹配预期。
 * 任何协议消息都不使用 targetOrigin="*"。
 */

import type { AuthorizationMessage } from './types'
import { isAuthorizationMessage } from './types'

export const AUTHORIZATION_PATH = '/authorize'

/** 用 Web Crypto 生成 URL 安全的 base64url 编码 128 位请求 id。 */
export function generateRequestId(random?: () => Uint8Array): string {
  const bytes = random ? random() : crypto.getRandomValues(new Uint8Array(16))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export interface MessageValidation {
  expectedOrigin: string
  expectedSource: Window | MessageEventSource | null
  requestId: string
}

/**
 * 校验收到的消息事件，返回解码后的协议消息；
 * 当来源、结构或 request_id 与预期不符时返回 null。
 */
export function acceptAuthorizationMessage(
  event: MessageEvent,
  expected: MessageValidation,
): AuthorizationMessage | null {
  if (expected.expectedSource && event.source !== expected.expectedSource)
    return null
  if (event.origin !== expected.expectedOrigin) return null
  if (!isAuthorizationMessage(event.data)) return null
  if (event.data.request_id !== expected.requestId) return null
  return event.data
}

/** 构建仅携带 site_id 与 request_id 的授权 URL。 */
export function authorizationUrl(
  furtalkOrigin: string,
  siteId: string,
  requestId: string,
): string {
  const params = new URLSearchParams({ site_id: siteId, request_id: requestId })
  return `${furtalkOrigin}${AUTHORIZATION_PATH}?${params.toString()}`
}
