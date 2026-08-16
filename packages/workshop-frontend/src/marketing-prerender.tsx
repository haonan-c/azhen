import { renderToString } from 'react-dom/server'
import type { JSX } from 'react'
import { localizedPath, type SiteLocale } from '@gadgets/site-config'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { ServerConfigContext } from './ServerConfigContext'
import { localeUrlRewrite } from './locale'
import {
  getLocale,
  overwriteGetLocale,
} from './paraglide/runtime.js'

export { BARE_ROOT_RESOLVED_KEY, LOCALE_PREFERENCE_KEY } from './locale'

/** One localized Production Site page rendered for a production HTML document. */
export interface PrerenderedSitePage {
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

/** Document metadata supplied by one Production Site page module. */
export type PrerenderedPageMetadata = Omit<
  PrerenderedSitePage,
  'body' | 'documentPath' | 'locale'
>

/** A Production Site page component and its localized document metadata. */
export interface SitePagePrerenderer {
  /** The component rendered for this page. */
  component: () => JSX.Element
  /** Return localized document metadata for this page. */
  metadata: (locale: SiteLocale) => PrerenderedPageMetadata
}

const sitePageModules = import.meta.glob('./site-pages/**/*.tsx', {
  eager: true,
  import: 'default',
}) as Record<string, SitePagePrerenderer>

function sitePagePath(modulePath: string): string {
  const relativePath = modulePath
    .replace(/^\.\/site-pages\//u, '')
    .replace(/\.tsx$/u, '')
  if (relativePath === 'index') return '/'
  return `/${relativePath.replace(/\/index$/u, '/')}`
}

const sitePagePrerenderers: Readonly<Record<string, SitePagePrerenderer>> = Object.fromEntries(
  Object.entries(sitePageModules).map(([modulePath, prerenderer]) => [
    sitePagePath(modulePath),
    prerenderer,
  ]),
)

/** Render one localized Production Site page for a production HTML document. */
export async function renderSitePage(
  pagePath: string,
  locale: SiteLocale,
): Promise<PrerenderedSitePage> {
  const prerenderer = sitePagePrerenderers[pagePath]
  if (!prerenderer) {
    throw new Error(`No prerender component is registered for the enabled site page "${pagePath}".`)
  }

  const previousGetLocale = getLocale
  overwriteGetLocale(() => locale)

  try {
    const rootRoute = createRootRoute()
    const pageRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: pagePath,
      component: prerenderer.component,
    })
    const signupRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/signup',
      component: () => null,
    })
    const documentPath = localizedPath(pagePath, locale)
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: [documentPath] }),
      routeTree: rootRoute.addChildren([pageRoute, signupRoute]),
      rewrite: localeUrlRewrite,
    })

    await router.load()

    const metadata = prerenderer.metadata(locale)
    return {
      body: renderToString(
        <ServerConfigContext.Provider value={null}>
          <RouterProvider router={router} />
        </ServerConfigContext.Provider>,
      ),
      documentPath,
      locale,
      ...metadata,
    }
  } finally {
    overwriteGetLocale(previousGetLocale)
  }
}
