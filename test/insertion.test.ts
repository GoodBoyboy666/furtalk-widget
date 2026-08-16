import { describe, expect, it } from 'vitest'

import { insertAtSelection } from '../src/insertion'

describe('insertAtSelection', () => {
  it('inserts at the caret position', () => {
    const result = insertAtSelection('hello', 5, 5, '→_→')
    expect(result).toEqual({ next: 'hello→_→', caret: 8 })
  })

  it('replaces the selected text preserving surrounding content', () => {
    const result = insertAtSelection('say [X] now', 4, 7, '😀')
    // setSelectionRange 使用 UTF-16 码元，因此代理对 emoji 计为 2。
    expect(result).toEqual({ next: 'say 😀 now', caret: 6 })
  })

  it('clamps out-of-range selection to the body bounds', () => {
    expect(insertAtSelection('abc', 99, 99, 'x')).toEqual({
      next: 'abcx',
      caret: 4,
    })
    expect(insertAtSelection('abc', -2, 1, 'x')).toEqual({
      next: 'xbc',
      caret: 1,
    })
  })

  it('inserts an empty string without changing the body', () => {
    expect(insertAtSelection('abc', 1, 2, '')).toEqual({
      next: 'ac',
      caret: 1,
    })
  })
})
