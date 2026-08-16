/**
 * Safe Markdown rendering.
 *
 * Raw HTML is disabled; link/image destinations are restricted to safe
 * schemes by markdown-it's built-in validation, and every external link gets
 * rel="nofollow ugc noopener noreferrer" plus target="_blank".
 */

import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  if (!token) return defaultLinkOpen(tokens, idx, options, env, self)
  const href = String(token.attrGet('href') ?? '')
  if (/^https?:\/\//i.test(href)) {
    token.attrSet('rel', 'nofollow ugc noopener noreferrer')
    token.attrSet('target', '_blank')
  }
  return defaultLinkOpen(tokens, idx, options, env, self)
}

const defaultImageRender =
  md.renderer.rules.image ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  if (!token) return defaultImageRender(tokens, idx, options, env, self)
  // 图片懒加载、无 referrer 与异步解码；对自定义目录图片与既有用户 Markdown
  // 图片同样生效，不改动后端允许的 URL 契约。
  token.attrSet('loading', 'lazy')
  token.attrSet('referrerpolicy', 'no-referrer')
  token.attrSet('decoding', 'async')
  return defaultImageRender(tokens, idx, options, env, self)
}

export function renderMarkdown(source: string): string {
  return md.render(source)
}
