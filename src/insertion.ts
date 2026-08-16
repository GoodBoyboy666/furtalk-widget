/**
 * Pure selection-replacement helpers for composer insertion.
 *
 * The element reads `selectionStart`/`selectionEnd` from the owning textarea,
 * computes the next body and caret position here, updates only that composer's
 * draft, then restores focus and the collapsed selection after a Lit update.
 */

export interface InsertionResult {
  next: string
  caret: number
}

/** Replaces [start, end) of `body` with `insertion`, returning the next body. */
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
