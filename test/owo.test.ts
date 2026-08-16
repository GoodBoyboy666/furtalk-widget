import { describe, expect, it, vi } from 'vitest'

import {
  buildImageMarkdown,
  CatalogError,
  decodeCatalog,
  isValidCatalogUrl,
  loadCatalog,
  OWO_MAX_PAYLOAD_BYTES,
} from '../src/owo'

const CATALOG_URL = 'https://cdn.example/owo.json'

const validDocument = () => ({
  颜文字: {
    type: 'emoticon',
    container: [{ icon: 'OωO', text: 'Hi' }],
  },
  Emoji: {
    type: 'emoji',
    container: [{ icon: '😀', text: '' }],
  },
})

describe('decodeCatalog', () => {
  it('decodes text and emoji groups with normalized items', () => {
    const groups = decodeCatalog(validDocument(), CATALOG_URL)
    expect(groups).toHaveLength(2)
    const emoticon = groups[0]!
    expect(emoticon.kind).toBe('emoticon')
    expect(emoticon.id).toBe('custom-0')
    expect(emoticon.items[0]!.insertion).toBe('OωO')
    const emoji = groups[1]!
    expect(emoji.kind).toBe('emoji')
    expect(emoji.items[0]).toMatchObject({ insertion: '😀', label: '😀' })
  })

  it('extracts only the src from an official <img> image package', () => {
    const groups = decodeCatalog(
      {
        图片表情: {
          type: 'image',
          container: [
            {
              icon: '<img src="//img.example/face1.gif">',
              text: 'face1',
            },
          ],
        },
      },
      CATALOG_URL,
    )
    const item = groups[0]!.items[0]!
    expect(item.kind).toBe('image')
    expect(item.imageUrl).toBe('https://img.example/face1.gif')
    expect(item.insertion).toBe('![face1](https://img.example/face1.gif)')
    expect(item.insertion).not.toContain('<img')
  })

  it('resolves a plain URL image source as a Furtalk extension', () => {
    const groups = decodeCatalog(
      {
        images: {
          type: 'image',
          container: [{ icon: 'https://img.example/face.png', text: 'face' }],
        },
      },
      CATALOG_URL,
    )
    expect(groups[0]!.items[0]!.imageUrl).toBe('https://img.example/face.png')
  })

  it('rejects the document atomically when text contains an HTML tag shape', () => {
    expect(() =>
      decodeCatalog(
        {
          evil: {
            type: 'emoticon',
            container: [{ icon: '<script>alert(1)</script>', text: '' }],
          },
        },
        CATALOG_URL,
      ),
    ).toThrow(CatalogError)
  })

  it('rejects unsafe image sources', () => {
    for (const icon of [
      '<img src="http://img.example/x.png">',
      '<img src="data:image/png;base64,AAAA">',
      '<img src="javascript:alert(1)">',
    ]) {
      expect(() =>
        decodeCatalog(
          { images: { type: 'image', container: [{ icon, text: '' }] } },
          CATALOG_URL,
        ),
      ).toThrow(/unsafe-image|invalid-json/)
    }
  })

  it('ignores extra img attributes but still resolves the src to https', () => {
    const groups = decodeCatalog(
      {
        images: {
          type: 'image',
          container: [
            {
              icon: '<img src="//img.example/x.png" onerror="alert(1)" style="color:red">',
              text: 'face',
            },
          ],
        },
      },
      CATALOG_URL,
    )
    const item = groups[0]!.items[0]!
    expect(item.imageUrl).toBe('https://img.example/x.png')
    expect(item.insertion).toBe('![face](https://img.example/x.png)')
    expect(item.insertion).not.toContain('onerror')
  })

  it('rejects malformed image markup', () => {
    expect(() =>
      decodeCatalog(
        {
          images: {
            type: 'image',
            container: [
              { icon: '<img src="//img.example/x.png"><p>child</p>', text: '' },
            ],
          },
        },
        CATALOG_URL,
      ),
    ).toThrow(CatalogError)
  })

  it('rejects control characters in text labels', () => {
    expect(() =>
      decodeCatalog(
        {
          evil: {
            type: 'emoticon',
            container: [{ icon: '😀', text: 'bad\ntext' }],
          },
        },
        CATALOG_URL,
      ),
    ).toThrow(/invalid-schema/)
  })

  it('rejects an invalid root', () => {
    for (const raw of [null, 1, 'text', [], '[]']) {
      expect(() => decodeCatalog(raw, CATALOG_URL)).toThrow(/invalid-root/)
    }
  })

  it('rejects invalid group schema', () => {
    expect(() =>
      decodeCatalog({ broken: { type: 'nope', container: [] } }, CATALOG_URL),
    ).toThrow(/invalid-schema/)
    expect(() =>
      decodeCatalog({ broken: { type: 'emoji', container: 'x' } }, CATALOG_URL),
    ).toThrow(/invalid-schema/)
    expect(() =>
      decodeCatalog(
        { broken: { type: 'emoji', container: [{ icon: 1, text: '' }] } },
        CATALOG_URL,
      ),
    ).toThrow(/invalid-schema/)
  })

  it('rejects oversized group and item counts', () => {
    const manyGroups = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [
        `g${i}`,
        { type: 'emoji', container: [{ icon: '😀', text: '' }] },
      ]),
    )
    expect(() => decodeCatalog(manyGroups, CATALOG_URL)).toThrow(
      /too-many-groups/,
    )

    const manyItems = {
      emoji: {
        type: 'emoji',
        container: Array.from({ length: 257 }, (_, i) => ({
          icon: String.fromCodePoint(0x1f600 + i),
          text: '',
        })),
      },
    }
    expect(() => decodeCatalog(manyItems, CATALOG_URL)).toThrow(
      /too-many-items/,
    )

    const overTotal = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [
        `g${i}`,
        {
          type: 'emoji',
          container: Array.from({ length: 256 }, (_, j) => ({
            icon: String.fromCodePoint(0x1f600 + i * 256 + j),
            text: '',
          })),
        },
      ]),
    )
    expect(() => decodeCatalog(overTotal, CATALOG_URL)).toThrow(
      /too-many-items/,
    )
  })
})

describe('buildImageMarkdown', () => {
  it('escapes label brackets and encodes destination parentheses', () => {
    const out = buildImageMarkdown('a[b]', 'https://img.example/x(y).gif')
    expect(out).toBe('![a\\[b\\]](https://img.example/x%28y%29.gif)')
    expect(out).not.toContain('<img')
  })
})

describe('isValidCatalogUrl', () => {
  it('accepts absolute https URLs without userinfo or fragments', () => {
    expect(isValidCatalogUrl('https://cdn.example/owo.json')).toBe(true)
    expect(isValidCatalogUrl('https://cdn.example/owo.json?version=2')).toBe(
      true,
    )
  })

  it('rejects empty, non-https, credentialed, and fragmented URLs', () => {
    expect(isValidCatalogUrl('')).toBe(false)
    expect(isValidCatalogUrl('  ')).toBe(false)
    expect(isValidCatalogUrl('http://cdn.example/owo.json')).toBe(false)
    expect(isValidCatalogUrl('//cdn.example/owo.json')).toBe(false)
    expect(isValidCatalogUrl('https://user:pass@cdn.example/owo.json')).toBe(
      false,
    )
    expect(isValidCatalogUrl('https://cdn.example/owo.json#frag')).toBe(false)
  })
})

describe('loadCatalog', () => {
  function okResponse(body: unknown, url = CATALOG_URL): Response {
    return {
      ok: true,
      status: 200,
      url,
      headers: new Headers(),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(body)))
          controller.close()
        },
      }),
    } as unknown as Response
  }

  it('fetches with credentialless CORS options and decodes the document', async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        okResponse(validDocument()),
    )
    const groups = await loadCatalog({ url: CATALOG_URL, fetchImpl })
    expect(groups).toHaveLength(2)
    const call = fetchImpl.mock.calls[0]!
    const [, init] = call
    expect(init).toMatchObject({
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    })
    expect(init?.signal).toBeDefined()
  })

  it('throws on non-2xx responses', async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: false, status: 500 }) as unknown as Response,
    )
    await expect(loadCatalog({ url: CATALOG_URL, fetchImpl })).rejects.toThrow(
      CatalogError,
    )
  })

  it('throws when the final redirect leaves https', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          url: 'http://evil.example/catalog.json',
          headers: new Headers(),
          body: null,
          text: async () => '{}',
        }) as unknown as Response,
    )
    await expect(loadCatalog({ url: CATALOG_URL, fetchImpl })).rejects.toThrow(
      CatalogError,
    )
  })

  it('throws oversized for a declared content-length over the cap', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          url: CATALOG_URL,
          headers: new Headers({
            'Content-Length': String(OWO_MAX_PAYLOAD_BYTES + 1),
          }),
          body: null,
        }) as unknown as Response,
    )
    await expect(loadCatalog({ url: CATALOG_URL, fetchImpl })).rejects.toThrow(
      /oversized/,
    )
  })

  it('throws oversized for a streamed body over the cap', async () => {
    const big = 'x'.repeat(OWO_MAX_PAYLOAD_BYTES + 1)
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          url: CATALOG_URL,
          headers: new Headers(),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(big))
              controller.close()
            },
          }),
        }) as unknown as Response,
    )
    await expect(loadCatalog({ url: CATALOG_URL, fetchImpl })).rejects.toThrow(
      /oversized/,
    )
  })

  it('throws invalid-json for malformed JSON', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          url: CATALOG_URL,
          headers: new Headers(),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('not json'))
              controller.close()
            },
          }),
        }) as unknown as Response,
    )
    await expect(loadCatalog({ url: CATALOG_URL, fetchImpl })).rejects.toThrow(
      /invalid-json/,
    )
  })

  it('wraps mid-stream read failures as CatalogError', async () => {
    const reader = {
      read: () => Promise.reject(new TypeError('network dropped')),
      cancel: () => Promise.resolve(),
    }
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          url: CATALOG_URL,
          headers: new Headers(),
          body: { getReader: () => reader },
        }) as unknown as Response,
    )
    await expect(loadCatalog({ url: CATALOG_URL, fetchImpl })).rejects.toThrow(
      CatalogError,
    )
  })

  it('aborts the in-flight request when the outer signal aborts', async () => {
    const controller = new AbortController()
    let observedSignal: AbortSignal | undefined
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
      })
    })
    const pending = loadCatalog({
      url: CATALOG_URL,
      fetchImpl,
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toThrow(CatalogError)
    expect(observedSignal?.aborted).toBe(true)
  })
})
