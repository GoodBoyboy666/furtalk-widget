import { describe, expect, it } from 'vitest'

import { renderCommentContent } from '../src/emoji-renderer'

describe('renderCommentContent Markdown boundary (no catalog)', () => {
  it('escapes raw HTML', () => {
    const out = renderCommentContent('<script>alert(1)</script>', null)
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('adds rel and target to external links', () => {
    const out = renderCommentContent('[link](https://example.com)', null)
    expect(out).toContain('rel="nofollow ugc noopener noreferrer"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('href="https://example.com"')
  })

  it('leaves relative links without external rel', () => {
    const out = renderCommentContent('[local](/docs)', null)
    expect(out).not.toContain('rel="nofollow')
    expect(out).toContain('href="/docs"')
  })

  it('renders paragraphs and code fences', () => {
    const out = renderCommentContent('hello\n\n`inline`\n\n```ts\nconst x = 1\n```', null)
    expect(out).toContain('<p>hello</p>')
    expect(out).toContain('<code>inline</code>')
    expect(out).toContain('<pre><code class="language-ts">')
  })

  it('adds lazy no-referrer async attributes to images without enabling HTML', () => {
    const out = renderCommentContent('![alt](https://cdn.example/face.gif)', null)
    expect(out).toContain('<img')
    expect(out).toContain('loading="lazy"')
    expect(out).toContain('referrerpolicy="no-referrer"')
    expect(out).toContain('decoding="async"')
    expect(out).toContain('src="https://cdn.example/face.gif"')
    expect(out).not.toContain('onerror')
  })

  it('escapes raw HTML even next to markdown images', () => {
    const out = renderCommentContent(
      '![x](https://cdn.example/a.png) <script>alert(1)</script>',
      null,
    )
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })
})
