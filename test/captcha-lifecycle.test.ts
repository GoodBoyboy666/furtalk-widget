// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FurtalkCommentsElement } from '../src/element'
import type { WidgetState } from '../src/state'
import type { ProfileHints } from '../src/types'

// Mock the CAPTCHA renderer so tests control provider mounting and token
// callbacks without loading real provider scripts.
vi.mock('../src/captcha', () => ({
  mountCaptcha: vi.fn(),
}))

import { mountCaptcha } from '../src/captcha'

const TAG = 'furtalk-comments-captcha-test'
if (!customElements.get(TAG)) {
  customElements.define(TAG, FurtalkCommentsElement)
}

type ComposerLike = {
  comment: string
  body: string
  error: string
  replyTargetId: string | null
}

interface CaptchaInstance {
  state: WidgetState
  config: {
    siteId: string
    pageKey: string
    pageUrl?: string
    pageTitle?: string
    serviceOrigin: string
  } | null
  api: {
    createComment(
      siteId: string,
      input: Record<string, unknown>,
      captchaToken: string,
    ): Promise<unknown>
  } | null
  store: { save(hints: ProfileHints): void } | null
  hints: ProfileHints
  root: ComposerLike
  reply: ComposerLike | null
  renderRoot: HTMLElement
  captchaMaskKey: 'root' | 'reply' | null
  pendingMaskedSubmit: (() => void) | null
  loadPage(): Promise<void>
  ensureAuthenticated(action: unknown): Promise<boolean>
  createComment(composer: ComposerLike): Promise<void>
  syncCaptchas(): void
  teardownCaptcha(key: string): void
  closeReply(): void
  submitRoot(): void
  submitReply(): void
  cancelCaptchaMask(): void
}

function captchaInstance(
  overrides: {
    required?: boolean
    provider?: string
    site_key?: string
  } = {},
): CaptchaInstance {
  const element = document.createElement(TAG) as unknown as CaptchaInstance
  element.state = {
    status: 'ready',
    comments: [],
    nextCursor: null,
    sort: 'asc',
    loadingMore: false,
    authPhase: 'idle',
    config: {
      site_id: '1',
      name: 'Site',
      comment_mode: 'anonymous',
      moderation: 'direct',
      user_delete_mode: 'soft',
      max_reply_depth: 5,
      captcha: {
        comment: {
          required: overrides.required ?? false,
          provider: overrides.provider,
          site_key: overrides.site_key,
        },
      },
    },
  }
  element.root = { comment: '', body: '', error: '', replyTargetId: null }
  element.reply = null
  element.renderRoot = document.createElement('div')
  return element
}

// addHost 向渲染根追加一个 CAPTCHA 宿主元素。
function addHost(
  instance: CaptchaInstance,
  key: 'root' | 'reply',
): HTMLDivElement {
  const host = document.createElement('div')
  host.dataset.captchaHost = key
  instance.renderRoot.appendChild(host)
  return host
}

beforeEach(() => {
  vi.mocked(mountCaptcha).mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('FurtalkCommentsElement comment CAPTCHA lifecycle', () => {
  it('mounts a provider into the root host when the comment policy requires it', async () => {
    const instance = captchaInstance({
      required: true,
      provider: 'turnstile',
      site_key: 'sitekey-1',
    })
    const host = addHost(instance, 'root')
    const handle = { reset: vi.fn() }
    vi.mocked(mountCaptcha).mockResolvedValue(handle)

    instance.syncCaptchas()
    await vi.waitFor(() => expect(mountCaptcha).toHaveBeenCalledTimes(1))

    expect(mountCaptcha).toHaveBeenCalledWith(
      host,
      {
        required: true,
        provider: 'turnstile',
        site_key: 'sitekey-1',
      },
      expect.any(Function),
    )
  })

  it('does not mount when the policy is off and tears down an existing instance', async () => {
    const instance = captchaInstance({
      required: true,
      provider: 'turnstile',
      site_key: 'k',
    })
    addHost(instance, 'root')
    const handle = { reset: vi.fn() }
    vi.mocked(mountCaptcha).mockResolvedValue(handle)
    instance.syncCaptchas()
    await vi.waitFor(() => expect(mountCaptcha).toHaveBeenCalledTimes(1))

    // 关闭策略后宿主仍在渲染，但必须销毁实例且不再挂载。
    instance.state = {
      ...instance.state,
      config: {
        ...(instance.state.config as NonNullable<WidgetState['config']>),
        captcha: { comment: { required: false } },
      },
    }
    instance.syncCaptchas()
    await vi.waitFor(() => expect(handle.reset).toHaveBeenCalled())
    expect(
      instance.renderRoot.querySelector('[data-captcha-host="root"]')
        ?.childElementCount,
    ).toBe(0)
    expect(mountCaptcha).toHaveBeenCalledTimes(1)
  })

  it('writes the token callback into the matching composer', async () => {
    const instance = captchaInstance({
      required: true,
      provider: 'turnstile',
      site_key: 'k',
    })
    addHost(instance, 'root')
    const handle = { reset: vi.fn() }
    vi.mocked(mountCaptcha).mockResolvedValue(handle)
    instance.syncCaptchas()
    await vi.waitFor(() => expect(mountCaptcha).toHaveBeenCalledTimes(1))

    const onToken = vi.mocked(mountCaptcha).mock.calls[0]?.[2]
    onToken?.('captcha-token-abc')
    expect(instance.root.comment).toBe('captcha-token-abc')
  })

  it('maintains independent root and reply instances', async () => {
    const instance = captchaInstance({
      required: true,
      provider: 'turnstile',
      site_key: 'k',
    })
    const rootHost = addHost(instance, 'root')
    const replyHost = addHost(instance, 'reply')
    instance.reply = { comment: '', body: '', error: '', replyTargetId: '5' }
    const rootHandle = { reset: vi.fn() }
    const replyHandle = { reset: vi.fn() }
    vi.mocked(mountCaptcha)
      .mockResolvedValueOnce(rootHandle)
      .mockResolvedValueOnce(replyHandle)

    instance.syncCaptchas()
    await vi.waitFor(() => expect(mountCaptcha).toHaveBeenCalledTimes(2))

    // 各自的回调只写各自的 composer。
    const rootHostEl = rootHost as HTMLDivElement
    const replyHostEl = replyHost as HTMLDivElement
    expect(mountCaptcha).toHaveBeenNthCalledWith(
      1,
      rootHostEl,
      expect.anything(),
      expect.any(Function),
    )
    expect(mountCaptcha).toHaveBeenNthCalledWith(
      2,
      replyHostEl,
      expect.anything(),
      expect.any(Function),
    )
    const rootToken = vi.mocked(mountCaptcha).mock.calls[0]?.[2]
    const replyToken = vi.mocked(mountCaptcha).mock.calls[1]?.[2]
    rootToken?.('root-token')
    replyToken?.('reply-token')
    expect(instance.root.comment).toBe('root-token')
    expect(instance.reply?.comment).toBe('reply-token')
  })

  it('clears the reply instance when the reply composer closes', async () => {
    const instance = captchaInstance({
      required: true,
      provider: 'turnstile',
      site_key: 'k',
    })
    addHost(instance, 'root')
    addHost(instance, 'reply')
    instance.reply = { comment: '', body: '', error: '', replyTargetId: '5' }
    const replyHandle = { reset: vi.fn() }
    vi.mocked(mountCaptcha)
      .mockResolvedValueOnce({ reset: vi.fn() })
      .mockResolvedValueOnce(replyHandle)

    instance.syncCaptchas()
    await vi.waitFor(() => expect(mountCaptcha).toHaveBeenCalledTimes(2))
    instance.closeReply()
    expect(replyHandle.reset).toHaveBeenCalled()
  })

  it('marks a composer failed when required but the provider cannot render', async () => {
    const instance = captchaInstance({
      required: true,
      provider: 'turnstile',
      site_key: 'k',
    })
    addHost(instance, 'root')
    vi.mocked(mountCaptcha).mockResolvedValue(null)

    instance.syncCaptchas()
    await vi.waitFor(() =>
      expect(instance.root.error).toBe('人机验证暂不可用，请稍后重试'),
    )
    // 失败后不进入无限重试循环。
    instance.syncCaptchas()
    expect(mountCaptcha).toHaveBeenCalledTimes(1)
  })
})

describe('FurtalkCommentsElement comment CAPTCHA submit payload', () => {
  const publishedComment = {
    id: '7',
    site_id: '1',
    thread_id: '1',
    user_id: '10',
    parent_id: null,
    root_id: null,
    depth: 0,
    body: 'hello',
    status: 'published',
    author_nickname: 'Visitor',
    author_website: null,
    avatar_url: '',
    created_at: '2026-08-11T00:00:00Z',
    published_at: '2026-08-11T00:00:00Z',
  }

  function createInstance(): CaptchaInstance {
    const element = captchaInstance({
      required: true,
      provider: 'turnstile',
      site_key: 'k',
    })
    element.config = {
      siteId: '1',
      pageKey: 'page',
      pageUrl: 'https://host.example/page',
      serviceOrigin: 'https://comments.example',
    }
    element.hints = {
      email: 'visitor@example.com',
      nickname: 'Visitor',
      website_url: 'https://blog.example',
    }
    element.api = null
    element.store = null
    element.loadPage = vi.fn().mockResolvedValue(undefined)
    element.ensureAuthenticated = vi.fn().mockResolvedValue(true)
    return element
  }

  it('sends the composer CAPTCHA token in the create payload when required', async () => {
    const instance = createInstance()
    const createMock = vi.fn().mockResolvedValue(publishedComment)
    instance.api = { createComment: createMock }
    instance.root = {
      comment: 'captcha-token-1',
      body: 'hello',
      error: '',
      replyTargetId: null,
    }

    await instance.createComment(instance.root)

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(createMock.mock.calls[0]?.[2]).toBe('captcha-token-1')
  })

  it('opens the mask to wait for a token when required and none exists', async () => {
    const instance = createInstance()
    const createMock = vi.fn()
    instance.api = { createComment: createMock }
    instance.root = {
      comment: '',
      body: 'hello',
      error: '',
      replyTargetId: null,
    }

    await instance.createComment(instance.root)

    // 无 token 时不再直接报错，而是打开掩膜等待解决；期间绝不发起提交。
    expect(instance.captchaMaskKey).toBe('root')
    expect(createMock).not.toHaveBeenCalled()
  })
})

describe('FurtalkCommentsElement CAPTCHA mask', () => {
  const publishedComment = {
    id: '7',
    site_id: '1',
    thread_id: '1',
    user_id: '10',
    parent_id: null,
    root_id: null,
    depth: 0,
    body: 'hello',
    status: 'published',
    author_nickname: 'Visitor',
    author_website: null,
    avatar_url: '',
    created_at: '2026-08-11T00:00:00Z',
    published_at: '2026-08-11T00:00:00Z',
  }

  function maskedInstance(): CaptchaInstance {
    const element = captchaInstance({
      required: true,
      provider: 'turnstile',
      site_key: 'k',
    })
    element.config = {
      siteId: '1',
      pageKey: 'page',
      pageUrl: 'https://host.example/page',
      serviceOrigin: 'https://comments.example',
    }
    element.hints = {
      email: 'visitor@example.com',
      nickname: 'Visitor',
      website_url: 'https://blog.example',
    }
    element.api = null
    element.store = null
    element.loadPage = vi.fn().mockResolvedValue(undefined)
    element.ensureAuthenticated = vi.fn().mockResolvedValue(true)
    element.root = { comment: '', body: 'hello', error: '', replyTargetId: null }
    element.reply = null
    element.captchaMaskKey = null
    element.pendingMaskedSubmit = null
    return element
  }

  it('opens the mask instead of submitting when a token is required and missing', () => {
    const instance = maskedInstance()
    const createMock = vi.fn()
    instance.api = { createComment: createMock }

    instance.submitRoot()

    expect(instance.captchaMaskKey).toBe('root')
    expect(createMock).not.toHaveBeenCalled()
    expect(instance.pendingMaskedSubmit).not.toBeNull()
  })

  it('does not open the mask for an empty root body', () => {
    const instance = maskedInstance()
    instance.root = { comment: '', body: '', error: '', replyTargetId: null }
    const createMock = vi.fn()
    instance.api = { createComment: createMock }

    instance.submitRoot()

    expect(instance.captchaMaskKey).toBeNull()
    expect(instance.root.error).toBe('评论内容不能为空')
    expect(createMock).not.toHaveBeenCalled()
  })

  it('resumes the pending root submission exactly once after solving the mask', async () => {
    const instance = maskedInstance()
    const createMock = vi.fn().mockResolvedValue(publishedComment)
    instance.api = { createComment: createMock }

    instance.submitRoot()
    expect(instance.captchaMaskKey).toBe('root')

    // 掩膜渲染后的宿主与 token 回调等价于 mountOneCaptcha 的路径。
    addHost(instance, 'root')
    const handle = { reset: vi.fn() }
    vi.mocked(mountCaptcha).mockResolvedValue(handle)
    instance.syncCaptchas()
    await vi.waitFor(() => expect(mountCaptcha).toHaveBeenCalledTimes(1))
    const onToken = vi.mocked(mountCaptcha).mock.calls[0]?.[2]

    onToken?.('mask-token')
    await vi.waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))

    expect(createMock.mock.calls[0]?.[2]).toBe('mask-token')
    expect(instance.captchaMaskKey).toBeNull()
    expect(instance.pendingMaskedSubmit).toBeNull()
    // 成功发布后 composer 重置为全新空状态，token 不再保留。
    expect(instance.root.comment).toBe('')
  })

  it('cancels the mask and submits zero times', () => {
    const instance = maskedInstance()
    const createMock = vi.fn()
    instance.api = { createComment: createMock }

    instance.submitRoot()
    expect(instance.captchaMaskKey).toBe('root')

    instance.cancelCaptchaMask()

    expect(instance.captchaMaskKey).toBeNull()
    expect(instance.pendingMaskedSubmit).toBeNull()
    expect(createMock).not.toHaveBeenCalled()
    expect(instance.root.comment).toBe('')
  })

  it('submits directly without a mask when the policy is disabled', async () => {
    const instance = captchaInstance({ required: false })
    instance.config = {
      siteId: '1',
      pageKey: 'page',
      pageUrl: 'https://host.example/page',
      serviceOrigin: 'https://comments.example',
    }
    instance.hints = {
      email: 'visitor@example.com',
      nickname: 'Visitor',
      website_url: '',
    }
    instance.loadPage = vi.fn().mockResolvedValue(undefined)
    instance.ensureAuthenticated = vi.fn().mockResolvedValue(true)
    instance.root = { comment: '', body: 'hi', error: '', replyTargetId: null }
    const createMock = vi.fn().mockResolvedValue(publishedComment)
    instance.api = { createComment: createMock }

    instance.submitRoot()

    await vi.waitFor(() => expect(createMock).toHaveBeenCalledTimes(1))
    expect(instance.captchaMaskKey).toBeNull()
  })

  it('opens a reply mask that stays isolated from the root mask', () => {
    const instance = maskedInstance()
    const createMock = vi.fn()
    instance.api = { createComment: createMock }
    instance.reply = { comment: '', body: 'reply', error: '', replyTargetId: '5' }

    instance.submitReply()

    expect(instance.captchaMaskKey).toBe('reply')
    expect(createMock).not.toHaveBeenCalled()
  })

  it('cancels an open reply mask when the reply composer closes', async () => {
    const instance = maskedInstance()
    const createMock = vi.fn()
    instance.api = { createComment: createMock }
    instance.reply = { comment: '', body: 'reply', error: '', replyTargetId: '5' }

    instance.submitReply()
    expect(instance.captchaMaskKey).toBe('reply')

    addHost(instance, 'reply')
    const handle = { reset: vi.fn() }
    vi.mocked(mountCaptcha).mockResolvedValue(handle)
    instance.syncCaptchas()
    await vi.waitFor(() => expect(mountCaptcha).toHaveBeenCalled())

    instance.closeReply()

    expect(instance.captchaMaskKey).toBeNull()
    expect(instance.pendingMaskedSubmit).toBeNull()
    expect(instance.reply).toBeNull()
    expect(createMock).not.toHaveBeenCalled()
    expect(handle.reset).toHaveBeenCalled()
  })

  it('runs authorization before opening the mask in authenticated mode', async () => {
    const instance = captchaInstance({
      required: true,
      provider: 'turnstile',
      site_key: 'k',
    })
    instance.state = {
      ...instance.state,
      config: {
        ...(instance.state.config as NonNullable<WidgetState['config']>),
        comment_mode: 'authenticated',
      },
      session: { valid: false },
    }
    instance.config = {
      siteId: '1',
      pageKey: 'page',
      pageUrl: 'https://host.example/page',
      serviceOrigin: 'https://comments.example',
    }
    instance.hints = {
      email: 'visitor@example.com',
      nickname: 'Visitor',
      website_url: '',
    }
    instance.loadPage = vi.fn().mockResolvedValue(undefined)
    instance.root = { comment: '', body: 'hi', error: '', replyTargetId: null }
    instance.reply = null
    instance.captchaMaskKey = null
    instance.pendingMaskedSubmit = null
    const createMock = vi.fn().mockResolvedValue(publishedComment)
    instance.api = { createComment: createMock }

    // 让授权挂起：只有显式 resolve 后流程才会进入提交前一刻。
    let resolveAuth!: () => void
    instance.ensureAuthenticated = vi
      .fn()
      .mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            resolveAuth = () => resolve(true)
          }),
      )

    instance.submitRoot()

    // 授权进行中：掩膜必须保持关闭，绝不提前拉起验证码。
    await vi.waitFor(() =>
      expect(instance.ensureAuthenticated).toHaveBeenCalled(),
    )
    expect(instance.captchaMaskKey).toBeNull()
    expect(createMock).not.toHaveBeenCalled()

    // 授权完成、进入提交前一刻才打开掩膜等待 token。
    resolveAuth()
    await vi.waitFor(() => expect(instance.captchaMaskKey).toBe('root'))
    expect(createMock).not.toHaveBeenCalled()
  })
})
