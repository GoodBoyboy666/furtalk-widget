/**
 * Widget 的 CAPTCHA 渲染。
 *
 * 把运行时配置中的 CAPTCHA 信息渲染进 Shadow DOM 容器，可接入
 * turnstile / reCAPTCHA / hCaptcha / CAP 等验证码服务，脚本按需加载；
 * CAP 使用官方的 `cap-widget` 自定义元素。
 *
 * 这里的运行时配置只是渲染提示：写入接口会重新读取并强制执行实时策略。
 * 若验证码服务未配置、配置缺少渲染数据，或脚本加载失败，
 * 则按“无需验证码”处理，最终以服务端为准。
 */

import type { CaptchaProjection } from './types'

export type CaptchaProvider = 'turnstile' | 'recaptcha' | 'hcaptcha' | 'cap'

export const captchaProviders: ReadonlySet<string> = new Set([
  'turnstile',
  'recaptcha',
  'hcaptcha',
  'cap',
])

/** 采用显式渲染模式的验证码脚本地址。 */
const scriptURLs: Partial<Record<Exclude<CaptchaProvider, 'cap'>, string>> = {
  turnstile:
    'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
  recaptcha: 'https://www.google.com/recaptcha/api.js?render=explicit',
  hcaptcha: 'https://hcaptcha.com/1/api.js?render=explicit',
}

type TurnstileInstance = {
  render: (el: HTMLElement, options: Record<string, unknown>) => string
  reset: (id: string) => void
  remove: (id: string) => void
}
type RecaptchaInstance = {
  render: (el: HTMLElement, options: Record<string, unknown>) => number
  reset: (id: number) => void
}
type HcaptchaInstance = {
  render: (el: HTMLElement, options: Record<string, unknown>) => number
  reset: (id: number) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileInstance
    grecaptcha?: RecaptchaInstance
    hcaptcha?: HcaptchaInstance
  }
}

/** 判断配置信息是否完整、能否开始渲染。 */
export function canRenderCaptcha(
  projection: CaptchaProjection | undefined,
): boolean {
  if (!projection?.required) return false
  if (!projection.provider || !projection.site_key) return false
  return captchaProviders.has(projection.provider)
}

const loadingScripts = new Map<string, Promise<void>>()

/** 加载验证码脚本，并等待全局渲染对象就绪。 */
function loadProviderScript(
  provider: Exclude<CaptchaProvider, 'cap'>,
): Promise<void> {
  if (typeof document === 'undefined') {
    return Promise.reject(
      new Error('CAPTCHA scripts require a browser context'),
    )
  }
  const url = scriptURLs[provider]
  if (!url)
    return Promise.reject(new Error(`unsupported provider: ${provider}`))
  const existing = loadingScripts.get(url)
  if (existing) return existing
  const promise = injectScript(url).then(() => waitForGlobal(provider))
  loadingScripts.set(url, promise)
  promise.catch(() => loadingScripts.delete(url))
  return promise
}

function injectScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = url
    script.async = true
    script.onload = () => resolve()
    script.onerror = () =>
      reject(new Error(`CAPTCHA provider script failed to load: ${url}`))
    document.head.appendChild(script)
  })
}

function waitForGlobal(
  provider: Exclude<CaptchaProvider, 'cap'>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000
    const poll = () => {
      if (globalPresent(provider)) {
        resolve()
        return
      }
      if (Date.now() > deadline) {
        reject(new Error(`CAPTCHA provider ${provider} failed to initialize`))
        return
      }
      setTimeout(poll, 50)
    }
    poll()
  })
}

function globalPresent(provider: Exclude<CaptchaProvider, 'cap'>): boolean {
  if (typeof window === 'undefined') return false
  switch (provider) {
    case 'turnstile':
      return Boolean(window.turnstile?.render)
    case 'recaptcha':
      return Boolean(window.grecaptcha?.render)
    case 'hcaptcha':
      return Boolean(window.hcaptcha?.render)
  }
}

export interface CaptchaHandle {
  reset(): void
}

interface RenderedChallenge {
  provider: Exclude<CaptchaProvider, 'cap'>
  widgetId: string | number
}

/**
 * 将 CAPTCHA 渲染到 `container` 中并返回重置句柄；当配置信息不足以渲染时返回 null。
 * `onToken('')` 表示令牌过期/重置。
 */
export async function mountCaptcha(
  container: HTMLElement,
  projection: CaptchaProjection,
  onToken: (token: string) => void,
): Promise<CaptchaHandle | null> {
  if (!canRenderCaptcha(projection)) return null
  const provider = projection.provider as CaptchaProvider
  if (provider === 'cap') {
    return mountCap(container, projection, onToken)
  }
  try {
    await loadProviderScript(provider)
  } catch {
    // 客户端的渲染按配置展示；是否必须验证码、token 是否有效，都由服务端在提交时强制校验。
    return null
  }
  const rendered = renderHosted(container, provider, projection, onToken)
  if (!rendered) return null
  return {
    reset: () => resetHosted(provider, rendered.widgetId, onToken),
  }
}

function renderHosted(
  container: HTMLElement,
  provider: Exclude<CaptchaProvider, 'cap'>,
  projection: CaptchaProjection,
  onToken: (token: string) => void,
): RenderedChallenge | null {
  let widgetId: string | number
  switch (provider) {
    case 'turnstile':
      if (!window.turnstile?.render) return null
      widgetId = window.turnstile.render(container, {
        sitekey: projection.site_key,
        size: 'normal',
        callback: onToken,
        'expired-callback': () => onToken(''),
        'error-callback': () => onToken(''),
      })
      break
    case 'recaptcha':
      if (!window.grecaptcha?.render) return null
      widgetId = window.grecaptcha.render(container, {
        sitekey: projection.site_key,
        size: 'normal',
        callback: onToken,
        'expired-callback': () => onToken(''),
        'error-callback': () => onToken(''),
      })
      break
    case 'hcaptcha':
      if (!window.hcaptcha?.render) return null
      widgetId = window.hcaptcha.render(container, {
        sitekey: projection.site_key,
        size: 'normal',
        callback: onToken,
        'expired-callback': () => onToken(''),
        'error-callback': () => onToken(''),
      })
      break
  }
  return { provider, widgetId }
}

function resetHosted(
  provider: Exclude<CaptchaProvider, 'cap'>,
  widgetId: string | number,
  onToken: (token: string) => void,
): void {
  switch (provider) {
    case 'turnstile':
      if (typeof widgetId === 'string') window.turnstile?.reset(widgetId)
      break
    case 'recaptcha':
      if (typeof widgetId === 'number') window.grecaptcha?.reset(widgetId)
      break
    case 'hcaptcha':
      if (typeof widgetId === 'number') window.hcaptcha?.reset(widgetId)
      break
  }
  onToken('')
}

async function mountCap(
  container: HTMLElement,
  projection: CaptchaProjection,
  onToken: (token: string) => void,
): Promise<CaptchaHandle | null> {
  if (!projection.api_endpoint) return null
  // 通过 import('cap-widget') 把 cap-widget 自定义元素注册到浏览器；
  // 模块加载有缓存，注册只会发生一次。
  try {
    await import('cap-widget')
  } catch {
    return null
  }
  if (typeof customElements === 'undefined') return null
  const element = document.createElement('cap-widget') as HTMLElement & {
    setWorkersCount?: (n: number) => void
  }
  element.setAttribute('data-cap-api-endpoint', projection.api_endpoint)
  element.setAttribute('data-cap-worker-count', '2')
  const onSolve = (event: Event) => {
    const token = (event as CustomEvent<{ token: string }>).detail?.token
    if (token) onToken(token)
  }
  const onReset = () => onToken('')
  element.addEventListener('solve', onSolve)
  element.addEventListener('reset', onReset)
  element.addEventListener('error', onReset)
  container.appendChild(element)
  return {
    reset: () => {
      const cap = element as HTMLElement & { reset?: () => void }
      try {
        cap.reset?.()
      } catch {
        // 忽略重置失败；令牌由事件监听器清空。
      }
      onToken('')
    },
  }
}
