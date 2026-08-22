/**
 * Safe comment-body rendering with emoji image-token expansion.
 *
 * This is the single comment-body rendering boundary. Raw HTML is disabled;
 * link/image destinations are restricted to safe schemes by markdown-it's
 * built-in validation; every external link gets
 * rel="nofollow ugc noopener noreferrer" plus target="_blank"; Markdown
 * images keep lazy/no-referrer/async attributes.
 *
 * Known `:<id>:` image tokens from the normalized catalog are expanded to
 * renderer-owned safe `<img>` nodes. Unknown tokens, inline/fenced code,
 * Markdown link/image destinations, and markup-looking text stay literal.
 */

import MarkdownIt from 'markdown-it'

import type { EmojiCatalog, ImageEmojiItem } from './emoji'

/** Bounded `:<id>:` grammar; ids match `^[a-z0-9][a-z0-9_-]{0,63}$`. */
const TOKEN_PATTERN = /:([a-z0-9][a-z0-9_-]{0,63}):/g

/** Escapes HTML special characters (same mapping as markdown-it). */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

/** Render env carrying the shared normalized catalog snapshot. */
export interface EmojiRenderEnv {
  emojiCatalog: EmojiCatalog | null
}

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
  // 图片懒加载、无 referrer 与异步解码；对目录图片与既有用户 Markdown
  // 图片同样生效，不改动后端允许的 URL 契约。
  token.attrSet('loading', 'lazy')
  token.attrSet('referrerpolicy', 'no-referrer')
  token.attrSet('decoding', 'async')
  return defaultImageRender(tokens, idx, options, env, self)
}

const defaultTextRender =
  md.renderer.rules.text ??
  ((tokens, idx, _options, _env, _self) => {
    const token = tokens[idx]
    return token ? escapeHtml(token.content) : ''
  })

md.renderer.rules.text = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  if (!token) return ''
  const content = token.content
  const renderEnv = env as EmojiRenderEnv | undefined
  const catalog = renderEnv?.emojiCatalog
  // 含 `<` 的文本视为可能残留的 raw HTML 形态，整体保持字面量不被改写。
  if (!catalog || catalog.imageByToken.size === 0 || content.includes('<')) {
    return defaultTextRender(tokens, idx, options, env, self)
  }
  return expandTextTokens(content, catalog)
}

/** Splits ordinary text on the `:<id>:` grammar; known image ids become imgs. */
function expandTextTokens(content: string, catalog: EmojiCatalog): string {
  let out = ''
  let last = 0
  TOKEN_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TOKEN_PATTERN.exec(content)) !== null) {
    const tokenStart = match.index
    const tokenEnd = tokenStart + match[0].length
    const id = match[1] ?? ''
    out += escapeHtml(content.slice(last, tokenStart))
    const item = catalog.imageByToken.get(id)
    out += item ? renderExpressionImage(item) : escapeHtml(match[0])
    last = tokenEnd
  }
  out += escapeHtml(content.slice(last))
  return out
}

/** Builds a safe expression image from a decoder-approved image item. */
function renderExpressionImage(item: ImageEmojiItem): string {
  return (
    `<img class="ft-emoji-image" src="${escapeHtml(item.src)}" ` +
    `alt="${escapeHtml(item.name)}" loading="lazy" decoding="async" ` +
    `referrerpolicy="no-referrer">`
  )
}

/**
 * Renders a comment body to safe HTML, expanding known emoji image tokens
 * from the shared catalog snapshot. When the catalog is absent, loading,
 * invalid, or failed, every token remains literal and comment reading works.
 */
export function renderCommentContent(
  source: string,
  catalog: EmojiCatalog | null,
): string {
  return md.render(source, { emojiCatalog: catalog })
}
