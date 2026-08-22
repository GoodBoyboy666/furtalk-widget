/**
 * Widget entry point.
 *
 * Registers the <furtalk-comments> custom element and re-exports the typed
 * API/message contracts for integrators and the authorization popup host.
 */

import { FurtalkCommentsElement } from './element'

if (
  typeof customElements !== 'undefined' &&
  customElements.get('furtalk-comments') === undefined
) {
  customElements.define('furtalk-comments', FurtalkCommentsElement)
}

export { FurtalkCommentsElement, defaultServiceOrigin } from './element'
export { ApiClient } from './api'
export { runAuthorizationFlow } from './auth'
export { mountCaptcha, canRenderCaptcha } from './captcha'
export { WidgetError } from './errors'
export {
  buildCommentTree,
  isOwnedBy,
  mergeComments,
  submissionNotice,
} from './comments'
export { parseWidgetConfig } from './config'
export { widgetReducer, initialState } from './state'
export { createProfileStore } from './storage'
export { validateProfileHints } from './profile'
export { renderCommentContent } from './emoji-renderer'
export {
  acceptAuthorizationMessage,
  authorizationUrl,
  generateRequestId,
} from './popup'
export { isAuthorizationMessage } from './types'
export type {
  AuthorizationMessage,
  Comment,
  CommentDeleteResult,
  CommentSort,
  CreateCommentInput,
  ProfileHints,
  RuntimeConfig,
  ThreadResponse,
  WidgetSession,
} from './types'
