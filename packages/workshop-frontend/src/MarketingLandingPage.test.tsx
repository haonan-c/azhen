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
import type { AnonymousAngleRunResponse } from '@gadgets/workshop-shared/anonymous-angle-run'
import type { ServerConfig } from '@gadgets/workshop-shared/api'
import type { AngleWallEntry } from './angleWall'
import MarketingLandingPage, {
  ANONYMOUS_ANGLE_RUN_SESSION_KEY,
} from './MarketingLandingPage'
import { ServerConfigContext } from './ServerConfigContext'
import { deLocalizeUrl, localizeUrl } from './paraglide/runtime.js'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

const localeCases = [
  {
    href: '/',
    locale: 'en',
    product: 'A fixture skin serum',
    market: 'First-time buyers in the US',
    resultHeading: 'Your 3 testable Ad Angles',
    selectedCallToAction: 'Create a free account to save it',
    limit: 'This anonymous run is complete.',
    unavailable: 'Anonymous Angle Run is not enabled on this deployment yet.',
    wallHeading: 'What AI UGC ads are actually made of',
    faqHeading: 'Frequently asked questions',
    signupHref: '/signup',
    rootHref: '/',
    angles: [
      {
        name: 'Fixture angle one',
        tension: 'Fixture tension one',
        hypothesis: 'Fixture hypothesis one',
        openingHook: 'Fixture Hook one',
        worthTesting: 'Fixture reason one',
      },
      {
        name: 'Fixture angle two',
        tension: 'Fixture tension two',
        hypothesis: 'Fixture hypothesis two',
        openingHook: 'Fixture Hook two',
        worthTesting: 'Fixture reason two',
      },
      {
        name: 'Fixture angle three',
        tension: 'Fixture tension three',
        hypothesis: 'Fixture hypothesis three',
        openingHook: 'Fixture Hook three',
        worthTesting: 'Fixture reason three',
      },
    ] as const,
  },
  {
    href: '/zh',
    locale: 'zh',
    product: '测试用护肤精华',
    market: '美国首次购买者',
    resultHeading: '你的 3 个可测试广告角度',
    selectedCallToAction: '免费注册并保存这个角度',
    limit: '这次匿名生成已经完成。',
    unavailable: '这个部署尚未开放匿名广告角度生成。',
    wallHeading: 'AI UGC 广告到底由什么构成',
    faqHeading: '常见问题',
    signupHref: '/zh/signup',
    rootHref: '/zh',
    angles: [
      {
        name: '测试角度一',
        tension: '测试人群张力一',
        hypothesis: '测试假设一',
        openingHook: '测试 Hook 一',
        worthTesting: '测试理由一',
      },
      {
        name: '测试角度二',
        tension: '测试人群张力二',
        hypothesis: '测试假设二',
        openingHook: '测试 Hook 二',
        worthTesting: '测试理由二',
      },
      {
        name: '测试角度三',
        tension: '测试人群张力三',
        hypothesis: '测试假设三',
        openingHook: '测试 Hook 三',
        worthTesting: '测试理由三',
      },
    ] as const,
  },
] satisfies ReadonlyArray<{
  href: string
  locale: 'en' | 'zh'
  product: string
  market: string
  resultHeading: string
  selectedCallToAction: string
  limit: string
  unavailable: string
  wallHeading: string
  faqHeading: string
  signupHref: string
  rootHref: string
  angles: AnonymousAngleRunResponse['angles']
}>

function successResponse(angles: AnonymousAngleRunResponse['angles']): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ angles }),
  } as Response
}

function unavailableResponse(): Response {
  return {
    ok: false,
    status: 503,
    json: async () => ({ error: 'unavailable' }),
  } as Response
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('Marketing Landing Page', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    localStorage.clear()
    sessionStorage.clear()
    window.history.replaceState({}, '', '/')
    document.documentElement.lang = 'en'
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
    root = undefined
    container = undefined
  })

  async function renderPage({
    href = '/',
    config = baseConfig,
    onSignIn = vi.fn<() => void>(),
    angleWallEntries,
  }: {
    href?: string
    config?: ServerConfig
    onSignIn?: () => void
    angleWallEntries?: readonly AngleWallEntry[]
  } = {}) {
    window.history.replaceState({}, '', href)
    const rootRoute = createRootRoute()
    const homeRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => (
        <MarketingLandingPage
          onSignIn={onSignIn}
          angleWallEntries={angleWallEntries}
        />
      ),
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
    await router.load()
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

  async function submitRun(product: string, market: string) {
    const productInput = container!.querySelector<HTMLInputElement>('input[name="product"]')!
    const marketInput = container!.querySelector<HTMLInputElement>('input[name="market"]')!
    const form = container!.querySelector<HTMLFormElement>('[data-marketing-tool] form')!
    await act(async () => {
      setInputValue(productInput, product)
      setInputValue(marketInput, market)
    })
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }

  it.each(localeCases)(
    'inserts one localized result section, keeps the page mounted, and limits a second run at $href',
    async ({ href, locale, product, market, resultHeading, selectedCallToAction, limit, angles }) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successResponse(angles))
      vi.stubGlobal('fetch', fetchMock)
      Object.defineProperty(Element.prototype, 'scrollIntoView', {
        configurable: true,
        value: vi.fn<Element['scrollIntoView']>(),
      })
      await renderPage({ href })

      await submitRun(product, market)

      const tool = container!.querySelector<HTMLElement>('[data-marketing-tool]')!
      const results = container!.querySelector<HTMLElement>('#anonymous-angle-results')!
      expect(tool.nextElementSibling).toBe(results)
      expect(results.querySelector('h2')?.textContent).toBe(resultHeading)
      expect(results.querySelectorAll('[data-angle-card]')).toHaveLength(3)
      expect(container!.querySelector('#marketing-steps')).not.toBeNull()
      expect(container!.querySelector('#marketing-faq')).not.toBeNull()
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
        product,
        market,
        locale,
      })

      await act(async () => results.querySelectorAll<HTMLButtonElement>('[data-angle-card] button')[1].click())
      const resultSignup = results.querySelector<HTMLAnchorElement>('a[href]')!
      expect(resultSignup.textContent).toContain(selectedCallToAction)

      const productInput = container!.querySelector<HTMLInputElement>('input[name="product"]')!
      await act(async () => setInputValue(productInput, `${product} revised`))
      await act(async () => {
        container!.querySelector<HTMLFormElement>('[data-marketing-tool] form')!
          .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })

      expect(fetchMock).toHaveBeenCalledOnce()
      expect(results.textContent).toContain(limit)
      expect(results.querySelectorAll('[data-angle-card]')).toHaveLength(3)
    },
  )

  it('keeps stored angles bound to the normalized inputs that produced them', async () => {
    const { product, market, angles } = localeCases[0]
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(successResponse(angles))
    vi.stubGlobal('fetch', fetchMock)
    await renderPage()

    await submitRun(`  ${product}  `, `  ${market}  `)
    const productInput = container!.querySelector<HTMLInputElement>('input[name="product"]')!
    const marketInput = container!.querySelector<HTMLInputElement>('input[name="market"]')!
    await act(async () => {
      setInputValue(productInput, 'A different product')
      setInputValue(marketInput, 'A different market')
    })
    const results = container!.querySelector<HTMLElement>('#anonymous-angle-results')!
    await act(async () => results.querySelectorAll<HTMLButtonElement>('[data-angle-card] button')[1].click())
    await act(async () => results.querySelector<HTMLAnchorElement>('a[href]')!.click())

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      product,
      market,
      locale: 'en',
    })
    expect(JSON.parse(sessionStorage.getItem(ANONYMOUS_ANGLE_RUN_SESSION_KEY) ?? 'null')).toEqual({
      version: 1,
      locale: 'en',
      product,
      market,
      angles,
      selectedIndex: 1,
    })
  })

  it.each(localeCases)(
    'uses only enabled registry rows and omits unverified sections at $href',
    async ({ href, rootHref, faqHeading }) => {
      await renderPage({ href })

      const siteLinks = [...container!.querySelectorAll<HTMLAnchorElement>('[data-site-page-link]')]
      expect(siteLinks.map(link => link.getAttribute('href'))).toEqual([rootHref])
      expect(container!.querySelector('a[href*="pricing"]')).toBeNull()
      expect(container!.querySelector('a[href*="privacy"]')).toBeNull()
      expect(container!.querySelector('a[href*="terms"]')).toBeNull()
      expect(container!.querySelector('a[href*="hub"]')).toBeNull()
      expect(container!.querySelector('#marketing-wall')).toBeNull()
      expect(container!.querySelector('#marketing-proof')).toBeNull()
      expect(container!.querySelector('#marketing-faq h2')?.textContent).toBe(faqHeading)
      const faqItems = container!.querySelectorAll<HTMLDetailsElement>('#marketing-faq details')
      expect(faqItems).toHaveLength(8)
      expect(faqItems[0].open).toBe(true)
    },
  )

  it.each(localeCases)('renders injected Angle Wall data in native closed and open states at $href', async ({
    href,
    wallHeading,
  }) => {
    const fixture: AngleWallEntry = {
      id: 'fixture-entry',
      industry: 'Fixture industry',
      platform: 'Fixture platform',
      angleName: 'Fixture angle',
      tension: 'Fixture tension',
      hypothesis: 'Fixture hypothesis',
      openingHook: 'Fixture opening Hook',
      scriptExcerpt: 'Fixture script excerpt that exists only in this component test.',
      producedOn: '2026-08-14',
    }
    await renderPage({ href, angleWallEntries: [fixture] })

    const wall = container!.querySelector<HTMLElement>('#marketing-wall')!
    const details = wall.querySelector<HTMLDetailsElement>('details')!
    expect(wall.querySelector('h2')?.textContent).toBe(wallHeading)
    expect(details.open).toBe(false)
    expect(details.textContent).toContain(fixture.tension)
    expect(details.textContent).toContain(fixture.hypothesis)
    expect(details.textContent).toContain(fixture.openingHook)
    expect(details.textContent).toContain(fixture.scriptExcerpt)
    act(() => {
      details.open = true
    })
    expect(details.open).toBe(true)
  })

  it.each(localeCases)('shows the honest unavailable state without Ad Angle cards at $href', async ({
    href,
    product,
    market,
    unavailable,
  }) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(unavailableResponse()))
    await renderPage({ href })

    await submitRun(product, market)

    expect(container!.querySelector('[data-marketing-error]')?.textContent).toContain(unavailable)
    expect(container!.querySelectorAll('[data-angle-card]')).toHaveLength(0)
    expect(container!.querySelector('#anonymous-angle-results')).toBeNull()
  })

  it.each(localeCases)('persists the localized input, three Ad Angles, and selection before registration at $href', async ({
    href,
    locale,
    product,
    market,
    signupHref,
    angles,
  }) => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(successResponse(angles)))
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn<Element['scrollIntoView']>(),
    })
    await renderPage({ href })
    await submitRun(product, market)

    const results = container!.querySelector<HTMLElement>('#anonymous-angle-results')!
    await act(async () => results.querySelectorAll<HTMLButtonElement>('[data-angle-card] button')[2].click())
    const signup = results.querySelector<HTMLAnchorElement>('a[href]')!
    expect(signup.getAttribute('href')).toBe(signupHref)
    await act(async () => signup.click())

    expect(JSON.parse(sessionStorage.getItem(ANONYMOUS_ANGLE_RUN_SESSION_KEY) ?? 'null')).toEqual({
      version: 1,
      locale,
      product,
      market,
      angles,
      selectedIndex: 2,
    })
  })

  it('restores a stored Anonymous Angle Run when the locale matches', async () => {
    const english = localeCases[0]
    sessionStorage.setItem(ANONYMOUS_ANGLE_RUN_SESSION_KEY, JSON.stringify({
      version: 1,
      locale: english.locale,
      product: english.product,
      market: english.market,
      angles: english.angles,
      selectedIndex: 1,
    }))

    await renderPage({ href: english.href })

    expect(container!.querySelector<HTMLInputElement>('input[name="product"]')?.value)
      .toBe(english.product)
    expect(container!.querySelector<HTMLInputElement>('input[name="market"]')?.value)
      .toBe(english.market)
    const results = container!.querySelector<HTMLElement>('#anonymous-angle-results')!
    expect(results.querySelector('h2')?.textContent).toBe(english.resultHeading)
    expect(results.querySelectorAll('[data-angle-card]')).toHaveLength(3)
    expect(results.textContent).toContain(english.angles[1].name)
  })

  it('does not restore a stored Anonymous Angle Run after a locale change', async () => {
    const english = localeCases[0]
    const chinese = localeCases[1]
    const stored = {
      version: 1,
      locale: english.locale,
      product: english.product,
      market: english.market,
      angles: english.angles,
      selectedIndex: 1,
    }
    sessionStorage.setItem(ANONYMOUS_ANGLE_RUN_SESSION_KEY, JSON.stringify(stored))

    await renderPage({ href: chinese.href })

    expect(container!.querySelector<HTMLInputElement>('input[name="product"]')?.value).toBe('')
    expect(container!.querySelector<HTMLInputElement>('input[name="market"]')?.value).toBe('')
    expect(container!.querySelector('#anonymous-angle-results')).toBeNull()
    expect(JSON.parse(sessionStorage.getItem(ANONYMOUS_ANGLE_RUN_SESSION_KEY) ?? 'null'))
      .toEqual(stored)
  })

  it('keeps administrator site branding and the uploaded logo behavior', async () => {
    await renderPage({
      config: {
        ...baseConfig,
        siteName: 'Merchant Desk',
        siteLogo: { url: '/deployment-logo.png' },
      },
    })

    const brandLink = container!.querySelector<HTMLAnchorElement>('header a[aria-label="Merchant Desk"]')!
    expect(brandLink.querySelector<HTMLImageElement>('img')?.getAttribute('src'))
      .toBe('/deployment-logo.png')
    expect(container!.querySelector('footer')?.textContent).toContain('Merchant Desk')
  })
})
