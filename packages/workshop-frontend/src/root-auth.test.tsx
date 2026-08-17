// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import type { RpcStub } from 'capnweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PublicApi } from '@gadgets/workshop-shared/api'
import { RpcContext } from './RpcContext'
import { RootComponent } from './routes/__root'
import {
  AUTH_TEST_USER,
  createAuthenticatedApi,
  createPublicApi,
  deferred,
} from './authTestHelpers'

const loginPage = vi.hoisted(() => ({ onLoginSuccess: undefined as (() => void) | undefined }))

vi.mock('@cloudflare/kumo', () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
  Toasty: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('./main', () => ({ markConnectionRestored: vi.fn<() => void>() }));
vi.mock('./AuthContext', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useOptionalAuthenticatedApi: () => null,
}));
vi.mock('./FeatureFlagsContext', () => ({
  FeatureFlagsProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./components/AppShell/AppShell', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./OnboardingWizard', () => ({ default: () => null }));
vi.mock('./components/billing/AccountSelectionModal', () => ({ default: () => null }));
vi.mock('./LoginPage', () => ({
  default: ({ onLoginSuccess }: { onLoginSuccess?: () => void }) => {
    loginPage.onLoginSuccess = onLoginSuccess
    return 'signed-out'
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
window.scrollTo = () => {}

function makeRouter(initialEntry: string) {
  const rootRoute = createRootRoute({ component: RootComponent })
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <div data-destination="home" />,
  })
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workspace/$id',
    component: () => <div data-destination="workspace" />,
  })
  const blueprintRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/blueprint/$id',
    component: () => <div data-destination="blueprint" />,
  })
  return createRouter({
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    routeTree: rootRoute.addChildren([homeRoute, workspaceRoute, blueprintRoute]),
  })
}

describe('root session validation', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    localStorage.clear()
    window.history.replaceState({}, '', '/')
    loginPage.onLoginSuccess = undefined
    vi.restoreAllMocks()
    root = undefined
    container = undefined
  })

  async function render(initialEntry: string, api: RpcStub<PublicApi>) {
    const router = makeRouter(initialEntry)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <RpcContext.Provider value={{ stub: api, connectionLost: false }}>
        <RouterProvider router={router} />
      </RpcContext.Provider>,
    ))
    return router
  }

  it.each(['/', '/zh'])('shows the signed-out root surface with no stored token at %s', async (href) => {
    window.history.replaceState({}, '', href)
    const api = createPublicApi(() => { throw new Error('unexpected authentication') })

    await render('/', api)

    expect(container?.textContent).toBe('signed-out')
    expect(api.authenticate).not.toHaveBeenCalled()
  })

  it.each([
    { href: '/', pending: 'Checking your session…' },
    { href: '/zh', pending: '正在验证会话…' },
  ])('shows only the neutral pending state until a stored session is valid at $href', async ({ href, pending }) => {
    window.history.replaceState({}, '', href)
    localStorage.setItem('authToken', 'stored-token')
    const identity = deferred<typeof AUTH_TEST_USER>()
    const authenticated = createAuthenticatedApi(() => identity.promise)

    await render('/', createPublicApi(() => authenticated.stub))

    expect(container?.textContent).toContain(pending)
    expect(container?.textContent).not.toContain('signed-out')
    expect(container?.querySelector('[data-destination="home"]')).toBeNull()

    await act(async () => identity.resolve(AUTH_TEST_USER))

    expect(container?.querySelector('[data-destination="home"]')).not.toBeNull()
  })

  it.each(['/', '/zh'])('clears an invalid session and shows the signed-out root surface at %s', async (href) => {
    window.history.replaceState({}, '', href)
    localStorage.setItem('authToken', 'invalid-token')
    const invalid = createAuthenticatedApi(async () => { throw new Error('Invalid session token.') })

    await render('/', createPublicApi(() => invalid.stub))

    expect(container?.textContent).toBe('signed-out')
    expect(localStorage.getItem('authToken')).toBeNull()
  })

  it.each([
    { href: '/', failure: "We couldn't verify your session", retry: 'Retry' },
    { href: '/zh', failure: '无法验证会话', retry: '重试' },
  ])('keeps a transiently failing root session and retries without changing $href', async ({ href, failure, retry }) => {
    window.history.replaceState({}, '', href)
    localStorage.setItem('authToken', 'stored-token')
    const failed = createAuthenticatedApi(async () => { throw new Error('transport failure') })
    const recovered = createAuthenticatedApi(async () => AUTH_TEST_USER)
    const api = createPublicApi(vi.fn()
      .mockReturnValueOnce(failed.stub)
      .mockReturnValueOnce(recovered.stub))
    const router = await render('/', api)

    expect(container?.textContent).toContain(failure)
    expect(container?.textContent).toContain('transport failure')
    expect(container?.textContent).toContain(retry)
    expect(localStorage.getItem('authToken')).toBe('stored-token')

    await act(async () => {
      container!.querySelector<HTMLButtonElement>('button')!.click()
    })

    expect(container?.querySelector('[data-destination="home"]')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/')
    expect(router.state.location.search).toEqual({})
    expect(router.state.location.hash).toBe('')
  })

  it.each([
    '/workspace/intended?tab=files#code',
    '/zh/workspace/intended?tab=files#code',
  ])('keeps the protected deep link after sign-in succeeds at %s', async (href) => {
    window.history.replaceState({}, '', href)
    const authenticated = createAuthenticatedApi(async () => AUTH_TEST_USER)
    const api = createPublicApi(() => authenticated.stub)
    const router = await render('/workspace/intended?tab=files#code', api)

    expect(container?.textContent).toBe('signed-out')
    localStorage.setItem('authToken', 'new-token')
    await act(async () => loginPage.onLoginSuccess?.())

    expect(container?.querySelector('[data-destination="workspace"]')).not.toBeNull()
    expect(router.state.location.pathname).toBe('/workspace/intended')
    expect(router.state.location.search).toEqual({ tab: 'files' })
    expect(router.state.location.hash).toBe('code')
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(href)
  })

  it.each([
    {
      href: '/blueprint/public-id',
      home: 'Home',
      gatekeepers: 'Gatekeepers',
      explore: 'Explore',
      language: 'Language',
      locale: 'en',
    },
    {
      href: '/zh/blueprint/public-id?tab=details#bindings',
      home: '首页',
      gatekeepers: '安全连接器',
      explore: '探索',
      language: '语言',
      locale: 'zh',
    },
  ])('keeps signed-out Blueprint access and localizes its header at $href', async ({
    href,
    home,
    gatekeepers,
    explore,
    language,
    locale,
  }) => {
    window.history.replaceState({}, '', href)
    const api = createPublicApi(() => { throw new Error('unexpected authentication') })

    await render('/blueprint/public-id?tab=details#bindings', api)

    expect(container?.querySelector('[data-destination="blueprint"]')).not.toBeNull()
    expect(container?.textContent).not.toContain('signed-out')
    expect(container?.textContent).toContain(home)
    expect(container?.textContent).toContain(gatekeepers)
    expect(container?.textContent).toContain(explore)
    const languageSelector = container?.querySelector<HTMLSelectElement>(
      `select[aria-label="${language}"]`,
    )
    expect(languageSelector?.value).toBe(locale)
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(href)
  })

  it('does not show the Blueprint Landing Page while a stored session is pending', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const identity = deferred<typeof AUTH_TEST_USER>()
    const authenticated = createAuthenticatedApi(() => identity.promise)

    await render('/blueprint/public-id', createPublicApi(() => authenticated.stub))

    expect(container?.textContent).toContain('Checking your session…')
    expect(container?.querySelector('[data-destination="blueprint"]')).toBeNull()

    await act(async () => identity.resolve(AUTH_TEST_USER))
    expect(container?.querySelector('[data-destination="blueprint"]')).not.toBeNull()
  })

  it('shows retry instead of the Blueprint Landing Page after transient validation failure', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const failed = createAuthenticatedApi(async () => { throw new Error('timeout') })

    await render('/blueprint/public-id', createPublicApi(() => failed.stub))

    expect(container?.textContent).toContain("We couldn't verify your session")
    expect(container?.querySelector('[data-destination="blueprint"]')).toBeNull()
  })

  it('disposes the authenticated capability when the root route unmounts', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const authenticated = createAuthenticatedApi(async () => AUTH_TEST_USER)

    await render('/', createPublicApi(() => authenticated.stub))
    act(() => root!.unmount())
    root = undefined

    expect(authenticated.dispose).toHaveBeenCalledOnce()
  })
})
