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
import type {
  AuthenticatedApi,
  LoginAttempt,
  PublicApi,
  ServerConfig,
} from '@gadgets/workshop-shared/api'
import LoginPage from './LoginPage'
import SignupPage from './SignupPage'
import { RpcContext } from './RpcContext'
import { ServerConfigContext, ServerConfigErrorContext } from './ServerConfigContext'
import { AuthProvider } from './AuthContext'
import UserMenu from './components/UserMenu'
import { deLocalizeUrl, localizeUrl } from './paraglide/runtime.js'

vi.mock('hash-wasm', () => ({
  argon2id: async () => new Uint8Array([1, 2, 3]),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
window.scrollTo = () => {}

const publicApi = {} as RpcStub<PublicApi>
const authenticatedApi = {
  amIAdmin: async () => false,
  getAvatar: async () => null,
  whoami: async () => ({ type: 'user', id: 'user-1', name: 'Test user' } as const),
} as unknown as RpcStub<AuthenticatedApi>
const serverConfig = {
  accentColor: '',
  announcement: '',
  authVendors: [],
  banner: '',
  bannerColor: 'neutral',
  cloudflareLimitsEnabled: false,
  passwordAuthEnabled: true,
  signupsEnabled: true,
  siteName: '',
} satisfies ServerConfig

function setInput(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setValue.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function selectLanguage(select: HTMLSelectElement, locale: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  setValue.call(select, locale)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

function mockLocationAssign() {
  const implementation = Object.getOwnPropertySymbols(window.location)
    .map(symbol => (window.location as unknown as Record<symbol, unknown>)[symbol])
    .find(value => typeof value === 'object' && value !== null && 'assign' in value) as {
      assign: (href: string) => void
    }
  return vi.spyOn(implementation, 'assign').mockImplementation(() => {})
}

describe('localized authentication surfaces', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    localStorage.clear()
    window.history.replaceState({}, '', '/')
    document.documentElement.lang = 'en'
    vi.restoreAllMocks()
    root = undefined
    container = undefined
  })

  async function renderPage(
    page: ReactNode,
    config: ServerConfig | null = serverConfig,
    api: RpcStub<PublicApi> = publicApi,
    connectionLost = false,
  ) {
    const rootRoute = createRootRoute()
    const loginRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => page,
    })
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ['/'] }),
      routeTree: rootRoute.addChildren([loginRoute]),
      rewrite: {
        input: ({ url }) => deLocalizeUrl(url),
        output: ({ url }) => localizeUrl(url),
      },
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <RpcContext.Provider value={{ stub: api, connectionLost }}>
        <ServerConfigErrorContext.Provider value={false}>
          <ServerConfigContext.Provider value={config}>
            <RouterProvider router={router} />
          </ServerConfigContext.Provider>
        </ServerConfigErrorContext.Provider>
      </RpcContext.Provider>,
    ))
  }

  it('renders Chinese sign-in copy and a language selector on a protected deep link', async () => {
    window.history.replaceState({}, '', '/zh/workspace/intended?tab=files#code')

    await renderPage(<LoginPage rpcStub={publicApi} />)

    expect(container?.textContent).toContain('登录你的账户')
    expect(container?.querySelector('input[autocomplete="username"]')?.getAttribute('placeholder'))
      .toBe('输入用户名')
    expect(container?.querySelector('input[autocomplete="current-password"]')?.getAttribute('placeholder'))
      .toBe('输入密码')
    expect(container?.querySelector('button[type="submit"]')?.textContent).toContain('登录')
    expect(container?.querySelector('select[aria-label="语言"]')).not.toBeNull()
    expect(container?.querySelector<HTMLAnchorElement>('a[href="/zh/signup"]')).not.toBeNull()
    expect(window.location.pathname).toBe('/zh/workspace/intended')
    expect(window.location.search).toBe('?tab=files')
    expect(window.location.hash).toBe('#code')
  })

  it('keeps the unprefixed sign-in surface in English', async () => {
    window.history.replaceState({}, '', '/workspace/intended')

    await renderPage(<LoginPage rpcStub={publicApi} />)

    expect(container?.textContent).toContain('Sign in to your account')
    expect(container?.querySelector('input[autocomplete="username"]')?.getAttribute('placeholder'))
      .toBe('Enter your username')
    expect(container?.querySelector('select[aria-label="Language"]')).not.toBeNull()
    expect(document.title).toContain('Sign in')
  })

  it.each([
    ['sign-in', <LoginPage key="sign-in" rpcStub={publicApi} />],
    ['sign-up', <SignupPage key="sign-up" rpcStub={publicApi} />],
  ])('keeps localized loading and language controls on the %s surface', async (_name, page) => {
    window.history.replaceState({}, '', '/zh/signup')

    await renderPage(page, null, publicApi, true)

    expect(container?.textContent).toContain('无法连接服务器，正在重试…')
    expect(container?.querySelector('[role="status"]')?.getAttribute('aria-label'))
      .toBe('正在加载…')
    expect(container?.querySelector('select[aria-label="语言"]')).not.toBeNull()
  })

  it.each([
    [
      'sign-in',
      '/zh/workspace/intended?tab=files#code',
      '/workspace/intended?tab=files#code',
      <LoginPage key="sign-in" rpcStub={publicApi} />,
    ],
    [
      'sign-up',
      '/zh/signup?source=demo#form',
      '/signup?source=demo#form',
      <SignupPage key="sign-up" rpcStub={publicApi} />,
    ],
  ])('operates the %s language selector', async (_name, href, destination, page) => {
    window.history.replaceState({}, '', href)
    await renderPage(page)
    const select = container!.querySelector<HTMLSelectElement>('select[aria-label="语言"]')!
    const assign = mockLocationAssign()

    await act(async () => selectLanguage(select, 'en'))

    expect(assign).toHaveBeenCalledWith(destination)
    expect(localStorage.getItem('PARAGLIDE_LOCALE')).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it('renders the Chinese sign-up URL with localized form guidance and a language selector', async () => {
    window.history.replaceState({}, '', '/zh/signup')

    await renderPage(<SignupPage rpcStub={publicApi} />)

    expect(container?.textContent).toContain('创建你的账户')
    expect(container?.querySelector('input[autocomplete="username"]')?.getAttribute('placeholder'))
      .toBe('输入用户名')
    expect(container?.querySelector('input[autocomplete="new-password"]')?.getAttribute('placeholder'))
      .toBe('输入密码')
    expect(container?.querySelectorAll('input[autocomplete="new-password"]')[1]
      ?.getAttribute('placeholder')).toBe('再次输入密码')
    expect(container?.querySelector('button[type="submit"]')?.textContent).toContain('创建账户')
    expect(container?.querySelector('select[aria-label="语言"]')).not.toBeNull()
  })

  it('continues a successful Chinese sign-up to the Chinese Workshop Home', async () => {
    window.history.replaceState({}, '', '/zh/signup')
    const createAccount = vi.fn<PublicApi['createAccount']>(async () => 'new-token')
    const api = { createAccount } as unknown as RpcStub<PublicApi>
    const assign = mockLocationAssign()
    await renderPage(<SignupPage rpcStub={api} />, serverConfig, api)
    const username = container!.querySelector<HTMLInputElement>('input[autocomplete="username"]')!
    const passwords = container!.querySelectorAll<HTMLInputElement>('input[autocomplete="new-password"]')

    await act(async () => {
      setInput(username, 'merchant_1')
      setInput(passwords[0], 'valid-password')
      setInput(passwords[1], 'valid-password')
    })
    await act(async () => {
      container!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
    })

    await vi.waitFor(() => expect(createAccount).toHaveBeenCalledOnce())
    expect(localStorage.getItem('authToken')).toBe('new-token')
    expect(assign).toHaveBeenCalledWith('/zh')
  })

  it('localizes sign-up validation guidance', async () => {
    window.history.replaceState({}, '', '/zh/signup')
    await renderPage(<SignupPage rpcStub={publicApi} />)
    const username = container!.querySelector<HTMLInputElement>('input[autocomplete="username"]')!
    const passwords = container!.querySelectorAll<HTMLInputElement>('input[autocomplete="new-password"]')

    await act(async () => setInput(username, 'Merchant_1'))
    expect(container?.textContent).not.toContain('只能使用字母、数字和下划线，且必须以字母开头')

    await act(async () => {
      setInput(username, '1Merchant')
      setInput(passwords[0], 'short')
      setInput(passwords[1], 'different')
    })

    expect(container?.textContent).toContain('只能使用字母、数字和下划线，且必须以字母开头')
    expect(container?.textContent).toContain('密码至少需要 8 个字符')
    expect(container?.textContent).toContain('两次输入的密码不一致')
  })

  it('shows a localized known sign-in error', async () => {
    window.history.replaceState({}, '', '/zh/workspace/intended')
    const login = vi.fn<PublicApi['login']>(async () => null)
    const api = { login } as unknown as RpcStub<PublicApi>
    await renderPage(<LoginPage rpcStub={api} />, serverConfig, api)
    const username = container!.querySelector<HTMLInputElement>('input[autocomplete="username"]')!
    const password = container!.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!

    await act(async () => {
      setInput(username, 'merchant')
      setInput(password, 'valid-password')
    })
    const submit = container!.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(submit.disabled).toBe(false)
    await act(async () => submit.click())
    await vi.waitFor(() => expect(login).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(container?.textContent).toContain('用户名或密码无效'))
  }, 10_000)

  it('keeps unknown technical details inside a localized sign-in error frame', async () => {
    window.history.replaceState({}, '', '/zh/workspace/intended')
    const login = vi.fn<PublicApi['login']>(async () => {
      throw new Error('gateway trace 7F2A')
    })
    const api = { login } as unknown as RpcStub<PublicApi>
    await renderPage(<LoginPage rpcStub={api} />, serverConfig, api)
    const username = container!.querySelector<HTMLInputElement>('input[autocomplete="username"]')!
    const password = container!.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!

    await act(async () => {
      setInput(username, 'merchant')
      setInput(password, 'valid-password')
    })
    await act(async () => {
      container!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click()
    })
    await vi.waitFor(() => expect(container?.textContent).toContain('无法登录'))

    expect(container?.textContent).toContain('gateway trace 7F2A')
  })

  it('offers the language selector from the Chinese User Menu used by full-screen Workspaces', async () => {
    window.history.replaceState({}, '', '/zh/workspace/intended?tab=files#code')

    await renderPage(
      <AuthProvider authenticatedApi={authenticatedApi} onLogout={() => {}}>
        <UserMenu />
      </AuthProvider>,
    )
    await act(async () => {
      container?.querySelector<HTMLButtonElement>('[aria-label="打开个人资料菜单"]')?.click()
    })

    expect(document.body.textContent).toContain('语言')
    expect(document.body.textContent).toContain('英语')
    expect(document.body.textContent).toContain('简体中文')
    const english = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      .find(item => item.textContent?.includes('英语'))!
    const assign = mockLocationAssign()
    await act(async () => english.click())
    expect(assign).toHaveBeenCalledWith('/workspace/intended?tab=files#code')
    expect(localStorage.getItem('PARAGLIDE_LOCALE')).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })

  it('localizes the OAuth action without changing the provider name', async () => {
    window.history.replaceState({}, '', '/zh/workspace/intended')
    const oauthConfig: ServerConfig = {
      ...serverConfig,
      authVendors: [{ vendorId: 'github', displayName: 'GitHub Enterprise' }],
    }

    await renderPage(<LoginPage rpcStub={publicApi} />, oauthConfig)

    expect(container?.textContent).toContain('使用 GitHub Enterprise 继续')
    expect(container?.textContent).not.toContain('Continue with')
  })

  it('localizes a known OAuth failure', async () => {
    window.history.replaceState({}, '', '/zh/workspace/intended')
    const dispose = vi.fn<() => void>()
    const attempt = {
      wait: async () => 'unused-token',
      [Symbol.dispose]: dispose,
    } as unknown as RpcStub<LoginAttempt>
    const startGatekeeperLogin = vi.fn<PublicApi['startGatekeeperLogin']>(async () => ({
      url: 'https://auth.example.test',
      attempt,
    }))
    const api = { startGatekeeperLogin } as unknown as RpcStub<PublicApi>
    const oauthConfig: ServerConfig = {
      ...serverConfig,
      authVendors: [{ vendorId: 'github', displayName: 'GitHub' }],
    }
    vi.spyOn(window, 'open').mockReturnValue(null)

    await renderPage(<LoginPage rpcStub={api} />, oauthConfig, api)
    const oauthButton = [...container!.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('GitHub'))!
    await act(async () => oauthButton.click())
    await vi.waitFor(() => expect(container?.textContent).toContain('弹出窗口被拦截'))

    expect(dispose).toHaveBeenCalledOnce()
  })
})
