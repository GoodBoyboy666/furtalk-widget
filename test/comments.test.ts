import { describe, expect, it } from 'vitest'

import {
  buildCommentTree,
  compareComments,
  hasNextPage,
  isOwnedBy,
  mergeComments,
  submissionNotice,
} from '../src/comments'
import type { Comment, WidgetSession } from '../src/types'

function comment(
  partial: Partial<Comment> & { id: string; parent_id?: string | null },
): Comment {
  return {
    site_id: '1',
    thread_id: '1',
    user_id: '10',
    parent_id: null,
    root_id: null,
    depth: 0,
    body: 'body',
    status: 'published',
    author_nickname: 'n',
    author_website: null,
    avatar_url: 'https://example/a.png',
    reply_to_user_id: null,
    reply_to_nickname: null,
    created_at: '2026-08-11T00:00:00Z',
    published_at: '2026-08-11T00:00:00Z',
    ...partial,
  }
}

describe('mergeComments', () => {
  it('deduplicates pages by id while retaining server order', () => {
    const first = [comment({ id: '1' }), comment({ id: '2' })]
    const second = [comment({ id: '2' }), comment({ id: '3' })]
    const merged = mergeComments(first, second)
    expect(merged.map((c) => c.id)).toEqual(['1', '2', '3'])
  })

  it('returns an empty list for empty inputs', () => {
    expect(mergeComments([], [])).toEqual([])
  })
})

describe('buildCommentTree', () => {
  it('nests replies under their parents by parent_id', () => {
    const comments = [
      comment({ id: '1', depth: 0 }),
      comment({ id: '2', parent_id: '1', depth: 1 }),
      comment({ id: '3', parent_id: '1', depth: 1 }),
      comment({ id: '4', parent_id: '2', depth: 2 }),
    ]
    const tree = buildCommentTree(comments)
    expect(tree.map((n) => n.id)).toEqual(['1'])
    expect(tree[0]?.children.map((n) => n.id)).toEqual(['2', '3'])
    expect(tree[0]?.children[0]?.children.map((n) => n.id)).toEqual(['4'])
  })

  it('sorts siblings deterministically instead of trusting page order', () => {
    // 旧行为保留平铺的服务端顺序；现在构建器会感知排序方向，
    // 按 (created_at, id) 对每一层同级评论排序。
    const comments = [
      comment({ id: 'b' }),
      comment({ id: 'a' }),
      comment({ id: 'c' }),
    ]
    expect(buildCommentTree(comments).map((n) => n.id)).toEqual(['a', 'b', 'c'])
  })

  it('projects replies whose parent is not in the page at root level', () => {
    const comments = [
      comment({ id: '1' }),
      comment({ id: '2', parent_id: '999', depth: 1 }),
    ]
    const tree = buildCommentTree(comments)
    expect(tree.map((n) => n.id)).toEqual(['1', '2'])
  })

  it('keeps deleted placeholders visible', () => {
    const tree = buildCommentTree([comment({ id: '1', status: 'deleted' })])
    expect(tree[0]?.status).toBe('deleted')
  })
})

describe('buildCommentTree direction', () => {
  function commentsWithSameTimestamp(): Comment[] {
    // 所有 id 共享同一个 created_at，因此稳定的 (created_at, id) 顺序完全由
    // 十进制 id 决定。
    return [
      comment({ id: '30', created_at: '2026-08-11T10:00:00Z' }),
      comment({ id: '10', created_at: '2026-08-11T10:00:00Z' }),
      comment({ id: '20', created_at: '2026-08-11T10:00:00Z' }),
    ]
  }

  it('sorts roots ascending by (created_at, id) by default', () => {
    const tree = buildCommentTree(commentsWithSameTimestamp())
    expect(tree.map((n) => n.id)).toEqual(['10', '20', '30'])
  })

  it('sorts roots descending by (created_at, id) on desc', () => {
    const tree = buildCommentTree(commentsWithSameTimestamp(), 'desc')
    expect(tree.map((n) => n.id)).toEqual(['30', '20', '10'])
  })

  it('places pinned roots before unpinned roots in every direction', () => {
    const comments = [
      comment({
        id: 'old-pinned',
        is_pinned: true,
        created_at: '2026-08-01T00:00:00Z',
      }),
      comment({
        id: 'new-unpinned',
        created_at: '2026-08-11T00:00:00Z',
      }),
      comment({
        id: 'new-pinned',
        is_pinned: true,
        created_at: '2026-08-10T00:00:00Z',
      }),
    ]
    expect(buildCommentTree(comments, 'asc').map((n) => n.id)).toEqual([
      'old-pinned',
      'new-pinned',
      'new-unpinned',
    ])
    expect(buildCommentTree(comments, 'desc').map((n) => n.id)).toEqual([
      'new-pinned',
      'old-pinned',
      'new-unpinned',
    ])
  })

  it('keeps roots directional while replies remain chronological', () => {
    const comments = [
      comment({
        id: '1',
        created_at: '2026-08-11T09:00:00Z',
        parent_id: null,
        depth: 0,
      }),
      comment({
        id: '3',
        parent_id: '1',
        depth: 1,
        created_at: '2026-08-11T09:02:00Z',
      }),
      comment({
        id: '2',
        parent_id: '1',
        depth: 1,
        created_at: '2026-08-11T09:01:00Z',
      }),
      comment({
        id: '4',
        parent_id: null,
        depth: 0,
        created_at: '2026-08-11T09:03:00Z',
      }),
    ]
    const asc = buildCommentTree(comments, 'asc')
    expect(asc.map((n) => n.id)).toEqual(['1', '4'])
    expect(asc[0]?.children.map((n) => n.id)).toEqual(['2', '3'])

    const desc = buildCommentTree(comments, 'desc')
    expect(desc.map((n) => n.id)).toEqual(['4', '1'])
    expect(desc[1]?.children.map((n) => n.id)).toEqual(['2', '3'])
  })

  it('sorts a child whose parent arrives later in the flat page correctly', () => {
    // 先构建整棵树再排序，所以即使降序页面先返回子节点、后返回父节点，
    // 也能正确嵌套，并按时序排列回复，与根排序方向无关。
    const comments = [
      comment({
        id: '3',
        parent_id: '1',
        depth: 1,
        created_at: '2026-08-11T09:02:00Z',
      }),
      comment({
        id: '2',
        parent_id: '1',
        depth: 1,
        created_at: '2026-08-11T09:01:00Z',
      }),
      comment({
        id: '1',
        parent_id: null,
        depth: 0,
        created_at: '2026-08-11T09:00:00Z',
      }),
    ]
    const tree = buildCommentTree(comments, 'desc')
    expect(tree.map((n) => n.id)).toEqual(['1'])
    expect(tree[0]?.children.map((n) => n.id)).toEqual(['2', '3'])
  })

  it('sorts nested replies chronologically at every depth with decimal id ties', () => {
    const comments = [
      comment({
        id: 'root',
        created_at: '2026-08-11T09:00:00Z',
        like_count: 0,
      }),
      comment({
        id: 'late-root',
        created_at: '2026-08-11T10:00:00Z',
        like_count: 10,
      }),
      comment({
        id: 'reply-30',
        parent_id: 'root',
        depth: 1,
        created_at: '2026-08-11T09:02:00Z',
        like_count: 100,
      }),
      comment({
        id: 'reply-10',
        parent_id: 'root',
        depth: 1,
        created_at: '2026-08-11T09:01:00Z',
        like_count: 1,
      }),
      comment({
        id: 'reply-20',
        parent_id: 'root',
        depth: 1,
        created_at: '2026-08-11T09:01:00Z',
        like_count: 50,
      }),
      comment({
        id: 'grandchild-2',
        parent_id: 'reply-30',
        depth: 2,
        created_at: '2026-08-11T09:04:00Z',
        like_count: 1,
      }),
      comment({
        id: 'grandchild-1',
        parent_id: 'reply-30',
        depth: 2,
        created_at: '2026-08-11T09:03:00Z',
        like_count: 100,
      }),
    ]

    for (const sort of ['desc', 'hot'] as const) {
      const tree = buildCommentTree(comments, sort)
      expect(tree.map((n) => n.id)).toEqual(['late-root', 'root'])
      expect(tree[1]?.children.map((n) => n.id)).toEqual([
        'reply-10',
        'reply-20',
        'reply-30',
      ])
      expect(tree[1]?.children[2]?.children.map((n) => n.id)).toEqual([
        'grandchild-1',
        'grandchild-2',
      ])
    }
  })

  it('orders across different timestamps in both directions', () => {
    const comments = [
      comment({ id: '1', created_at: '2026-08-10T00:00:00Z' }),
      comment({ id: '2', created_at: '2026-08-11T00:00:00Z' }),
      comment({ id: '3', created_at: '2026-08-09T00:00:00Z' }),
    ]
    expect(buildCommentTree(comments, 'asc').map((n) => n.id)).toEqual([
      '3',
      '1',
      '2',
    ])
    expect(buildCommentTree(comments, 'desc').map((n) => n.id)).toEqual([
      '2',
      '1',
      '3',
    ])
  })
})

describe('compareComments', () => {
  it('compares by created_at then decimal id', () => {
    const older = comment({ id: '5', created_at: '2026-08-10T00:00:00Z' })
    const newer = comment({ id: '1', created_at: '2026-08-11T00:00:00Z' })
    expect(compareComments(older, newer)).toBeLessThan(0)
    expect(compareComments(newer, older)).toBeGreaterThan(0)
    expect(compareComments(older, older)).toBe(0)
  })

  it('orders same timestamps by decimal id (not lexicographic)', () => {
    const a = comment({ id: '2', created_at: '2026-08-11T00:00:00Z' })
    const b = comment({ id: '10', created_at: '2026-08-11T00:00:00Z' })
    expect(compareComments(a, b)).toBeLessThan(0)
    expect(compareComments(b, a)).toBeGreaterThan(0)
  })

  it('reverses both fields for desc', () => {
    const a = comment({ id: '1', created_at: '2026-08-10T00:00:00Z' })
    const b = comment({ id: '2', created_at: '2026-08-11T00:00:00Z' })
    expect(compareComments(a, b, 'desc')).toBeGreaterThan(0)
  })
})

describe('hot ordering', () => {
  it('ranks by the comment own like count descending', () => {
    const low = comment({ id: '1', like_count: 1 })
    const high = comment({ id: '2', like_count: 5 })
    expect(compareComments(low, high, 'hot')).toBeGreaterThan(0)
    expect(compareComments(high, low, 'hot')).toBeLessThan(0)
  })

  it('breaks hot ties by (created_at, id) descending', () => {
    const older = comment({
      id: '1',
      like_count: 2,
      created_at: '2026-08-10T00:00:00Z',
    })
    const newer = comment({
      id: '2',
      like_count: 2,
      created_at: '2026-08-11T00:00:00Z',
    })
    expect(compareComments(older, newer, 'hot')).toBeGreaterThan(0)
    // 计数与时间戳相同：id 较大者在前。
    const a = comment({
      id: '2',
      like_count: 2,
      created_at: '2026-08-11T00:00:00Z',
    })
    const b = comment({
      id: '10',
      like_count: 2,
      created_at: '2026-08-11T00:00:00Z',
    })
    expect(compareComments(a, b, 'hot')).toBeGreaterThan(0)
    expect(compareComments(b, a, 'hot')).toBeLessThan(0)
  })

  it('treats a missing like_count as zero and never aggregates descendants', () => {
    const missing = comment({ id: '1' })
    const zero = comment({ id: '2', like_count: 0 })
    const one = comment({ id: '3', like_count: 1 })
    // 缺失计数与显式的 0 视为相同；再按 (created_at, id) 比较，id 较大的排前面。
    expect(compareComments(missing, zero, 'hot')).toBeGreaterThan(0)
    expect(compareComments(one, missing, 'hot')).toBeLessThan(0)
  })

  it('sorts roots by own like count while replies remain chronological', () => {
    const comments = [
      comment({ id: 'root', parent_id: null, depth: 0, like_count: 0 }),
      comment({ id: 'r2', parent_id: null, depth: 0, like_count: 3 }),
      comment({
        id: 'c1',
        parent_id: 'root',
        depth: 1,
        like_count: 5,
        created_at: '2026-08-11T09:02:00Z',
      }),
      comment({
        id: 'c2',
        parent_id: 'root',
        depth: 1,
        like_count: 1,
        created_at: '2026-08-11T09:01:00Z',
      }),
    ]
    const tree = buildCommentTree(comments, 'hot')
    // 根节点按 like_count 降序排列：r2（3）在 root（0）之前。
    expect(tree.map((n) => n.id)).toEqual(['r2', 'root'])
    expect(tree[1]?.children.map((n) => n.id)).toEqual(['c2', 'c1'])
  })
})

describe('submissionNotice', () => {
  it('asks for moderation when the created comment is pending', () => {
    expect(submissionNotice('pending')).toBe('notice.submissionPending')
  })

  it('announces a direct publish', () => {
    expect(submissionNotice('published')).toBe('notice.submissionPublished')
  })

  it('returns no success copy for other statuses', () => {
    expect(submissionNotice('spam')).toBeNull()
    expect(submissionNotice('deleted')).toBeNull()
  })
})

describe('isOwnedBy', () => {
  const authenticated: WidgetSession = {
    valid: true,
    credential_mode: 'authenticated',
    user_id: '10',
    site_id: '1',
  }

  it('grants ownership only to the matching authenticated user', () => {
    expect(isOwnedBy(comment({ id: '1', user_id: '10' }), authenticated)).toBe(
      true,
    )
    expect(isOwnedBy(comment({ id: '1', user_id: '99' }), authenticated)).toBe(
      false,
    )
  })

  it('denies ownership for missing, stale or non-authenticated sessions', () => {
    expect(isOwnedBy(comment({ id: '1', user_id: '10' }), null)).toBe(false)
    // 缺少认证 credential_mode 的会话（陈旧匿名凭据或旧版响应）绝不判定为评论的所有者。
    expect(
      isOwnedBy(comment({ id: '1', user_id: '10' }), {
        valid: true,
        user_id: '10',
      }),
    ).toBe(false)
    expect(
      isOwnedBy(comment({ id: '1', user_id: '10' }), { valid: false }),
    ).toBe(false)
    // 只有匹配的认证用户才拥有该评论。
    expect(
      isOwnedBy(comment({ id: '1', user_id: '10' }), {
        valid: true,
        credential_mode: 'authenticated',
        user_id: '99',
      }),
    ).toBe(false)
  })
})

describe('hasNextPage', () => {
  it('reports the cursor', () => {
    expect(hasNextPage({ next_cursor: 'abc' })).toBe(true)
    expect(hasNextPage({ next_cursor: null })).toBe(false)
    expect(hasNextPage(undefined)).toBe(false)
  })
})
