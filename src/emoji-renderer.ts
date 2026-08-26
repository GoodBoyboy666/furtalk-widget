/**
 * 安全地渲染评论正文，并展开表情图片标记。
 *
 * 评论正文只在这里渲染。原生 HTML 被禁用；链接和图片的地址由 markdown-it
 * 内置校验限制为安全协议；所有外部链接都会带上
 * rel="nofollow ugc noopener noreferrer" 与 target="_blank"；
 * Markdown 图片保留 lazy/no-referrer/async 属性。
 *
 * `:<id>:` 表情包会展开为渲染器自己生成的安全 `<img>` 节点；
 * 未知标记、行内/围栏代码、链接/图片地址以及形似标记的文本一律保持原样。
 */

import MarkdownIt from 'markdown-it'

import type { EmojiCatalog, ImageEmojiItem } from './emoji'

/** `:<id>:` 语法受限：id 匹配 `^[a-z0-9][a-z0-9_-]{0,63}$`。 */
const TOKEN_PATTERN = /:([a-z0-9][a-z0-9_-]{0,63}):/g

/** 转义 HTML 特殊字符（与 markdown-it 的映射一致）。 */
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

/** 渲染环境，包含共享的规范化目录快照。 */
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
  // 图片启用懒加载、不携带 referrer、异步解码；对表情目录图片和用户原有的
  // Markdown 图片同样生效，不改动后端允许的链接规则。
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
  // 含 `<` 的文本可能残留原始 HTML，整体保持字面量不改写。
  if (!catalog || catalog.imageByToken.size === 0 || content.includes('<')) {
    return defaultTextRender(tokens, idx, options, env, self)
  }
  return expandTextTokens(content, catalog)
}

/** 按 `:<id>:` 语法切分普通文本；已知的图片 id 转成 img 标签。 */
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

/** 根据通过校验的图片项，生成安全的表情图片标签。 */
function renderExpressionImage(item: ImageEmojiItem): string {
  return (
    `<img class="ft-emoji-image" src="${escapeHtml(item.src)}" ` +
    `alt="${escapeHtml(item.name)}" loading="lazy" decoding="async" ` +
    `referrerpolicy="no-referrer">`
  )
}

/**
 * 将评论正文渲染为安全 HTML，并展开共享目录快照中已知的表情图片标记。
 * 当目录缺失、加载中、无效或失败时，所有标记保持字面量，评论阅读不受影响。
 */
export function renderCommentContent(
  source: string,
  catalog: EmojiCatalog | null,
): string {
  return md.render(source, { emojiCatalog: catalog })
}
