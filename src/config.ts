/**
 * <furtalk-comments> Element页面的配置解析。
 *
 * `site-id` 必填。`page-key` 默认必填；显式值 `"location"` 会从
 * location.pathname + location.search 推导稳定的键。
 * `page-url` / `page-title` 默认取宿主文档的值，且仍可作为属性覆盖。
 * `service-origin` 可选；不填时元素从 import.meta.url 取默认值。
 */

export interface WidgetConfig {
  siteId: string
  pageKey: string
  pageUrl?: string
  pageTitle?: string
  serviceOrigin: string
}

/**
 * 稳定的配置错误代码及可选参数。展示时由Element将代码翻译成当前语言；
 * 此处不生成任何提示文字。
 */
export type ConfigErrorCode =
  | 'invalid_site_id'
  | 'missing_page_key'
  | 'page_key_too_long'
  | 'invalid_service_origin'

export interface ConfigError {
  code: ConfigErrorCode
  params?: Record<string, string | number>
}

export const MAX_PAGE_KEY_LENGTH = 512

const DECIMAL_ID = /^[1-9][0-9]*$/

/** 报告值是否为绝对 https 源（开发环境允许 http localhost）。 */
export function isServiceOrigin(raw: string): boolean {
  if (!raw) return false
  try {
    const url = new URL(raw)
    if (url.origin !== raw) return false
    if (url.protocol === 'https:') return true
    if (url.protocol === 'http:') {
      const host = url.hostname
      return host === 'localhost' || host === '127.0.0.1' || host === '::1'
    }
    return false
  } catch {
    return false
  }
}

export function parseWidgetConfig(
  attrs: Record<string, string | null>,
  location: { pathname: string; search: string },
  defaultServiceOrigin: string,
  documentDefaults?: { href: string; title: string },
): WidgetConfig | ConfigError {
  const siteId = (attrs['site-id'] ?? '').trim()
  if (!DECIMAL_ID.test(siteId)) {
    return { code: 'invalid_site_id' }
  }

  let pageKey = (attrs['page-key'] ?? '').trim()
  if (pageKey === 'location') {
    pageKey = `${location.pathname}${location.search}`
  }
  if (pageKey === '') {
    return { code: 'missing_page_key' }
  }
  if (pageKey.length > MAX_PAGE_KEY_LENGTH) {
    return {
      code: 'page_key_too_long',
      params: { max: MAX_PAGE_KEY_LENGTH },
    }
  }

  // page-url / page-title 默认取宿主文档的值；显式属性始终优先。
  const pageUrl =
    (attrs['page-url'] ?? '').trim() ||
    documentDefaults?.href.trim() ||
    undefined
  const pageTitle =
    (attrs['page-title'] ?? '').trim() ||
    documentDefaults?.title.trim() ||
    undefined

  const serviceOrigin =
    (attrs['service-origin'] ?? '').trim() || defaultServiceOrigin
  if (!isServiceOrigin(serviceOrigin)) {
    return { code: 'invalid_service_origin' }
  }

  return { siteId, pageKey, pageUrl, pageTitle, serviceOrigin }
}
