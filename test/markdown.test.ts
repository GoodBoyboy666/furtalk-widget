import { describe, expect, it } from 'vitest'

import { renderMarkdown } from '../src/markdown'

describe('renderMarkdown', () => {
  it('escapes raw HTML', () => {
    const out = renderMarkdown('<script>alert(1)</script>')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('adds rel and target to external links', () => {
    const out = renderMarkdown('[link](https://example.com)')
    expect(out).toContain('rel="nofollow ugc noopener noreferrer"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('href="https://example.com"')
  })

  it('leaves relative links without external rel', () => {
    const out = renderMarkdown('[local](/docs)')
    expect(out).not.toContain('rel="nofollow')
    expect(out).toContain('href="/docs"')
  })

  it('renders paragraphs and code fences', () => {
    const out = renderMarkdown('hello\n\n`inline`\n\n```ts\nconst x = 1\n```')
    expect(out).toContain('<p>hello</p>')
    expect(out).toContain('<code>inline</code>')
    expect(out).toContain('<pre><code class="language-ts">')
  })

  it('adds lazy no-referrer async attributes to images without enabling HTML', () => {
    const out = renderMarkdown('![alt](https://cdn.example/face.gif)')
    expect(out).toContain('<img')
    expect(out).toContain('loading="lazy"')
    expect(out).toContain('referrerpolicy="no-referrer"')
    expect(out).toContain('decoding="async"')
    expect(out).toContain('src="https://cdn.example/face.gif"')
    expect(out).not.toContain('onerror')
  })

  it('escapes raw HTML even next to markdown images', () => {
    const out = renderMarkdown(
      '![x](https://cdn.example/a.png) <script>alert(1)</script>',
    )
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })
})
