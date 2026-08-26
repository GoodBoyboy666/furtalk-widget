import { describe, expect, it } from 'vitest'

import { isAuthorizationMessage } from '../src/types'

describe('isAuthorizationMessage', () => {
  it('accepts well-formed init with an optional email hint', () => {
    expect(
      isAuthorizationMessage({
        type: 'furtalk:authorization-init',
        request_id: 'abc',
        email: 'a@b.example',
      }),
    ).toBe(true)
  })

  it('accepts init without hints', () => {
    expect(
      isAuthorizationMessage({
        type: 'furtalk:authorization-init',
        request_id: 'abc',
      }),
    ).toBe(true)
  })

  it('ignores legacy nickname/website fields on init messages', () => {
    // 授权协议不再传输昵称/网站；旧 widget 载荷仍可解码，因为协议只读取自己定义的
    // 字段（request_id 与可选 email）。
    expect(
      isAuthorizationMessage({
        type: 'furtalk:authorization-init',
        request_id: 'abc',
        email: 'a@b.example',
        nickname: 'Alice',
        website_url: 'https://example.com',
      }),
    ).toBe(true)
  })

  it('accepts ready, success and cancelled', () => {
    expect(
      isAuthorizationMessage({
        type: 'furtalk:authorization-ready',
        request_id: 'abc',
      }),
    ).toBe(true)
    expect(
      isAuthorizationMessage({
        type: 'furtalk:authorization-success',
        request_id: 'abc',
        code: 'code-1',
      }),
    ).toBe(true)
    expect(
      isAuthorizationMessage({
        type: 'furtalk:authorization-cancelled',
        request_id: 'abc',
      }),
    ).toBe(true)
  })

  it('rejects non-objects and missing request_id', () => {
    expect(isAuthorizationMessage(null)).toBe(false)
    expect(isAuthorizationMessage('furtalk:authorization-ready')).toBe(false)
    expect(
      isAuthorizationMessage({ type: 'furtalk:authorization-ready' }),
    ).toBe(false)
    expect(
      isAuthorizationMessage({
        type: 'furtalk:authorization-ready',
        request_id: '',
      }),
    ).toBe(false)
  })

  it('rejects unknown types and wrong field shapes', () => {
    expect(
      isAuthorizationMessage({ type: 'furtalk:evil', request_id: 'abc' }),
    ).toBe(false)
    expect(
      isAuthorizationMessage({
        type: 'furtalk:authorization-init',
        request_id: 'abc',
        email: 42,
      }),
    ).toBe(false)
    expect(
      isAuthorizationMessage({
        type: 'furtalk:authorization-success',
        request_id: 'abc',
      }),
    ).toBe(false)
    expect(
      isAuthorizationMessage({
        type: 'furtalk:authorization-success',
        request_id: 'abc',
        code: '',
      }),
    ).toBe(false)
  })
})
