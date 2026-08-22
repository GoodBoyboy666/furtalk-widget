import { describe, expect, it } from 'vitest'

import { decodeEmojiDocument } from '../src/emoji'
import { renderCommentContent } from '../src/emoji-renderer'

const CATALOG_URL = 'https://cdn.example/emoji.json'

const catalog = decodeEmojiDocument(
  {
    packs: [
      {
        id: 'emoji',
        name: 'Emoji',
        type: 'unicode',
        items: [{ id: 'joy', name: '笑哭', content: '😂' }],
      },
      {
        id: 'aru',
        name: '阿鲁',
        type: 'image',
        items: [
          { id: 'happy', name: '开心', src: '/emoji/aru/happy.webp' },
          { id: 'smile', name: 'Smiley <3', src: 'https://img.example/smile.png' },
        ],
      },
    ],
  },
  CATALOG_URL,
)

function render(source: string): string {
  return renderCommentContent(source, catalog)
}

describe('renderCommentContent emoji image tokens', () => {
  it('expands a known image token to a safe expression image', () => {
    const out = render('hello :happy: world')
    expect(out).toContain('<img class="ft-emoji-image"')
    expect(out).toContain('src="https://cdn.example/emoji/aru/happy.webp"')
    expect(out).toContain('alt="开心"')
    expect(out).toContain('loading="lazy"')
    expect(out).toContain('decoding="async"')
    expect(out).toContain('referrerpolicy="no-referrer"')
    expect(out).not.toContain(':happy:')
  })

  it('keeps unknown tokens literal', () => {
    const out = render('see :missing: and :Happy: now')
    expect(out).toContain(':missing:')
    expect(out).toContain(':Happy:')
    expect(out).not.toContain('<img')
  })

  it('keeps text-pack ids literal (never rendered as images)', () => {
    const out = render('use :joy: here')
    expect(out).toContain(':joy:')
    expect(out).not.toContain('<img')
  })

  it('does not expand tokens inside inline or fenced code', () => {
    const inline = render('`code :happy: here` and :happy: after')
    expect(inline).toContain('code :happy: here')
    expect(inline.match(/<img/g)).toHaveLength(1)
    const fenced = render('```\n:smile: not expanded\n```\nplain :smile:')
    expect(fenced).toContain(':smile: not expanded')
    expect(fenced.match(/<img/g)).toHaveLength(1)
  })

  it('does not rewrite Markdown link destinations', () => {
    const out = render('[link](https://example.com/:happy:) then :happy:')
    expect(out).toContain('https://example.com/:happy:')
    expect(out.match(/<img/g)).toHaveLength(1)
  })

  it('keeps markup-looking text literal without token expansion', () => {
    const out = render('<b>bold</b> :happy:')
    // 含 `<` 的文本整体字面量：token 不展开。
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;b&gt;bold&lt;/b&gt;')
    expect(out).toContain(':happy:')
  })

  it('escapes malicious names and urls', () => {
    const out = render(':smile:')
    expect(out).not.toContain('<3')
    expect(out).toContain('Smiley &lt;3')
    expect(out).toContain('src="https://img.example/smile.png"')
  })

  it('expands multiple tokens in one text run', () => {
    const out = render(':happy: and :smile:')
    expect(out.match(/<img/g)).toHaveLength(2)
  })

  it('keeps every token literal when the catalog is absent', () => {
    const out = renderCommentContent('still :happy: literal', null)
    expect(out).toContain(':happy:')
    expect(out).not.toContain('<img')
  })

  it('preserves raw HTML disablement and external-link protections', () => {
    const out = render('<img src=x onerror="alert(1)"> and https://example.com')
    expect(out).not.toContain('<img src=x')
    expect(out).toContain('&lt;img')
    expect(out).toContain('rel="nofollow ugc noopener noreferrer"')
    expect(out).toContain('target="_blank"')
  })

  it('keeps existing Markdown image attributes', () => {
    const out = render('![alt](https://img.example/md.png)')
    expect(out).toContain('loading="lazy"')
    expect(out).toContain('referrerpolicy="no-referrer"')
    expect(out).toContain('decoding="async"')
  })
})
