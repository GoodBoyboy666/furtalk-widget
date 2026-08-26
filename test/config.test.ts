import { describe, expect, it } from 'vitest'

import { parseWidgetConfig } from '../src/config'

const location = { pathname: '/articles/hello', search: '' }
const defaultOrigin = 'https://comments.example'

describe('parseWidgetConfig', () => {
  it('parses the required attributes', () => {
    const config = parseWidgetConfig(
      { 'site-id': '123', 'page-key': 'article-1' },
      location,
      defaultOrigin,
    )
    expect(config).toEqual({
      siteId: '123',
      pageKey: 'article-1',
      serviceOrigin: 'https://comments.example',
    })
  })

  it('derives the page key from location for the opt-in value', () => {
    const config = parseWidgetConfig(
      { 'site-id': '123', 'page-key': 'location' },
      { pathname: '/a/b', search: '?x=1' },
      defaultOrigin,
    )
    expect(config && 'pageKey' in config && config.pageKey).toBe('/a/b?x=1')
  })

  it('keeps overridable page-url and page-title attributes', () => {
    const config = parseWidgetConfig(
      {
        'site-id': '123',
        'page-key': 'article-1',
        'page-url': 'https://host.example/article-1',
        'page-title': 'Hello',
        'service-origin': 'https://cdn.comments.example',
      },
      location,
      defaultOrigin,
    )
    expect(config).toEqual({
      siteId: '123',
      pageKey: 'article-1',
      pageUrl: 'https://host.example/article-1',
      pageTitle: 'Hello',
      serviceOrigin: 'https://cdn.comments.example',
    })
  })

  it('defaults page-url and page-title to the host document values', () => {
    const config = parseWidgetConfig(
      { 'site-id': '123', 'page-key': 'article-1' },
      location,
      defaultOrigin,
      { href: 'https://host.example/articles/hello', title: 'Hello World' },
    )
    expect(config).toMatchObject({
      siteId: '123',
      pageKey: 'article-1',
      pageUrl: 'https://host.example/articles/hello',
      pageTitle: 'Hello World',
      serviceOrigin: 'https://comments.example',
    })
  })

  it('prefers explicit attributes over document defaults', () => {
    const config = parseWidgetConfig(
      {
        'site-id': '123',
        'page-key': 'article-1',
        'page-url': 'https://host.example/override',
      },
      location,
      defaultOrigin,
      { href: 'https://host.example/articles/hello', title: 'Hello World' },
    )
    expect(config).toMatchObject({
      pageUrl: 'https://host.example/override',
      pageTitle: 'Hello World',
    })
  })

  it('rejects a missing or non-decimal site-id', () => {
    expect(
      parseWidgetConfig({ 'page-key': 'k' }, location, defaultOrigin),
    ).toEqual({ code: 'invalid_site_id' })
    expect(
      parseWidgetConfig(
        { 'site-id': '0', 'page-key': 'k' },
        location,
        defaultOrigin,
      ),
    ).toEqual({ code: 'invalid_site_id' })
    expect(
      parseWidgetConfig(
        { 'site-id': 'abc', 'page-key': 'k' },
        location,
        defaultOrigin,
      ),
    ).toEqual({ code: 'invalid_site_id' })
  })

  it('rejects a missing or overlong page-key', () => {
    expect(
      parseWidgetConfig({ 'site-id': '123' }, location, defaultOrigin),
    ).toEqual({ code: 'missing_page_key' })
    expect(
      parseWidgetConfig(
        { 'site-id': '123', 'page-key': 'x'.repeat(513) },
        location,
        defaultOrigin,
      ),
    ).toEqual({ code: 'page_key_too_long', params: { max: 512 } })
  })

  it('rejects an invalid service-origin', () => {
    expect(
      parseWidgetConfig(
        {
          'site-id': '123',
          'page-key': 'k',
          'service-origin': 'http://evil.example',
        },
        location,
        defaultOrigin,
      ),
    ).toEqual({ code: 'invalid_service_origin' })
  })
})
