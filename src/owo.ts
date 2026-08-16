/**
 * OwO-compatible remote expression catalog boundary.
 *
 * The catalog content is always supplied and licensed by the deployer through
 * the instance-wide `owo_catalog_url` setting; this project distributes no
 * expression data. Furtalk never installs or executes the upstream `owo`
 * runtime: its XHR, global DOM queries, `innerHTML` building and
 * page-stylesheet model conflict with the Widget's typed Lit rendering and
 * Shadow DOM boundary.
 *
 * This module is the SINGLE owner of raw catalog payload handling. Raw source
 * types are `unknown`; normalized groups carry a closed `emoticon | emoji |
 * image` kind and exact insertion strings. UI code consumes only the
 * normalized `EmojiGroup[]` and never casts remote payload fields.
 */

/** Bounded catalog and payload limits (Furtalk defensive defaults). */
export const OWO_MAX_PAYLOAD_BYTES = 512 * 1024
export const OWO_MAX_GROUPS = 32
export const OWO_MAX_ITEMS_PER_GROUP = 256
export const OWO_MAX_TOTAL_ITEMS = 1024
export const OWO_MAX_GROUP_LABEL = 64
export const OWO_MAX_ITEM_LABEL = 128
export const OWO_MAX_INSERTION = 256
export const OWO_FETCH_TIMEOUT_MS = 5000

/** Closed kind union compatible with the OwO Data API. */
export type OwOKind = 'emoticon' | 'emoji' | 'image'

/** A normalized expression item; consumers render only these fields. */
export interface EmojiItem {
  kind: OwOKind
  /** Accessible name / tooltip derived from the raw `text`, icon, or fallback. */
  label: string
  /** Exact insertion string: literal text/emoji or safe Markdown image syntax. */
  insertion: string
  /** Raw icon used for the picker preview; rendered as escaped Lit text. */
  display?: string
  /** Image preview source; only present for `image` items, always absolute HTTPS. */
  imageUrl?: string
}

/** A normalized expression group. */
export interface EmojiGroup {
  /** Locally generated id, never trusted markup. */
  id: string
  label: string
  kind: OwOKind
  items: EmojiItem[]
}

/** Raw OwO Data API group shape as parsed from JSON. */
interface RawGroup {
  type?: unknown
  container?: unknown
}

/** Parsed image `<img>` tag details. */
interface ParsedImageTag {
  src: string
}

/** A catalog error with a stable reason for the retry UI. */
export type CatalogErrorReason =
  | 'invalid-root'
  | 'invalid-schema'
  | 'unsafe-image'
  | 'markup-in-text'
  | 'too-many-groups'
  | 'too-many-items'
  | 'oversized'
  | 'invalid-json'

export class CatalogError extends Error {
  readonly reason: CatalogErrorReason

  constructor(reason: CatalogErrorReason, message?: string) {
    super(message ?? `owo catalog: ${reason}`)
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
 * `/`, `!`, or `?`. Text/emoji icons containing one are rejected so a
 * selected item cannot create a body the backend would reject as raw HTML.
 */
function hasHtmlTagShape(value: string): boolean {
  return /<[a-zA-Z/!?]/.test(value)
}

/** Parses a single `<img src="...">` tag; returns null when malformed. */
function parseImageTag(raw: string): ParsedImageTag | null {
  const trimmed = raw.trim()
  if (!/^<img\b/i.test(trimmed) || !trimmed.endsWith('>')) return null
  const srcMatch = /<img\b[^>]*\bsrc\s*=\s*"([^"]*)"[^>]*>/i.exec(trimmed)
  if (!srcMatch) return null
  // A trailing `>` immediately closes the tag; anything after it is a child
  // node, which the official narrow form never has.
  if (trimmed.slice(srcMatch.index + srcMatch[0].length).trim() !== '') {
    return null
  }
  const src = srcMatch[1]
  if (src === undefined) return null
  return { src }
}

/** Resolves a (possibly protocol-relative) image source against the catalog URL. */
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

/** Escapes Markdown metacharacters so an insertion renders as literal text. */
function escapeMarkdownText(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>~=]/g, (match) => `\\${match}`)
}

/** Percent-encodes characters that would break a Markdown destination. */
function encodeMarkdownDestination(url: string): string {
  return url.replace(
    /[()\\\s<>\u0000-\u001f\u007f]/g,
    (char) =>
      `%${char.codePointAt(0)?.toString(16).toUpperCase().padStart(2, '0')}`,
  )
}

/** Builds safe Markdown image syntax from an image item. */
export function buildImageMarkdown(label: string, imageUrl: string): string {
  const escapedLabel = label.replace(/[[\]]/g, (match) => `\\${match}`)
  return `![${escapedLabel}](${encodeMarkdownDestination(imageUrl)})`
}

function validKind(raw: unknown): raw is OwOKind {
  return raw === 'emoticon' || raw === 'emoji' || raw === 'image'
}

/**
 * Normalizes one raw group into a typed group, or throws CatalogError on a
 * structural or security rule failure.
 */
function normalizeGroup(
  groupName: string,
  raw: RawGroup,
  catalogUrl: string,
  groupIndex: number,
): EmojiGroup {
  const label = groupName.trim()
  if (label === '' || codePoints(label) > OWO_MAX_GROUP_LABEL) {
    throw new CatalogError('invalid-schema')
  }
  if (!validKind(raw.type) || !Array.isArray(raw.container)) {
    throw new CatalogError('invalid-schema')
  }
  if (raw.container.length > OWO_MAX_ITEMS_PER_GROUP) {
    throw new CatalogError('too-many-items')
  }
  const kind = raw.type
  const items: EmojiItem[] = []
  for (const rawItem of raw.container) {
    if (typeof rawItem !== 'object' || rawItem === null) {
      throw new CatalogError('invalid-schema')
    }
    const record = rawItem as Record<string, unknown>
    if (typeof record.icon !== 'string' || typeof record.text !== 'string') {
      throw new CatalogError('invalid-schema')
    }
    const icon = record.icon.trim()
    const text = record.text.trim()
    if (icon === '' || hasControlCharacters(icon)) {
      throw new CatalogError('invalid-schema')
    }
    if (hasControlCharacters(text)) {
      throw new CatalogError('invalid-schema')
    }
    if (codePoints(text) > OWO_MAX_ITEM_LABEL) {
      throw new CatalogError('invalid-schema')
    }
    if (kind === 'image') {
      const tag = parseImageTag(record.icon)
      // 非 img 标签形态一律视为纯 URL 扩展；含 <>/空格则拒绝，
      // 防止把畸形标记当作普通相对路径解析。
      if (!tag && /[<>\s]/.test(record.icon)) {
        throw new CatalogError('unsafe-image')
      }
      const src = tag ? tag.src : icon
      const imageUrl = resolveImageUrl(src, catalogUrl)
      if (codePoints(imageUrl) > OWO_MAX_INSERTION) {
        throw new CatalogError('unsafe-image')
      }
      const labelText = text !== '' ? text : '图片表情'
      items.push({
        kind: 'image',
        label: labelText,
        insertion: buildImageMarkdown(labelText, imageUrl),
        imageUrl,
      })
      continue
    }
    if (codePoints(icon) > OWO_MAX_INSERTION) {
      throw new CatalogError('invalid-schema')
    }
    if (hasHtmlTagShape(icon)) {
      throw new CatalogError('markup-in-text')
    }
    items.push({
      kind,
      label: text !== '' ? text : icon,
      insertion: escapeMarkdownText(icon),
      display: icon,
    })
  }
  return { id: `custom-${groupIndex}`, label, kind, items }
}

/**
 * Decodes a raw OwO JSON document into typed groups. Structural, size,
 * security, and schema failures reject the whole document atomically.
 */
export function decodeCatalog(raw: unknown, catalogUrl: string): EmojiGroup[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new CatalogError('invalid-root')
  }
  const groups = Object.entries(raw as Record<string, unknown>)
  if (groups.length > OWO_MAX_GROUPS) {
    throw new CatalogError('too-many-groups')
  }
  const result: EmojiGroup[] = []
  let total = 0
  for (let index = 0; index < groups.length; index += 1) {
    const entry = groups[index]
    if (!entry) continue
    const [groupName, rawGroup] = entry
    if (typeof rawGroup !== 'object' || rawGroup === null) {
      throw new CatalogError('invalid-schema')
    }
    const group = normalizeGroup(
      groupName,
      rawGroup as RawGroup,
      catalogUrl,
      index,
    )
    total += group.items.length
    if (total > OWO_MAX_TOTAL_ITEMS) {
      throw new CatalogError('too-many-items')
    }
    result.push(group)
  }
  return result
}

/** Validates a configured catalog URL before fetching. */
export function isValidCatalogUrl(raw: string): boolean {
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
export interface CatalogFetchOptions {
  url: string
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * Loads and decodes the remote catalog. Failures throw CatalogError with a
 * stable reason; the caller surfaces the error and offers retry.
 */
export async function loadCatalog(
  options: CatalogFetchOptions,
): Promise<EmojiGroup[]> {
  const url = options.url.trim()
  if (!isValidCatalogUrl(url)) {
    throw new CatalogError('invalid-schema', 'catalog url is invalid')
  }
  const controller = new AbortController()
  const timeout = window.setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? OWO_FETCH_TIMEOUT_MS,
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
  return decodeCatalog(raw, response.url)
}

/** Reads a response body bounded to the catalog payload cap. */
async function readBounded(response: Response): Promise<string> {
  const length = Number(response.headers.get('Content-Length') ?? 0)
  if (length > OWO_MAX_PAYLOAD_BYTES) {
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
        if (total > OWO_MAX_PAYLOAD_BYTES) {
          await reader.cancel().catch(() => undefined)
          throw new CatalogError('oversized')
        }
        chunks.push(value)
      }
    }
    return new TextDecoder().decode(concatBytes(chunks))
  }
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > OWO_MAX_PAYLOAD_BYTES) {
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
