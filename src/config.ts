/**
 * Page configuration parsing for the <furtalk-comments> element.
 *
 * `site-id` is required. `page-key` is required by default; the explicit value
 * `"location"` derives a stable key from location.pathname + location.search.
 * `page-url` / `page-title` default to the host document values and remain
 * overridable attributes. `service-origin` is optional; the element supplies
 * its default from import.meta.url.
 */

export interface WidgetConfig {
  siteId: string
  pageKey: string
  pageUrl?: string
  pageTitle?: string
  serviceOrigin: string
}

export interface ConfigError {
  error: string
}

export const MAX_PAGE_KEY_LENGTH = 512

const DECIMAL_ID = /^[1-9][0-9]*$/

/** Reports whether the value is an absolute https origin (http localhost allowed for dev). */
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
    return { error: 'site-id must be a positive decimal integer' }
  }

  let pageKey = (attrs['page-key'] ?? '').trim()
  if (pageKey === 'location') {
    pageKey = `${location.pathname}${location.search}`
  }
  if (pageKey === '') {
    return {
      error:
        'page-key is required (use "location" to derive it from the current page)',
    }
  }
  if (pageKey.length > MAX_PAGE_KEY_LENGTH) {
    return {
      error: `page-key must not exceed ${MAX_PAGE_KEY_LENGTH} characters`,
    }
  }

  // page-url / page-title default to the host document values; explicit
  // attributes always win.
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
    return { error: 'service-origin must be an absolute https origin' }
  }

  return { siteId, pageKey, pageUrl, pageTitle, serviceOrigin }
}
