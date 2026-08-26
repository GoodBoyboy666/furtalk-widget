/**
 * Furtalk 维护的远程表情包目录。
 *
 * 目录内容始终由部署方通过实例级 `emoji_catalog_url` 设置提供并获得授权；
 * 本项目不分发任何表情数据。
 * 协议规范见 `research/emoji-pack-protocol.md`（根为 `{ packs: EmojiPack[] }`，
 * 包类型为 `unicode | emotion | image` 三者之一）。
 *
 * 本模块是原始目录数据处理的唯一入口。原始数据类型为 `unknown`；
 * 规范化后的包包含带类型的条目与精确的插入文本。
 * UI 与渲染代码只使用规范化后的 `EmojiCatalog`（以及派生的图片查找表），
 * 不会直接读取远程返回的字段。
 */

/** 目录与载荷的有界上限（Furtalk 防御性默认值）。 */
export const EMOJI_MAX_PAYLOAD_BYTES = 512 * 1024
export const EMOJI_MAX_PACKS = 32
export const EMOJI_MAX_ITEMS_PER_PACK = 256
export const EMOJI_MAX_TOTAL_ITEMS = 1024
export const EMOJI_MAX_PACK_NAME = 64
export const EMOJI_MAX_ITEM_NAME = 128
export const EMOJI_MAX_CONTENT = 256
export const EMOJI_MAX_SRC = 2048
export const EMOJI_FETCH_TIMEOUT_MS = 5000

/** Furtalk 表情包协议定义的包类型。 */
export type EmojiPackType = 'unicode' | 'emotion' | 'image'

/** 来自 `unicode` 或 `emotion` 包的规范化文本类条目。 */
export interface TextEmojiItem {
  kind: 'text'
  /** 稳定的 id，可安全用作令牌；不可当作可信标记。 */
  id: string
  /** 人类可读的标签，用于无障碍名称 / 提示。 */
  name: string
  /** 精确的插入文本：即 `content` 字段的原样值。 */
  content: string
  insertion: string
}

/** 来自 `image` 包的规范化图片条目。 */
export interface ImageEmojiItem {
  kind: 'image'
  /** 稳定的 id，可安全用作令牌；`:<id>:` 既是插入文本也是渲染令牌。 */
  id: string
  /** 人类可读的标签，用作无障碍名称。 */
  name: string
  /** 绝对 HTTPS 图片 URL，基于目录响应 URL 解析。 */
  src: string
  /** 精确的插入文本：始终为 `:<id>:`。 */
  insertion: string
}

export type EmojiItem = TextEmojiItem | ImageEmojiItem

/** 规范化后的表情包，包含带类型的条目。 */
export interface EmojiPack {
  id: string
  name: string
  type: EmojiPackType
  items: EmojiItem[]
}

/**
 * 规范化后的目录快照。选择器与渲染器使用同一份成功解码的快照；
 * `imageByToken` 是按 id 建立的全局图片查找表，保证 `:<id>:` 始终只有一个含义。
 */
export interface EmojiCatalog {
  packs: EmojiPack[]
  imageByToken: Map<string, ImageEmojiItem>
}

/** 从 JSON 解析出的原始包形状。 */
interface RawPack {
  id?: unknown
  name?: unknown
  type?: unknown
  items?: unknown
}

/** 从 JSON 解析出的原始条目形状。 */
interface RawItem {
  id?: unknown
  name?: unknown
  content?: unknown
  src?: unknown
}

/** 目录加载错误，带有稳定的原因标识，供重试界面使用。 */
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

/** 展示给选择器的加载状态。 */
export type CatalogState = 'idle' | 'loading' | 'ready' | 'error'

/** UTF-16 码点计数；代理对（surrogate pair）按一个字符计。 */
function codePoints(value: string): number {
  return Array.from(value).length
}

/** 包与条目共用的 id 语法，限 ASCII 且可安全用作令牌。 */
const TOKEN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

/** 拒绝 NUL、CR/LF 及其他 C0/C1 控制字符。 */
function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code === 0 || code === 0x0a || code === 0x0d || code < 0x20) return true
    if (code > 0x7e && code < 0xa0) return true
  }
  return false
}

/**
 * 检测 ASCII HTML 标签形态：`<` 后紧跟字母、`/`、`!` 或 `?`。
 * 名称/内容含此形态即被拒绝，确保选中的条目或渲染出的标签绝不会被当作 HTML 解析。
 */
function hasHtmlTagShape(value: string): boolean {
  return /<[a-zA-Z/!?]/.test(value)
}

/** 校验 id（限长、可安全用作令牌）；拒绝控制字符与标记形态。 */
function validTokenId(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  if (raw.length > 64) return false
  return TOKEN_ID_PATTERN.test(raw)
}

/** 校验长度受限的标签：去除首尾空格后非空，且码点数量不超过上限。 */
function validLabel(raw: unknown, limit: number): raw is string {
  if (typeof raw !== 'string') return false
  const label = raw.trim()
  if (label === '') return false
  if (codePoints(label) > limit) return false
  if (hasControlCharacters(label)) return false
  if (hasHtmlTagShape(label)) return false
  return true
}

/** 将图片地址（可为相对路径）基于目录 URL 解析为绝对地址。 */
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

/** 解码 `unicode` 或 `emotion` 条目；拒绝 `src` 等未预期字段。 */
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
  // 周边空白有意义，规范化时不去除首尾空格。
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

/** 解码 `image` 条目；拒绝 `content` 等未预期字段。 */
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

/** 把一个原始包解码为带类型的包；失败时抛出 CatalogError。 */
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
 * 把原始表情包 JSON 文档解码为规范化目录快照。
 * 结构、大小、安全性、唯一性或协议上的任何失败都会整体拒绝该文档；
 * 不会出现部分包可用的情况。
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

/** 校验配置的目录 URL 后再发起请求。 */
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

/** 目录请求使用的 fetch 选项；绝不携带凭据。 */
export interface EmojiCatalogFetchOptions {
  url: string
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/**
 * 加载并解码远程表情包目录。失败抛出带稳定原因的 CatalogError；
 * 调用方展示错误并提供重试。
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
  // 最终重定向目的地必须保持 HTTPS。
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

/** 读取响应体，大小不超过目录载荷上限。 */
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
