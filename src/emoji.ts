/**
 * Furtalk-owned remote emoji-pack catalog boundary.
 *
 * The catalog content is always supplied and licensed by the deployer through
 * the instance-wide `emoji_catalog_url` setting; this project distributes no
 * emoji data. The normative wire contract is
 * `research/emoji-pack-protocol.md` (root `{ packs: EmojiPack[] }` with closed
 * pack types `unicode | emotion | image`).
 *
 * This module is the SINGLE owner of raw catalog payload handling. Raw source
 * types are `unknown`; normalized packs carry typed items and exact insertion
 * strings. UI and rendering code consume only the normalized `EmojiCatalog`
 * (plus the derived image token lookup) and never cast remote payload fields.
 */

/** Bounded catalog and payload limits (Furtalk defensive defaults). */
export const EMOJI_MAX_PAYLOAD_BYTES = 512 * 1024
export const EMOJI_MAX_PACKS = 32
export const EMOJI_MAX_ITEMS_PER_PACK = 256
export const EMOJI_MAX_TOTAL_ITEMS = 1024
export const EMOJI_MAX_PACK_NAME = 64
export const EMOJI_MAX_ITEM_NAME = 128
export const EMOJI_MAX_CONTENT = 256
export const EMOJI_MAX_SRC = 2048
export const EMOJI_FETCH_TIMEOUT_MS = 5000

/** Closed pack type union of the Furtalk emoji-pack protocol. */
export type EmojiPackType = 'unicode' | 'emotion' | 'image'

/** A normalized text-like item from a `unicode` or `emotion` pack. */
export interface TextEmojiItem {
  kind: 'text'
  /** Stable token-safe id; never trusted markup. */
  id: string
  /** Human-readable label used for accessible name / tooltip. */
  name: string
  /** Exact insertion string: the literal `content` value. */
  content: string
  insertion: string
}

/** A normalized image item from an `image` pack. */
export interface ImageEmojiItem {
  kind: 'image'
  /** Stable token-safe id; `:<id>:` is the insertion and render token. */
  id: string
  /** Human-readable label used as the accessible name. */
  name: string
  /** Absolute HTTPS image URL resolved against the catalog response URL. */
  src: string
  /** Exact insertion string: always `:<id>:`. */
  insertion: string
}

export type EmojiItem = TextEmojiItem | ImageEmojiItem

/** A normalized emoji pack with typed items. */
export interface EmojiPack {
  id: string
  name: string
  type: EmojiPackType
  items: EmojiItem[]
}

/**
 * A normalized catalog snapshot. Picker and Renderer consume the same
 * successfully decoded snapshot; `imageByToken` is the derived global image
 * item lookup keyed by token-safe id so `:<id>:` always has one meaning.
 */
export interface EmojiCatalog {
  packs: EmojiPack[]
  imageByToken: Map<string, ImageEmojiItem>
}

/** Raw pack shape as parsed from JSON. */
interface RawPack {
  id?: unknown
  name?: unknown
  type?: unknown
  items?: unknown
}

/** Raw item shape as parsed from JSON. */
interface RawItem {
  id?: unknown
  name?: unknown
  content?: unknown
  src?: unknown
}

/** A catalog error with a stable reason for the retry UI. */
export type CatalogErrorReason =
  | 'invalid-root'
  | 'invalid-schema'
  | 'unsafe-image'
  | 'markup-in-text'
  | 'duplicate-id'
  | 'too-many-packs'
  | 'too-many-items'
  | 'oversized'
  | 'invalid-json'

export class CatalogError extends Error {
  readonly reason: CatalogErrorReason

  constructor(reason: CatalogErrorReason, message?: string) {
    super(message ?? `emoji catalog: ${reason}`)
    this.name = 'CatalogError'
    this.reason = reason
  }
}

/** Loader state surfaced to the picker. */
export type CatalogState = 'idle' | 'loading' | 'ready' | 'error'

/** UTF-16 code point count; emoji surrogate pairs count as one. */
function codePoints(value: string): number {
  return Array.from(value).length
}

/** Bounded ASCII token-safe id grammar shared by packs and items. */
const TOKEN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

/** Rejects NUL, CR/LF, and other C0/C1 control characters. */
function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0 || code === 0x0a || code === 0x0d || code < 0x20) return true
    if (code > 0x7e && code < 0xa0) return true
  }
  return false
}

/**
 * Detects an ASCII HTML tag shape: `<` immediately followed by a letter,
 * `/`, `!`, or `?`. Names/content containing one are rejected so a selected
 * item or rendered label can never be interpreted as markup.
 */
function hasHtmlTagShape(value: string): boolean {
  return /<[a-zA-Z/!?]/.test(value)
}

/** Validates a bounded token-safe id; rejects controls and markup shapes. */
function validTokenId(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  if (raw.length > 64) return false
  return TOKEN_ID_PATTERN.test(raw)
}

/** Validates a bounded label: non-empty after trim, ≤ limit code points. */
function validLabel(raw: unknown, limit: number): raw is string {
  if (typeof raw !== 'string') return false
  const label = raw.trim()
  if (label === '') return false
  if (codePoints(label) > limit) return false
  if (hasControlCharacters(label)) return false
  if (hasHtmlTagShape(label)) return false
  return true
}

/** Resolves a (possibly relative) image source against the catalog URL. */
function resolveImageUrl(src: string, catalogUrl: string): string {
  if (src === '') throw new CatalogError('unsafe-image')
  let resolved: URL
  try {
    resolved = new URL(src, catalogUrl)
  } catch {
    throw new CatalogError('unsafe-image')
  }
  if (resolved.protocol !== 'https:' || resolved.hostname === '') {
    throw new CatalogError('unsafe-image')
  }
  if (resolved.username !== '' || resolved.password !== '') {
    throw new CatalogError('unsafe-image')
  }
  resolved.hash = ''
  return resolved.toString()
}

/** Decodes a `unicode` or `emotion` item; rejects `src` and unexpected keys. */
function decodeTextItem(raw: RawItem): TextEmojiItem {
  const keys = Object.keys(raw)
  if (
    keys.length !== 3 ||
    keys.some((key) => !['id', 'name', 'content'].includes(key))
  ) {
    throw new CatalogError('invalid-schema')
  }
  if (!validTokenId(raw.id)) {
    throw new CatalogError('invalid-schema')
  }
  if (!validLabel(raw.name, EMOJI_MAX_ITEM_NAME)) {
    throw new CatalogError('invalid-schema')
  }
  if (typeof raw.content !== 'string') {
    throw new CatalogError('invalid-schema')
  }
  // 周边空白有意义，规范化时不做 trim。
  const content = raw.content
  if (codePoints(content) < 1 || codePoints(content) > EMOJI_MAX_CONTENT) {
    throw new CatalogError('invalid-schema')
  }
  if (hasControlCharacters(content)) {
    throw new CatalogError('invalid-schema')
  }
  if (hasHtmlTagShape(content)) {
    throw new CatalogError('markup-in-text')
  }
  return {
    kind: 'text',
    id: raw.id,
    name: raw.name.trim(),
    content,
    insertion: content,
  }
}

/** Decodes an `image` item; rejects `content` and unexpected keys. */
function decodeImageItem(raw: RawItem, catalogUrl: string): ImageEmojiItem {
  const keys = Object.keys(raw)
  if (
    keys.length !== 3 ||
    keys.some((key) => !['id', 'name', 'src'].includes(key))
  ) {
    throw new CatalogError('invalid-schema')
  }
  if (!validTokenId(raw.id)) {
    throw new CatalogError('invalid-schema')
  }
  if (!validLabel(raw.name, EMOJI_MAX_ITEM_NAME)) {
    throw new CatalogError('invalid-schema')
  }
  if (typeof raw.src !== 'string' || raw.src === '') {
    throw new CatalogError('invalid-schema')
  }
  if (
    raw.src.length > EMOJI_MAX_SRC ||
    hasControlCharacters(raw.src) ||
    hasHtmlTagShape(raw.src)
  ) {
    throw new CatalogError('unsafe-image')
  }
  const src = resolveImageUrl(raw.src, catalogUrl)
  return {
    kind: 'image',
    id: raw.id,
    name: raw.name.trim(),
    src,
    insertion: `:${raw.id}:`,
  }
}

/** Decodes one raw pack into a typed pack, or throws CatalogError. */
function decodePack(raw: RawPack, catalogUrl: string): EmojiPack {
  const keys = Object.keys(raw)
  if (
    keys.length !== 4 ||
    keys.some((key) => !['id', 'name', 'type', 'items'].includes(key))
  ) {
    throw new CatalogError('invalid-schema')
  }
  if (!validTokenId(raw.id)) {
    throw new CatalogError('invalid-schema')
  }
  if (!validLabel(raw.name, EMOJI_MAX_PACK_NAME)) {
    throw new CatalogError('invalid-schema')
  }
  if (
    raw.type !== 'unicode' &&
    raw.type !== 'emotion' &&
    raw.type !== 'image'
  ) {
    throw new CatalogError('invalid-schema')
  }
  if (!Array.isArray(raw.items)) {
    throw new CatalogError('invalid-schema')
  }
  if (raw.items.length > EMOJI_MAX_ITEMS_PER_PACK) {
    throw new CatalogError('too-many-items')
  }
  const type = raw.type
  const items: EmojiItem[] = []
  for (const rawItem of raw.items) {
    if (typeof rawItem !== 'object' || rawItem === null) {
      throw new CatalogError('invalid-schema')
    }
    const record = rawItem as RawItem
    items.push(
      type === 'image'
        ? decodeImageItem(record, catalogUrl)
        : decodeTextItem(record),
    )
  }
  return { id: raw.id, name: raw.name.trim(), type, items }
}

/**
 * Decodes a raw emoji-pack JSON document into a normalized catalog snapshot.
 * Structural, size, security, uniqueness, and schema failures reject the whole
 * document atomically; there is no partial-pack fallback.
 */
export function decodeEmojiDocument(
  raw: unknown,
  catalogUrl: string,
): EmojiCatalog {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CatalogError('invalid-root')
  }
  const record = raw as Record<string, unknown>
  const rootKeys = Object.keys(record)
  if (rootKeys.length !== 1 || rootKeys[0] !== 'packs') {
    throw new CatalogError('invalid-root')
  }
  if (!Array.isArray(record.packs)) {
    throw new CatalogError('invalid-schema')
  }
  if (record.packs.length > EMOJI_MAX_PACKS) {
    throw new CatalogError('too-many-packs')
  }
  const packIds = new Set<string>()
  const itemIds = new Set<string>()
  const imageByToken = new Map<string, ImageEmojiItem>()
  const packs: EmojiPack[] = []
  let total = 0
  for (const rawPack of record.packs) {
    if (typeof rawPack !== 'object' || rawPack === null) {
      throw new CatalogError('invalid-schema')
    }
    const pack = decodePack(rawPack as RawPack, catalogUrl)
    if (packIds.has(pack.id)) {
      throw new CatalogError('duplicate-id', `duplicate pack id ${pack.id}`)
    }
    packIds.add(pack.id)
    total += pack.items.length
    if (total > EMOJI_MAX_TOTAL_ITEMS) {
      throw new CatalogError('too-many-items')
    }
    for (const item of pack.items) {
      if (itemIds.has(item.id)) {
        throw new CatalogError('duplicate-id', `duplicate item id ${item.id}`)
      }
      itemIds.add(item.id)
      if (item.kind === 'image') {
        imageByToken.set(item.id, item)
      }
    }
    packs.push(pack)
  }
  return { packs, imageByToken }
}

/** Validates a configured catalog URL before fetching. */
export function isValidEmojiCatalogUrl(raw: string): boolean {
  const value = raw.trim()
  if (value === '') return false
  if (value.length > 2048) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    url.hostname !== '' &&
    url.username === '' &&
    url.password === '' &&
    url.hash === ''
  )
}

/** Fetch options used for catalog requests; never credentialed. */
export interface EmojiCatalogFetchOptions {
  url: string
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * Loads and decodes the remote emoji-pack catalog. Failures throw
 * CatalogError with a stable reason; the caller surfaces the error and offers
 * retry.
 */
export async function loadEmojiCatalog(
  options: EmojiCatalogFetchOptions,
): Promise<EmojiCatalog> {
  const url = options.url.trim()
  if (!isValidEmojiCatalogUrl(url)) {
    throw new CatalogError('invalid-schema', 'catalog url is invalid')
  }
  const controller = new AbortController()
  const timeout = window.setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? EMOJI_FETCH_TIMEOUT_MS,
  )
  const onOuterAbort = () => controller.abort()
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })
  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    })
  } catch {
    throw new CatalogError('invalid-json', 'catalog request failed')
  } finally {
    window.clearTimeout(timeout)
    options.signal?.removeEventListener('abort', onOuterAbort)
  }
  if (!response.ok) {
    throw new CatalogError(
      'invalid-json',
      `catalog request failed (${response.status})`,
    )
  }
  // The final redirect destination must stay HTTPS.
  try {
    const finalUrl = new URL(response.url)
    if (
      finalUrl.protocol !== 'https:' ||
      finalUrl.username !== '' ||
      finalUrl.password !== ''
    ) {
      throw new CatalogError('invalid-json', 'catalog redirect left https')
    }
  } catch (error) {
    if (error instanceof CatalogError) throw error
    throw new CatalogError('invalid-json', 'catalog response url is invalid')
  }
  let text: string
  try {
    text = await readBounded(response)
  } catch (error) {
    if (error instanceof CatalogError) throw error
    throw new CatalogError('invalid-json', 'catalog body read failed')
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new CatalogError('invalid-json')
  }
  return decodeEmojiDocument(raw, response.url)
}

/** Reads a response body bounded to the catalog payload cap. */
async function readBounded(response: Response): Promise<string> {
  const length = Number(response.headers.get('Content-Length') ?? 0)
  if (length > EMOJI_MAX_PAYLOAD_BYTES) {
    throw new CatalogError('oversized')
  }
  if (response.body) {
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > EMOJI_MAX_PAYLOAD_BYTES) {
          await reader.cancel().catch(() => undefined)
          throw new CatalogError('oversized')
        }
        chunks.push(value)
      }
    }
    return new TextDecoder().decode(concatBytes(chunks))
  }
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > EMOJI_MAX_PAYLOAD_BYTES) {
    throw new CatalogError('oversized')
  }
  return text
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
