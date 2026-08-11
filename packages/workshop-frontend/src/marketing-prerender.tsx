import { renderToString } from 'react-dom/server'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import MarketingLandingPage from './MarketingLandingPage'
import { ServerConfigContext } from './ServerConfigContext'
import { localeUrlRewrite, localizedHomePath } from './locale'
import {
  getLocale,
  overwriteGetLocale,
  type Locale,
} from './paraglide/runtime.js'
import { m as messages } from './paraglide/messages.js'

export { BARE_ROOT_RESOLVED_KEY, LOCALE_PREFERENCE_KEY } from './locale'

export interface PrerenderedMarketingPage {
  body: string
  description: string
  homePath: string
  locale: Locale
  title: string
}

/** Render one localized Marketing Landing Page for a production HTML document. */
export async function renderMarketingPage(locale: Locale): Promise<PrerenderedMarketingPage> {
  const previousGetLocale = getLocale
  overwriteGetLocale(() => locale)

  try {
    const rootRoute = createRootRoute()
    const homeRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => <MarketingLandingPage onSignIn={() => undefined} />,
    })
    const signupRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/signup',
      component: () => null,
    })
    const homePath = localizedHomePath(locale)
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: [homePath] }),
      routeTree: rootRoute.addChildren([homeRoute, signupRoute]),
      rewrite: localeUrlRewrite,
    })

    await router.load()

    const brandName = messages.brand_name({}, { locale })
    const pageTitle = messages.marketing_document_title({}, { locale })
    return {
      body: renderToString(
        <ServerConfigContext.Provider value={null}>
          <RouterProvider router={router} />
        </ServerConfigContext.Provider>,
      ),
      description: messages.marketing_hero_description({}, { locale }),
      homePath,
      locale,
      title: `${pageTitle} - ${brandName}`,
    }
  } finally {
    overwriteGetLocale(previousGetLocale)
  }
}
