import { describe, expect, it } from 'vitest'

import {
  acceptAuthorizationMessage,
  authorizationUrl,
  generateRequestId,
} from '../src/popup'

describe('generateRequestId', () => {
  it('produces a high-entropy base64url request id', () => {
    const requestId = generateRequestId()
    expect(requestId).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(requestId).not.toContain('+')
    expect(requestId).not.toContain('/')
    expect(requestId).not.toContain('=')
  })

  it('supports an injected random source for deterministic tests', () => {
    const fixed = new Uint8Array(16).fill(1)
    const requestId = generateRequestId(() => fixed)
    expect(requestId).toBe('AQEBAQEBAQEBAQEBAQEBAQ')
    expect(requestId).toHaveLength(22)
  })
})

describe('acceptAuthorizationMessage', () => {
  function event(
    data: unknown,
    origin: string,
    source: MessageEventSource | null,
  ): MessageEvent {
    return { data, origin, source } as MessageEvent
  }

  const expected = {
    expectedOrigin: 'https://comments.example',
    expectedSource: {} as Window,
    requestId: 'req-1',
  }

  it('accepts a matching success message', () => {
    const message = acceptAuthorizationMessage(
      event(
        {
          type: 'furtalk:authorization-success',
          request_id: 'req-1',
          code: 'code',
        },
        'https://comments.example',
        expected.expectedSource,
      ),
      expected,
    )
    expect(message?.type).toBe('furtalk:authorization-success')
  })

  it('rejects a wrong origin', () => {
    expect(
      acceptAuthorizationMessage(
        event(
          { type: 'furtalk:authorization-ready', request_id: 'req-1' },
          'https://evil.example',
          expected.expectedSource,
        ),
        expected,
      ),
    ).toBeNull()
  })

  it('rejects a wrong source', () => {
    expect(
      acceptAuthorizationMessage(
        event(
          { type: 'furtalk:authorization-ready', request_id: 'req-1' },
          'https://comments.example',
          {} as Window,
        ),
        expected,
      ),
    ).toBeNull()
  })

  it('rejects a mismatched request_id', () => {
    expect(
      acceptAuthorizationMessage(
        event(
          { type: 'furtalk:authorization-ready', request_id: 'other' },
          'https://comments.example',
          expected.expectedSource,
        ),
        expected,
      ),
    ).toBeNull()
  })

  it('rejects an invalid schema', () => {
    expect(
      acceptAuthorizationMessage(
        event(
          { type: 'furtalk:evil', request_id: 'req-1' },
          'https://comments.example',
          expected.expectedSource,
        ),
        expected,
      ),
    ).toBeNull()
  })

  it('accepts init messages that carry the optional email hint', () => {
    const message = acceptAuthorizationMessage(
      event(
        {
          type: 'furtalk:authorization-init',
          request_id: 'req-1',
          email: 'a@b.example',
        },
        'https://embed.example',
        expected.expectedSource,
      ),
      { ...expected, expectedOrigin: 'https://embed.example' },
    )
    expect(message?.type).toBe('furtalk:authorization-init')
  })
})

describe('authorizationUrl', () => {
  it('carries only site_id and request_id', () => {
    const url = authorizationUrl('https://comments.example', '123', 'req-1')
    expect(url).toBe(
      'https://comments.example/authorize?site_id=123&request_id=req-1',
    )
  })
})
