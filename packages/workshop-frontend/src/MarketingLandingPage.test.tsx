// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerConfig } from '@gadgets/workshop-shared/api'
import MarketingLandingPage from './MarketingLandingPage'
import { ServerConfigContext } from './ServerConfigContext'
import { deLocalizeUrl, localizeUrl } from './paraglide/runtime.js'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
window.scrollTo = () => {}

const baseConfig = {
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

describe('Marketing Landing Page', () => {
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

  async function renderPage({
    href = '/',
    config = baseConfig,
    onSignIn = vi.fn<() => void>(),
  }: {
    href?: string
    config?: ServerConfig
    onSignIn?: () => void
  } = {}) {
    window.history.replaceState({}, '', href)
    const rootRoute = createRootRoute()
    const homeRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <MarketingLandingPage onSignIn={onSignIn} />,
    })
    const signupRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/signup',
      component: () => null,
    })
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ['/'] }),
      routeTree: rootRoute.addChildren([homeRoute, signupRoute]),
      rewrite: {
        input: ({ url }) => deLocalizeUrl(url),
        output: ({ url }) => localizeUrl(url),
      },
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ServerConfigContext.Provider value={config}>
        <RouterProvider router={router} />
      </ServerConfigContext.Provider>,
    ))
    return { onSignIn }
  }

  it.each([
    {
      href: '/',
      category: 'E-commerce Operations AI Workspace',
      heading: 'From brief to usable result.',
      audience: 'individual merchants, e-commerce operators, and small teams',
      workflow: 'Move from question to working output',
      capabilities: 'Choose the right tool for the operation',
      security: 'Your tools stay behind controlled access',
      templates: 'Reuse the work. Bring in the team.',
      finalCallToAction: 'Make the next operation task concrete.',
      screenshot: '/marketing/product-evidence-en.jpg',
      mobileScreenshot: '/marketing/product-evidence-en-mobile.jpg',
      screenshotAlt: 'azhen Workshop showing a fictional Xiaohongshu benchmark-content analysis and an editable result',
    },
    {
      href: '/zh',
      category: '电商运营 AI 工作台',
      heading: '从任务到可用成果。',
      audience: '个体商家、电商运营者和小团队',
      workflow: '让问题一步步变成可用成果',
      capabilities: '为运营任务选对工具',
      security: '工具和数据只在受控范围内使用',
      templates: '复用已有工作，与团队继续推进。',
      finalCallToAction: '把下一个运营任务变成具体成果。',
      screenshot: '/marketing/product-evidence-zh.jpg',
      mobileScreenshot: '/marketing/product-evidence-zh-mobile.jpg',
      screenshotAlt: '阿珍工作台展示使用虚构数据的小红书对标内容分析和可编辑成果',
    },
  ])('renders the complete localized page and matching product evidence at $href', async ({
    href,
    category,
    heading,
    audience,
    workflow,
    capabilities,
    security,
    templates,
    finalCallToAction,
    screenshot,
    mobileScreenshot,
    screenshotAlt,
  }) => {
    await renderPage({ href })

    expect(container?.textContent).toContain(category)
    expect(container?.querySelector('h1')?.textContent).toBe(heading)
    expect(container?.textContent).toContain(audience)
    expect(container?.querySelector('#workflow')?.textContent).toContain(workflow)
    expect(container?.querySelector('#capabilities')?.textContent).toContain(capabilities)
    expect(container?.querySelector('#security')?.textContent).toContain(security)
    expect(container?.querySelector('#templates')?.textContent).toContain(templates)
    expect(container?.querySelector('#get-started')?.textContent).toContain(finalCallToAction)
    expect(container?.querySelector('footer')).not.toBeNull()

    const image = container?.querySelector<HTMLImageElement>(`img[src="${screenshot}"]`)
    expect(image?.alt).toBe(screenshotAlt)
    expect(container?.querySelector<HTMLSourceElement>('picture source')?.srcset)
      .toContain(mobileScreenshot)
  })

  it.each([
    { href: '/', createAccount: 'Create account', signIn: 'Sign in', signupHref: '/signup' },
    { href: '/zh', createAccount: '创建账户', signIn: '登录', signupHref: '/zh/signup' },
  ])('offers localized sign-up and sign-in actions when registration is enabled at $href', async ({
    href,
    createAccount,
    signIn,
    signupHref,
  }) => {
    const onSignIn = vi.fn<() => void>()
    await renderPage({ href, onSignIn })
    const hero = container!.querySelector<HTMLElement>('#marketing-hero')!
    const signup = [...hero.querySelectorAll<HTMLAnchorElement>('a')]
      .find(link => link.textContent?.trim() === createAccount)
    const signInButton = [...hero.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === signIn)

    expect(signup?.getAttribute('href')).toBe(signupHref)
    expect(signInButton).toBeDefined()
    await act(async () => signInButton!.click())
    expect(onSignIn).toHaveBeenCalledOnce()
  })

  it.each([
    { href: '/', createAccount: 'Create account', signIn: 'Sign in' },
    { href: '/zh', createAccount: '创建账户', signIn: '登录' },
  ])('uses sign-in as the primary action when registration is disabled at $href', async ({
    href,
    createAccount,
    signIn,
  }) => {
    const onSignIn = vi.fn<() => void>()
    await renderPage({
      href,
      onSignIn,
      config: { ...baseConfig, signupsEnabled: false },
    })
    const hero = container!.querySelector<HTMLElement>('#marketing-hero')!
    const signInButtons = [...hero.querySelectorAll<HTMLButtonElement>('button')]
      .filter(button => button.textContent?.trim() === signIn)

    expect(hero.textContent).not.toContain(createAccount)
    expect(signInButtons).toHaveLength(2)
    await act(async () => signInButtons[0].click())
    expect(onSignIn).toHaveBeenCalledOnce()
  })

  it('uses administrator branding and preserves uploaded-logo behavior', async () => {
    await renderPage({
      config: {
        ...baseConfig,
        siteName: 'Merchant Desk',
        siteLogo: { url: '/deployment-logo.png' },
      },
    })

    const brandLink = container?.querySelector<HTMLAnchorElement>('header a[aria-label="Merchant Desk"]')
    expect(brandLink?.querySelector<HTMLImageElement>('img')?.getAttribute('src'))
      .toBe('/deployment-logo.png')
    expect(container?.querySelector('footer')?.textContent).toContain('Merchant Desk')
  })

  it.each([
    {
      href: '/',
      open: 'Open navigation menu',
      close: 'Close navigation menu',
      workflow: 'How it works',
    },
    {
      href: '/zh',
      open: '打开导航菜单',
      close: '关闭导航菜单',
      workflow: '工作方式',
    },
  ])('supports the localized mobile navigation with keyboard dismissal at $href', async ({
    href,
    open,
    close,
    workflow,
  }) => {
    await renderPage({ href })
    const menuButton = container!.querySelector<HTMLButtonElement>(`button[aria-label="${open}"]`)

    expect(menuButton?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => menuButton!.click())
    expect(menuButton?.getAttribute('aria-expanded')).toBe('true')
    expect(menuButton?.getAttribute('aria-label')).toBe(close)
    expect(container?.querySelector('#marketing-mobile-navigation')?.textContent).toContain(workflow)

    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(menuButton?.getAttribute('aria-expanded')).toBe('false')
    expect(container?.querySelector('#marketing-mobile-navigation')).toBeNull()
  })
})
