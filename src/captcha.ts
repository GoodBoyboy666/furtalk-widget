/**
 * CAPTCHA rendering for the widget.
 *
 * Renders the public runtime-config CAPTCHA projection into a Shadow DOM
 * container for turnstile / reCAPTCHA / hCaptcha / CAP. Provider scripts are
 * injected on demand; CAP uses the official `cap-widget` custom element.
 *
 * The runtime-config projection is a render hint only: write endpoints re-read
 * and enforce the live policy. If the provider is unconfigured, the projection
 * lacks render data, or the provider script fails to load, rendering is
 * treated as "not required" and the server remains the final authority.
 */

import type { CaptchaProjection } from './types'

export type CaptchaProvider = 'turnstile' | 'recaptcha' | 'hcaptcha' | 'cap'

export const captchaProviders: ReadonlySet<string> = new Set([
  'turnstile',
  'recaptcha',
  'hcaptcha',
  'cap',
])

/** External script URLs for the explicit-render provider APIs. */
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

/** Reports whether the projection carries enough data to attempt rendering. */
export function canRenderCaptcha(
  projection: CaptchaProjection | undefined,
): boolean {
  if (!projection?.required) return false
  if (!projection.provider || !projection.site_key) return false
  return captchaProviders.has(projection.provider)
}

const loadingScripts = new Map<string, Promise<void>>()

/** Injects a provider script and waits for the global render instance. */
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
 * Renders the CAPTCHA into `container` and returns a reset handle, or null
 * when the projection is not renderable. `onToken('')` signals expiry/reset.
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
    // Rendering is a hint; the server enforces the live policy.
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
  // Loads the cap-widget custom element registration once.
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
        // Ignore reset failures; the token is cleared by the event listener.
      }
      onToken('')
    },
  }
}
