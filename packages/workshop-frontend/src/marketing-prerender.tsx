import { renderToString } from 'react-dom/server'
import { BRAND_NAME, localizedPath, type SiteLocale } from '@gadgets/site-config'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import MarketingLandingPage from './MarketingLandingPage'
import { marketingFaq } from './marketingContent'
import { ServerConfigContext } from './ServerConfigContext'
import { localeUrlRewrite } from './locale'
import {
  getLocale,
  overwriteGetLocale,
} from './paraglide/runtime.js'
import { m as messages } from './paraglide/messages.js'

export { BARE_ROOT_RESOLVED_KEY, LOCALE_PREFERENCE_KEY } from './locale'

/** One localized Marketing Landing Page rendered for a production HTML document. */
export interface PrerenderedMarketingPage {
  /** Server-rendered markup for the document root. */
  body: string
  /** The document meta description. */
  description: string
  /** The localized public path of the document. */
  documentPath: string
  /** The locale of the document. */
  locale: SiteLocale
  /** The Open Graph and Twitter description. */
  openGraphDescription: string
  /** The Open Graph and Twitter title. */
  openGraphTitle: string
  /** The document-level structured data objects. */
  structuredData: readonly Record<string, unknown>[]
  /** The document title. */
  title: string
}

/** Render one localized Marketing Landing Page for a production HTML document. */
export async function renderMarketingPage(
  pagePath: string,
  locale: SiteLocale,
): Promise<PrerenderedMarketingPage> {
  if (pagePath !== '/') {
    throw new Error(`No prerender component is registered for the enabled site page "${pagePath}".`)
  }

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
    const documentPath = localizedPath(pagePath, locale)
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: [documentPath] }),
      routeTree: rootRoute.addChildren([homeRoute, signupRoute]),
      rewrite: localeUrlRewrite,
    })

    await router.load()

    const faq = marketingFaq(locale)
    return {
      body: renderToString(
        <ServerConfigContext.Provider value={null}>
          <RouterProvider router={router} />
        </ServerConfigContext.Provider>,
      ),
      description: messages.marketing_meta_description({}, { locale }),
      documentPath,
      locale,
      openGraphDescription: messages.marketing_og_description({}, { locale }),
      openGraphTitle: messages.marketing_og_title({}, { locale }),
      structuredData: [
        {
          '@context': 'https://schema.org',
          '@type': 'Organization',
          name: BRAND_NAME,
        },
        {
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: BRAND_NAME,
        },
        {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: faq.map(({ question, answer }) => ({
            '@type': 'Question',
            name: question,
            acceptedAnswer: {
              '@type': 'Answer',
              text: answer,
            },
          })),
        },
      ],
      title: messages.marketing_document_title({}, { locale }),
    }
  } finally {
    overwriteGetLocale(previousGetLocale)
  }
}
