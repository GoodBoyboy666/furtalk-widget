/**
 * 合并平铺的评论页，并组装嵌套的回复树。
 *
 * 服务端返回的是按 (created_at, id) 排序的平铺列表，不分层级。
 * 在组装嵌套回复树之前，先按评论 id 合并各页，使游标加载不会重复评论，
 * 也不会打乱已显示的评论顺序。
 */

import type { Comment, CommentSort, WidgetSession } from './types'
import type { TranslationKey } from './i18n'

export interface CommentNode extends Comment {
  children: CommentNode[]
}

/**
 * 回复树的排序比较函数，保证结果稳定、可复现。
 *
 * 根评论先按是否置顶（`is_pinned`）分组；升序/降序模式再按 (created_at, id) 排序。
 * 最热模式按评论自身点赞数从多到少排列；点赞数相同时再按 (created_at, id) 降序
 * 决定先后，和服务端的 keyset 排序一致。
 * 后代的点赞不会累加到祖先。
 */
export function compareComments(
  a: Comment,
  b: Comment,
  sort: CommentSort = 'asc',
): number {
  const aPinned = a.is_pinned === true ? 1 : 0
  const bPinned = b.is_pinned === true ? 1 : 0
  if (aPinned !== bPinned) return aPinned < bPinned ? 1 : -1
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
 * 按 id 合并平铺评论页，同时保留首次见到的服务端顺序。
 * 全新的一页会直接替换列表；只有游标追加才使用本合并。
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
 * 按 parent_id 构建嵌套展示结构。父评论不在当前页内的回复会提升为根节点展示，
 * 以免可见回复丢失。
 * 先按 parent_id 建立节点关联，再统一排序。根节点使用所选的比较器；每个嵌套的
 * `children` 数组按 `(created_at, id)` 升序排列，因此即使根节点使用降序或最热排序，
 * 回复仍从最早到最新排列。
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
  roots.sort((a, b) => compareComments(a, b, sort))
  const sortReplies = (nodesToSort: CommentNode[]): void => {
    nodesToSort.sort((a, b) => compareReplyComments(a, b))
    for (const node of nodesToSort) sortReplies(node.children)
  }
  for (const root of roots) sortReplies(root.children)
  return roots
}

/** 回复始终按时间升序读取，与根排序模式无关。 */
function compareReplyComments(a: Comment, b: Comment): number {
  const aTime = Date.parse(a.created_at)
  const bTime = Date.parse(b.created_at)
  if (aTime !== bTime) return aTime < bTime ? -1 : 1
  return compareDecimalId(a.id, b.id)
}

/**
 * 根据已创建评论的状态，得出成功提示对应的文案键。
 * `pending` 表示评论等待审核；`published` 表示已上线，直接展示。
 * 其他状态（或非评论的创建结果）都不产生成功提示，保证失败的请求不会显示成功反馈。
 */
export function submissionNotice(
  status: Comment['status'],
): TranslationKey | null {
  if (status === 'pending') return 'notice.submissionPending'
  if (status === 'published') return 'notice.submissionPublished'
  return null
}

/**
 * 报告某条评论是否属于当前 widget 会话。
 * 只有认证模式下的会话才可能拥有可删除的评论；能否删除以服务端判断为准。
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

/** 报告线程是否还有下一页待加载。 */
export function hasNextPage(
  thread: { next_cursor: string | null } | undefined,
): boolean {
  return Boolean(thread?.next_cursor)
}
