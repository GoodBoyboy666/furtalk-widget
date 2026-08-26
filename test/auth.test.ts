import { describe, expect, it } from 'vitest'

import {
  INIT_RETRY_INTERVAL_MS,
  runAuthorizationFlow,
  type AuthorizationFlowHooks,
} from '../src/auth'
import type { AuthorizationMessage, ProfileHints } from '../src/types'

function event(
  data: unknown,
  origin: string,
  source: MessageEventSource | null,
): MessageEvent {
  return { data, origin, source } as MessageEvent
}

interface FakePopup {
  closed: boolean
  messages: AuthorizationMessage[]
  targetOrigin: string[]
}

function makeHooks(
  popup: FakePopup,
  targetOrigin: string,
): {
  hooks: AuthorizationFlowHooks
  listeners: ((event: MessageEvent) => void)[]
} {
  const listeners: ((event: MessageEvent) => void)[] = []
  const hooks: AuthorizationFlowHooks = {
    postMessage: (target, message) => {
      // 模拟真实浏览器：向目标弹窗 postMessage。
      popup.messages.push(message)
      popup.targetOrigin.push(targetOrigin)
    },
    listen: (listener) => {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    isClosed: (target) => (target as unknown as FakePopup).closed,
  }
  return { hooks, listeners }
}

function runFlow(
  overrides: {
    popup?: Partial<FakePopup>
    origin?: string
    hints?: Partial<ProfileHints>
    timeoutMs?: number
    resultTimeoutMs?: number
  } = {},
) {
  const popup: FakePopup = {
    closed: false,
    messages: [],
    targetOrigin: [],
    ...overrides.popup,
  }
  const origin = overrides.origin ?? 'https://comments.example'
  const { hooks, listeners } = makeHooks(popup, origin)
  const popupWindow = popup as unknown as Window
  const promise = runAuthorizationFlow(
    {
      furtalkOrigin: origin,
      siteId: '123',
      hints: {
        email: 'a@b.example',
        nickname: 'Alice',
        website_url: 'https://blog.example',
        ...overrides.hints,
      },
      timeoutMs: overrides.timeoutMs ?? 50,
      resultTimeoutMs: overrides.resultTimeoutMs ?? 200,
      open: () => popupWindow,
    },
    hooks,
  )
  return {
    popup,
    popupWindow,
    listeners,
    promise,
    deliver: (
      message: AuthorizationMessage,
      messageOrigin = origin,
      source: MessageEventSource | null = popupWindow,
    ) => {
      for (const listener of [...listeners]) {
        listener(event(message, messageOrigin, source))
      }
    },
  }
}

describe('runAuthorizationFlow', () => {
  it('returns blocked when window.open fails', async () => {
    const outcome = await runAuthorizationFlow({
      furtalkOrigin: 'https://comments.example',
      siteId: '1',
      hints: { email: '', nickname: '', website_url: '' },
      open: () => null,
    })
    expect(outcome.status).toBe('blocked')
  })

  it('opens a normal new tab with no popup/size window features', async () => {
    const popup: FakePopup = { closed: false, messages: [], targetOrigin: [] }
    const { hooks } = makeHooks(popup, 'https://comments.example')
    const holder: {
      value: { url: string; name: string; features: string } | null
    } = { value: null }
    const promise = runAuthorizationFlow(
      {
        furtalkOrigin: 'https://comments.example',
        siteId: '123',
        hints: { email: '', nickname: '', website_url: '' },
        timeoutMs: 50,
        resultTimeoutMs: 200,
        open: (url, name, features) => {
          holder.value = { url, name, features }
          return popup as unknown as Window
        },
      },
      hooks,
    )

    // 默认偏好是普通 _blank 标签页：不设置 popup=yes，也没有 width/height 等尺寸特性
    // （浏览器仍可能打开独立窗口）。
    expect(holder.value).not.toBeNull()
    expect(holder.value?.name).toBe('_blank')
    expect(holder.value?.features).toBe('')
    expect(holder.value?.features).not.toContain('popup=yes')
    expect(holder.value?.features).not.toContain('width')
    expect(holder.value?.features).not.toContain('height')

    // 传给 window.open 的 URL 必须包含严格的协议字段。
    const url = new URL(holder.value?.url ?? '')
    expect(url.pathname).toBe('/authorize')
    expect(url.searchParams.get('site_id')).toBe('123')
    const requestId = url.searchParams.get('request_id')
    expect(requestId).not.toBeNull()
    expect(requestId).toMatch(/^[A-Za-z0-9_-]{22}$/)

    const outcome = await promise
    expect(outcome.status).toBe('timeout')
  })

  it('sends init messages with the email hint and returns success code on approval', async () => {
    const flow = runFlow()
    expect(flow.popup.messages.length).toBeGreaterThan(0)
    const init = flow.popup.messages[0]
    expect(init?.type).toBe('furtalk:authorization-init')
    expect(init?.type === 'furtalk:authorization-init' && init.email).toBe(
      'a@b.example',
    )
    // 授权协议不再传输昵称/网站；资料更新只随评论请求一起进行。
    const initRecord = init as Record<string, unknown> | undefined
    expect(initRecord?.nickname).toBeUndefined()
    expect(initRecord?.website_url).toBeUndefined()
    expect(flow.popup.targetOrigin[0]).toBe('https://comments.example')

    flow.deliver({
      type: 'furtalk:authorization-ready',
      request_id:
        init?.type === 'furtalk:authorization-init' ? init.request_id : '',
    })
    flow.deliver({
      type: 'furtalk:authorization-success',
      request_id:
        init?.type === 'furtalk:authorization-init' ? init.request_id : '',
      code: 'code-1',
    })
    const outcome = await flow.promise
    expect(outcome).toEqual({
      status: 'success',
      code: 'code-1',
      requestId:
        init?.type === 'furtalk:authorization-init' ? init.request_id : '',
    })
  })

  it('returns cancelled when the popup sends cancellation', async () => {
    const flow = runFlow()
    const requestId =
      flow.popup.messages[0]?.type === 'furtalk:authorization-init'
        ? flow.popup.messages[0].request_id
        : ''
    flow.deliver({
      type: 'furtalk:authorization-cancelled',
      request_id: requestId,
    })
    const outcome = await flow.promise
    expect(outcome.status).toBe('cancelled')
  })

  it('returns closed when the popup window closes without a message', async () => {
    // 给关闭监听器（250ms 间隔）足够时间观察到关闭，
    // 赶在就绪/结果超时触发之前。
    const flow = runFlow({
      popup: { closed: true },
      timeoutMs: 2000,
      resultTimeoutMs: 2000,
    })
    const outcome = await flow.promise
    expect(outcome.status).toBe('closed')
  })

  it('returns timeout when the popup never becomes ready', async () => {
    const flow = runFlow()
    const outcome = await flow.promise
    expect(outcome.status).toBe('timeout')
  })

  it('ignores messages from the wrong origin', async () => {
    const flow = runFlow({ timeoutMs: 1000, resultTimeoutMs: 1000 })
    const requestId =
      flow.popup.messages[0]?.type === 'furtalk:authorization-init'
        ? flow.popup.messages[0].request_id
        : ''
    // 从攻击者来源投递消息；流程不应据此作出结论。
    flow.deliver(
      { type: 'furtalk:authorization-cancelled', request_id: requestId },
      'https://evil.example',
    )
    expect(flow.popup.messages.length).toBeGreaterThan(0)
    // 弹窗仍打开，因此流程继续等待。
  })

  it('ignores messages from the wrong source window', async () => {
    const flow = runFlow({ timeoutMs: 1000, resultTimeoutMs: 1000 })
    const requestId =
      flow.popup.messages[0]?.type === 'furtalk:authorization-init'
        ? flow.popup.messages[0].request_id
        : ''
    flow.deliver(
      { type: 'furtalk:authorization-cancelled', request_id: requestId },
      'https://comments.example',
      {} as Window,
    )
  })

  it('stops retrying after the popup acknowledges readiness', async () => {
    const flow = runFlow()
    const before = flow.popup.messages.length
    const requestId =
      flow.popup.messages[0]?.type === 'furtalk:authorization-init'
        ? flow.popup.messages[0].request_id
        : ''
    flow.deliver({ type: 'furtalk:authorization-ready', request_id: requestId })
    // 给任何残留的定时器一次触发机会；不应再发送额外的初始化消息。
    await new Promise((resolve) =>
      setTimeout(resolve, INIT_RETRY_INTERVAL_MS * 2),
    )
    const after = flow.popup.messages.length
    expect(after).toBe(before)
  })
})
