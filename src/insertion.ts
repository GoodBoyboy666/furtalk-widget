/**
 * 编辑器插入时使用的选择区替换辅助函数。
 *
 * 元素从所属 textarea 读取 `selectionStart`/`selectionEnd`，在此计算出新正文
 * 与光标位置，只更新该编辑器的草稿，然后在 Lit 更新后恢复焦点与光标位置。
 */

export interface InsertionResult {
  next: string
  caret: number
}

/** 用 `insertion` 替换 `body` 的 [start, end) 区间，返回下一段正文。 */
export function insertAtSelection(
  body: string,
  start: number,
  end: number,
  insertion: string,
): InsertionResult {
  const from = Math.max(0, Math.min(start, body.length))
  const to = Math.max(from, Math.min(end, body.length))
  const next = body.slice(0, from) + insertion + body.slice(to)
  return { next, caret: from + insertion.length }
}
