/**
 * Authorization postMessage protocol helpers.
 *
 * The widget generates a 128-bit-or-stronger random request_id and opens a
 * fresh unnamed window (a normal new tab). Every message is validated for the
 * expected exact origin, exact window source, schema, and matching request_id
 * before acting. No protocol message ever uses targetOrigin="*".
 */

import type { AuthorizationMessage } from './types'
import { isAuthorizationMessage } from './types'

export const AUTHORIZATION_PATH = '/authorize'

/** Generates a URL-safe base64url-encoded 128-bit request id with Web Crypto. */
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
 * Validates a received message event and returns the decoded protocol message,
 * or null when the origin/source/schema/request_id do not all match.
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

/** Builds the authorization URL carrying only site_id and request_id. */
export function authorizationUrl(
  furtalkOrigin: string,
  siteId: string,
  requestId: string,
): string {
  const params = new URLSearchParams({ site_id: siteId, request_id: requestId })
  return `${furtalkOrigin}${AUTHORIZATION_PATH}?${params.toString()}`
}
