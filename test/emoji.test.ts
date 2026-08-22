import { describe, expect, it, vi } from 'vitest'

import {
  CatalogError,
  decodeEmojiDocument,
  EMOJI_MAX_PAYLOAD_BYTES,
  isValidEmojiCatalogUrl,
  loadEmojiCatalog,
} from '../src/emoji'

const CATALOG_URL = 'https://cdn.example/emoji.json'

const validDocument = () => ({
  packs: [
    {
      id: 'emoji',
      name: 'Emoji',
      type: 'unicode',
      items: [
        { id: 'joy', name: '笑哭', content: '😂' },
        { id: 'heart', name: '红心', content: '❤️' },
      ],
    },
    {
      id: 'face',
      name: '颜文字',
      type: 'emotion',
      items: [{ id: 'shrug', name: '摊手', content: '¯\\_(ツ)_/¯' }],
    },
    {
      id: 'aru',
      name: '阿鲁',
      type: 'image',
      items: [{ id: 'happy', name: '开心', src: '/emoji/aru/happy.webp' }],
    },
  ],
})

describe('decodeEmojiDocument', () => {
  it('decodes the three pack types with typed items and exact insertions', () => {
    const catalog = decodeEmojiDocument(validDocument(), CATALOG_URL)
    expect(catalog.packs).toHaveLength(3)
    const unicode = catalog.packs[0]!
    expect(unicode.type).toBe('unicode')
    expect(unicode.items[0]!.kind).toBe('text')
    expect(unicode.items[0]!.insertion).toBe('😂')
    expect(catalog.packs[1]!.items[0]!.insertion).toBe('¯\\_(ツ)_/¯')
    const image = catalog.packs[2]!.items[0]!
    expect(image.kind).toBe('image')
    if (image.kind === 'image') {
      expect(image).toMatchObject({ id: 'happy', name: '开心' })
      expect(image.src).toBe('https://cdn.example/emoji/aru/happy.webp')
    }
    expect(image.insertion).toBe(':happy:')
  })

  it('builds a global image token lookup only from image pack items', () => {
    const catalog = decodeEmojiDocument(validDocument(), CATALOG_URL)
    expect(catalog.imageByToken.get('happy')).toMatchObject({
      id: 'happy',
      src: 'https://cdn.example/emoji/aru/happy.webp',
    })
    // 文本包 id 不进入 token 查找。
    expect(catalog.imageByToken.has('joy')).toBe(false)
    expect(catalog.imageByToken.has('shrug')).toBe(false)
  })

  it('rejects the document atomically on duplicate item ids', () => {
    const doc = {
      packs: [
        {
          id: 'a',
          name: 'A',
          type: 'image',
          items: [{ id: 'dup', name: '1', src: '/1.png' }],
        },
        {
          id: 'b',
          name: 'B',
          type: 'image',
          items: [{ id: 'dup', name: '2', src: '/2.png' }],
        },
      ],
    }
    expect(() => decodeEmojiDocument(doc, CATALOG_URL)).toThrow(/duplicate/)
  })

  it('rejects duplicate pack ids', () => {
    const doc = {
      packs: [
        { id: 'a', name: 'A', type: 'unicode', items: [] },
        { id: 'a', name: 'B', type: 'unicode', items: [] },
      ],
    }
    expect(() => decodeEmojiDocument(doc, CATALOG_URL)).toThrow(/duplicate/)
  })

  it('rejects unknown pack types and unexpected fields', () => {
    expect(() =>
      decodeEmojiDocument(
        {
          packs: [{ id: 'a', name: 'A', type: 'nope', items: [] }],
        },
        CATALOG_URL,
      ),
    ).toThrow(/invalid-schema/)
    expect(() =>
      decodeEmojiDocument(
        {
          packs: [
            {
              id: 'a',
              name: 'A',
              type: 'unicode',
              items: [{ id: 'x', name: 'X', content: '😀', extra: 1 }],
            },
          ],
        },
        CATALOG_URL,
      ),
    ).toThrow(/invalid-schema/)
    expect(() =>
      decodeEmojiDocument(
        { packs: [], extra: true },
        CATALOG_URL,
      ),
    ).toThrow(/invalid-root/)
  })

  it('rejects a text item that carries src and an image item that carries content', () => {
    expect(() =>
      decodeEmojiDocument(
        {
          packs: [
            {
              id: 'a',
              name: 'A',
              type: 'unicode',
              items: [{ id: 'x', name: 'X', content: '😀', src: '/x.png' }],
            },
          ],
        },
        CATALOG_URL,
      ),
    ).toThrow(/invalid-schema/)
    expect(() =>
      decodeEmojiDocument(
        {
          packs: [
            {
              id: 'a',
              name: 'A',
              type: 'image',
              items: [{ id: 'x', name: 'X', src: '/x.png', content: '😀' }],
            },
          ],
        },
        CATALOG_URL,
      ),
    ).toThrow(/invalid-schema/)
  })

  it('rejects text content with an HTML tag shape', () => {
    expect(() =>
      decodeEmojiDocument(
        {
          packs: [
            {
              id: 'a',
              name: 'A',
              type: 'emotion',
              items: [{ id: 'x', name: 'X', content: '<script>alert(1)</script>' }],
            },
          ],
        },
        CATALOG_URL,
      ),
    ).toThrow(/markup-in-text/)
  })

  it('rejects unsafe image sources', () => {
    for (const src of [
      'http://img.example/x.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'https://user:pass@img.example/x.png',
    ]) {
      expect(() =>
        decodeEmojiDocument(
          {
            packs: [
              {
                id: 'a',
                name: 'A',
                type: 'image',
                items: [{ id: 'x', name: 'X', src }],
              },
            ],
          },
          CATALOG_URL,
        ),
      ).toThrow(/unsafe-image|invalid-schema/)
    }
  })

  it('rejects non-token-safe ids and oversized names', () => {
    expect(() =>
      decodeEmojiDocument(
        {
          packs: [
            {
              id: 'Bad ID',
              name: 'A',
              type: 'unicode',
              items: [],
            },
          ],
        },
        CATALOG_URL,
      ),
    ).toThrow(/invalid-schema/)
    expect(() =>
      decodeEmojiDocument(
        {
          packs: [
            {
              id: 'a',
              name: 'x'.repeat(65),
              type: 'unicode',
              items: [],
            },
          ],
        },
        CATALOG_URL,
      ),
    ).toThrow(/invalid-schema/)
  })

  it('rejects an invalid root', () => {
    for (const raw of [null, 1, 'text', [], '[]']) {
      expect(() => decodeEmojiDocument(raw, CATALOG_URL)).toThrow(
        /invalid-root/,
      )
    }
  })

  it('rejects oversized pack and item counts', () => {
    const manyPacks = {
      packs: Array.from({ length: 33 }, (_, i) => ({
        id: `g${i}`,
        name: `G${i}`,
        type: 'unicode',
        items: [{ id: `x${i}`, name: 'X', content: '😀' }],
      })),
    }
    expect(() => decodeEmojiDocument(manyPacks, CATALOG_URL)).toThrow(
      /too-many-packs/,
    )

    const manyItems = {
      packs: [
        {
          id: 'a',
          name: 'A',
          type: 'unicode',
          items: Array.from({ length: 257 }, (_, i) => ({
            id: `x${i}`,
            name: 'X',
            content: String.fromCodePoint(0x1f600 + i),
          })),
        },
      ],
    }
    expect(() => decodeEmojiDocument(manyItems, CATALOG_URL)).toThrow(
      /too-many-items/,
    )

    const overTotal = {
      packs: Array.from({ length: 5 }, (_, i) => ({
        id: `g${i}`,
        name: `G${i}`,
        type: 'unicode',
        items: Array.from({ length: 256 }, (_, j) => ({
          id: `x${i}-${j}`,
          name: 'X',
          content: String.fromCodePoint(0x1f600 + i * 256 + j),
        })),
      })),
    }
    expect(() => decodeEmojiDocument(overTotal, CATALOG_URL)).toThrow(
      /too-many-items/,
    )
  })
})

describe('isValidEmojiCatalogUrl', () => {
  it('accepts absolute https URLs without userinfo or fragments', () => {
    expect(isValidEmojiCatalogUrl('https://cdn.example/emoji.json')).toBe(true)
    expect(
      isValidEmojiCatalogUrl('https://cdn.example/emoji.json?version=2'),
    ).toBe(true)
  })

  it('rejects empty, non-https, credentialed, and fragmented URLs', () => {
    expect(isValidEmojiCatalogUrl('')).toBe(false)
    expect(isValidEmojiCatalogUrl('  ')).toBe(false)
    expect(isValidEmojiCatalogUrl('http://cdn.example/emoji.json')).toBe(false)
    expect(isValidEmojiCatalogUrl('//cdn.example/emoji.json')).toBe(false)
    expect(
      isValidEmojiCatalogUrl('https://user:pass@cdn.example/emoji.json'),
    ).toBe(false)
    expect(isValidEmojiCatalogUrl('https://cdn.example/emoji.json#frag')).toBe(
      false,
    )
  })
})

describe('loadEmojiCatalog', () => {
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
    const catalog = await loadEmojiCatalog({ url: CATALOG_URL, fetchImpl })
    expect(catalog.packs).toHaveLength(3)
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
    await expect(
      loadEmojiCatalog({ url: CATALOG_URL, fetchImpl }),
    ).rejects.toThrow(CatalogError)
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
    await expect(
      loadEmojiCatalog({ url: CATALOG_URL, fetchImpl }),
    ).rejects.toThrow(CatalogError)
  })

  it('throws oversized for a declared content-length over the cap', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          url: CATALOG_URL,
          headers: new Headers({
            'Content-Length': String(EMOJI_MAX_PAYLOAD_BYTES + 1),
          }),
          body: null,
        }) as unknown as Response,
    )
    await expect(
      loadEmojiCatalog({ url: CATALOG_URL, fetchImpl }),
    ).rejects.toThrow(/oversized/)
  })

  it('throws oversized for a streamed body over the cap', async () => {
    const big = 'x'.repeat(EMOJI_MAX_PAYLOAD_BYTES + 1)
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
    await expect(
      loadEmojiCatalog({ url: CATALOG_URL, fetchImpl }),
    ).rejects.toThrow(/oversized/)
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
    await expect(
      loadEmojiCatalog({ url: CATALOG_URL, fetchImpl }),
    ).rejects.toThrow(/invalid-json/)
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
    await expect(
      loadEmojiCatalog({ url: CATALOG_URL, fetchImpl }),
    ).rejects.toThrow(CatalogError)
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
    const pending = loadEmojiCatalog({
      url: CATALOG_URL,
      fetchImpl,
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toThrow(CatalogError)
    expect(observedSignal?.aborted).toBe(true)
  })
})
