// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  createRoot: vi.fn<(container: Element, options?: unknown) => { render(app: unknown): void }>(),
  hydrateRoot: vi.fn<(container: Element, app: unknown, options?: unknown) => unknown>(),
  load: vi.fn<() => Promise<void>>(),
  onRpcBroken: vi.fn<(callback: (error: unknown) => void) => void>(),
  render: vi.fn<(app: unknown) => void>(),
}))

vi.mock('react-dom/client', () => ({
  createRoot: testState.createRoot,
  hydrateRoot: testState.hydrateRoot,
}))

vi.mock('@tanstack/react-router', () => ({ RouterProvider: () => null }))

vi.mock('capnweb', () => ({
  newWebSocketRpcSession: () => ({ onRpcBroken: testState.onRpcBroken }),
}))

vi.mock('./router', () => ({
  createRouter: () => ({ load: testState.load }),
}))

vi.mock('./RpcContext', () => ({ RpcContext: { Provider: () => null } }))
vi.mock('./ServerConfigContext', () => ({
  ServerConfigContext: { Provider: () => null },
  ServerConfigErrorContext: { Provider: () => null },
}))
vi.mock('./ThemeContext', () => ({ ThemeProvider: () => null }))
vi.mock('./components/AnnouncementBanner', () => ({ default: () => null }))
vi.mock('./FrontendErrorBoundary', () => ({ default: () => null }))
vi.mock('./errorReporting', () => ({
  installWorkshopErrorReporting: () => {},
  reportIssue: () => {},
}))
vi.mock('./locale', () => ({
  initializeLocale: () => {},
  localizedHomePath: (locale: 'en' | 'zh') => locale === 'en' ? '/' : '/zh',
}))
vi.mock('./siteLogoUtils', () => ({
  applySiteFavicon: () => {},
  cacheBustSiteLogoUrl: (url: string) => url,
}))
vi.mock('./theme', () => ({
  applyAccentColor: () => {},
  applyStoredThemeMode: () => {},
}))
vi.mock('./useAuth', () => ({ CF_ACCESS_MODE: false }))

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>(complete => {
    resolve = () => complete()
  })
  return { promise, resolve }
}

describe('Workshop client entry', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubEnv('VITE_DEV_AUTO_LOGIN', 'false')
    localStorage.clear()
    document.documentElement.lang = 'en'
    document.body.replaceChildren()
    window.history.replaceState({}, '', '/')
    testState.createRoot.mockReturnValue({ render: testState.render })
    testState.load.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    localStorage.clear()
    document.body.replaceChildren()
    window.history.replaceState({}, '', '/')
  })

  it.each([
    { path: '/', locale: 'en' },
    { path: '/zh', locale: 'zh' },
  ] as const)('loads the client router before hydrating the $locale prerender', async ({ path, locale }) => {
    const routerLoad = deferred()
    testState.load.mockReturnValue(routerLoad.promise)
    document.documentElement.lang = locale
    window.history.replaceState({}, '', path)
    document.body.innerHTML = `<div id="root" data-prerendered-locale="${locale}"><p>server markup</p></div>`
    const rootElement = document.getElementById('root')!
    const serverNode = rootElement.firstElementChild

    await import('./main')

    expect(testState.load).toHaveBeenCalledOnce()
    expect(testState.hydrateRoot).not.toHaveBeenCalled()
    expect(testState.createRoot).not.toHaveBeenCalled()
    expect(rootElement.firstElementChild).toBe(serverNode)

    routerLoad.resolve()
    await vi.waitFor(() => expect(testState.hydrateRoot).toHaveBeenCalledOnce())

    expect(testState.load.mock.invocationCallOrder[0])
      .toBeLessThan(testState.hydrateRoot.mock.invocationCallOrder[0])
    expect(testState.hydrateRoot.mock.calls[0][0]).toBe(rootElement)
    expect(testState.createRoot).not.toHaveBeenCalled()
    expect(rootElement.firstElementChild).toBe(serverNode)
  })

  it('falls back to a client root when prerender router loading fails', async () => {
    testState.load.mockRejectedValue(new Error('route load failed'))
    document.body.innerHTML = '<div id="root" hidden data-prerendered-locale="en"><p>server markup</p></div>'
    const rootElement = document.getElementById('root')!

    await import('./main')

    await vi.waitFor(() => expect(testState.createRoot).toHaveBeenCalledOnce())
    expect(testState.load).toHaveBeenCalledOnce()
    expect(testState.hydrateRoot).not.toHaveBeenCalled()
    expect(testState.createRoot.mock.calls[0][0]).toBe(rootElement)
    expect(testState.render).toHaveBeenCalledOnce()
    expect(rootElement.childNodes).toHaveLength(0)
  })

  it('keeps the non-prerendered createRoot path immediate', async () => {
    window.history.replaceState({}, '', '/workspaces')
    document.body.innerHTML = '<div id="root"><p>stale markup</p></div>'
    const rootElement = document.getElementById('root')!

    await import('./main')

    expect(testState.load).not.toHaveBeenCalled()
    expect(testState.hydrateRoot).not.toHaveBeenCalled()
    expect(testState.createRoot).toHaveBeenCalledOnce()
    expect(testState.createRoot.mock.calls[0][0]).toBe(rootElement)
    expect(testState.render).toHaveBeenCalledOnce()
    expect(rootElement.childNodes).toHaveLength(0)
  })
})
