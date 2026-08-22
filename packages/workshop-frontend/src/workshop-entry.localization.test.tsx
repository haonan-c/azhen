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
import type { AuthenticatedApi, PublicApi, ServerConfig } from '@gadgets/workshop-shared/api'
import { RpcContext } from './RpcContext'
import { ServerConfigContext, ServerConfigErrorContext } from './ServerConfigContext'
import { deLocalizeUrl, localizeUrl } from './paraglide/runtime.js'

vi.mock('hash-wasm', () => ({
  argon2id: async () => new Uint8Array([1, 2, 3]),
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  TooltipProvider: ({ children }: { children: ReactNode }) => children,
  Toasty: ({ children }: { children: ReactNode }) => children,
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

vi.mock('./main', () => ({ markConnectionRestored: vi.fn<() => void>() }))
vi.mock('./FeatureFlagsContext', () => ({
  FeatureFlagsProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('./components/AppShell/AppShell', () => ({
  default: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('./components/Header', () => ({ default: () => null }))
vi.mock('./AddModelModal', () => ({ default: () => null }))
vi.mock('./components/MeshBackground', () => ({ default: () => null }))
vi.mock('./ThemeContext', () => ({
  useTheme: () => ({ resolvedThemeMode: 'light' }),
}))
vi.mock('./ChatInterface', () => ({
  ChatInput: () => <textarea aria-label="Prompt" />,
}))

import { RootComponent } from './routes/__root'
import { HomePageContent } from './routes/index'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
window.scrollTo = () => {}

const serverConfig = {
  accentColor: '',
  announcement: '',
  authVendors: [],
  banner: '',
  bannerColor: 'neutral',
  passwordAuthEnabled: true,
  signupsEnabled: true,
  siteName: '',
} satisfies ServerConfig

function setInput(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setValue.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function makeRouter() {
  const rootRoute = createRootRoute({ component: RootComponent })
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <div data-destination="home"><HomePageContent /></div>,
  })
  const signupRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/signup',
    component: () => null,
  })
  return createRouter({
    history: createMemoryHistory({ initialEntries: ['/'] }),
    routeTree: rootRoute.addChildren([homeRoute, signupRoute]),
    rewrite: {
      input: ({ url }) => deLocalizeUrl(url),
      output: ({ url }) => localizeUrl(url),
    },
  })
}

describe('localized sign-in to Workshop Home journey', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    localStorage.clear()
    window.history.replaceState({}, '', '/')
    document.title = ''
    vi.clearAllMocks()
    root = undefined
    container = undefined
  })

  it.each([
    { path: '/', heading: 'What are we working on?', signIn: 'Sign in' },
    { path: '/zh', heading: '今天要处理什么？', signIn: '登录' },
  ])('signs in at $path and arrives at Workshop Home in the same locale', async (expected) => {
    window.history.replaceState({}, '', expected.path)
    let resolveOnboardingStatus!: (completed: boolean) => void
    const onboardingStatus = new Promise<boolean>((resolve) => { resolveOnboardingStatus = resolve })
    const completeOnboarding = vi.fn<() => Promise<void>>(async () => {})
    const authenticatedApi = {
      amIAdmin: async () => false,
      completeOnboarding,
      isOnboardingCompleted: () => onboardingStatus,
      listGatekeeperVendors: async () => [],
      listModels: async () => [{ type: 'agent', id: 'model-1', name: 'Model 原名' } as const],
      getPreferredModel: async () => 'model-1',
      setPreferredModel: async () => {},
      subscribeConnectedAccounts: () => Object.assign(
        Promise.resolve({ [Symbol.dispose]: vi.fn<() => void>() }),
        { [Symbol.dispose]: vi.fn<() => void>() },
      ),
      whoami: async () => ({ type: 'user', id: 'user-1', name: '用户 原名' } as const),
      [Symbol.dispose]: vi.fn<() => void>(),
    } as unknown as RpcStub<AuthenticatedApi>
    const login = vi.fn<PublicApi['login']>(async () => 'new-token')
    const authenticate = vi.fn<(token: string) => typeof authenticatedApi>(
      (_token) => authenticatedApi,
    )
    const publicApi = { authenticate, login } as unknown as RpcStub<PublicApi>
    const router = makeRouter()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ServerConfigErrorContext.Provider value={false}>
        <ServerConfigContext.Provider value={serverConfig}>
          <RpcContext.Provider value={{ stub: publicApi, connectionLost: false }}>
            <RouterProvider router={router} />
          </RpcContext.Provider>
        </ServerConfigContext.Provider>
      </ServerConfigErrorContext.Provider>,
    ))

    const username = container!.querySelector<HTMLInputElement>('input[autocomplete="username"]')!
    const password = container!.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!
    await act(async () => {
      setInput(username, 'merchant')
      setInput(password, 'valid-password')
    })
    const submit = [...container!.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === expected.signIn)!
    await act(async () => submit.click())

    const checking = expected.path === '/zh' ? '正在检查初始设置…' : 'Checking setup...'
    await vi.waitFor(() => expect(container?.querySelector('[role="status"]')?.textContent)
      .toBe(checking))
    await act(async () => resolveOnboardingStatus(false))

    const onboardingTitle = expected.path === '/zh' ? '完成初始设置' : "Let's set you up"
    const nextLabel = expected.path === '/zh' ? '下一步' : 'Next'
    const finishLabel = expected.path === '/zh' ? '开始使用' : "Let's build"
    await vi.waitFor(() => expect(container?.textContent).toContain(onboardingTitle))
    const findButton = (label: string) => [...container!.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === label)!
    await act(async () => findButton(nextLabel).click())
    await act(async () => findButton(finishLabel).click())

    await vi.waitFor(() => expect(container?.querySelector('[data-destination="home"]')).not.toBeNull())
    expect(container?.textContent).toContain(expected.heading)
    expect(container?.textContent).toContain(expected.path === '/zh' ? '提出问题、创建成果' : 'Ask a question, create an output')
    expect(login).toHaveBeenCalledOnce()
    expect(authenticate).toHaveBeenCalledWith('new-token')
    expect(completeOnboarding).toHaveBeenCalledOnce()
    expect(localStorage.getItem('authToken')).toBe('new-token')
    expect(window.location.pathname).toBe(expected.path)
  })
})
