/**
 * Flat comment page merging and nested reply projection.
 *
 * The server returns a flat (created_at, id) ordered list. Pages are merged by
 * comment id before the nested reply tree is rebuilt so cursor loads never
 * duplicate comments or reorder the visible thread.
 */

import type { Comment, CommentSort, WidgetSession } from './types'

export interface CommentNode extends Comment {
  children: CommentNode[]
}

/**
 * Stable ordering comparison used by the nested reply tree.
 *
 * Directional modes sort by `(created_at, id)` ascending or descending. Hot
 * sorts by the comment's own Like count descending, with `(created_at, id)`
 * descending as the deterministic tie-breaker — matching the server keyset.
 * Descendant Likes are never aggregated into an ancestor.
 */
export function compareComments(
  a: Comment,
  b: Comment,
  sort: CommentSort = 'asc',
): number {
  if (sort === 'hot') {
    const aCount = a.like_count ?? 0
    const bCount = b.like_count ?? 0
    if (aCount !== bCount) return aCount < bCount ? 1 : -1
    const aTime = Date.parse(a.created_at)
    const bTime = Date.parse(b.created_at)
    if (aTime !== bTime) return aTime < bTime ? 1 : -1
    return compareDecimalId(b.id, a.id)
  }
  const aTime = Date.parse(a.created_at)
  const bTime = Date.parse(b.created_at)
  const direction = sort === 'desc' ? -1 : 1
  if (aTime !== bTime) return (aTime < bTime ? -1 : 1) * direction
  return compareDecimalId(a.id, b.id) * direction
}

function compareDecimalId(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * Merges flat comment pages by id while retaining the first-seen server order.
 * A fresh page replaces the list; only cursor appends use this merge.
 */
export function mergeComments(
  existing: Comment[],
  incoming: Comment[],
): Comment[] {
  const byId = new Map<string, Comment>()
  for (const comment of existing) byId.set(comment.id, comment)
  for (const comment of incoming) byId.set(comment.id, comment)
  return [...byId.values()]
}

/**
 * Builds a nested presentation by parent_id. Replies whose parent is not in
 * the current page are projected at the root level so no visible reply is
 * lost. All nodes are linked before any ordering is applied, then each level
 * (roots and every `children` array) is stable-sorted by `(created_at, id)`
 * in the requested direction — so parents always precede their replies even
 * when the flat server page happened to return a child first.
 */
export function buildCommentTree(
  comments: Comment[],
  sort: CommentSort = 'asc',
): CommentNode[] {
  const nodes = new Map<string, CommentNode>()
  for (const comment of comments) {
    nodes.set(comment.id, { ...comment, children: [] })
  }
  const roots: CommentNode[] = []
  for (const comment of comments) {
    const node = nodes.get(comment.id)
    if (!node) continue
    const parent = comment.parent_id ? nodes.get(comment.parent_id) : undefined
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }
  const sortLevel = (nodesToSort: CommentNode[]): void => {
    nodesToSort.sort((a, b) => compareComments(a, b, sort))
    for (const node of nodesToSort) sortLevel(node.children)
  }
  sortLevel(roots)
  return roots
}

/**
 * Derives the success notice copy for a created comment. A `pending` status
 * means the comment awaits moderation; `published` is shown directly. Any
 * other status (or a non-comment create result) yields no success notice so a
 * failed request can never display success feedback.
 */
export function submissionNotice(status: Comment['status']): string | null {
  if (status === 'pending') return '评论已提交，等待审核。'
  if (status === 'published') return '评论已发布。'
  return null
}

/**
 * Reports whether a comment is owned by the current widget session.
 * Only authenticated-mode sessions may own deletable comments; the backend
 * remains authoritative.
 */
export function isOwnedBy(
  comment: Comment,
  session: WidgetSession | null,
): boolean {
  if (!session?.valid) return false
  if (session.credential_mode !== 'authenticated') return false
  if (!session.user_id || !comment.user_id) return false
  return session.user_id === comment.user_id
}

/** Reports whether the thread still has a next page to load. */
export function hasNextPage(
  thread: { next_cursor: string | null } | undefined,
): boolean {
  return Boolean(thread?.next_cursor)
}
