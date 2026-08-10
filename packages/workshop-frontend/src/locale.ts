import {
  deLocalizeHref,
  deLocalizeUrl,
  extractLocaleFromUrl,
  localizeHref,
  localizeUrl,
  toLocale,
  type Locale,
} from './paraglide/runtime.js'

const LOCALE_PREFERENCE_KEY = 'PARAGLIDE_LOCALE'
const BARE_ROOT_RESOLVED_KEY = 'azhen.bareRootLocaleResolved'

type InitialLocaleInput = {
  href: string
  savedLocale: string | null
  hasVisitedBareRoot: boolean
  browserLanguages: readonly string[]
}

type InitialLocaleResult = {
  locale: Locale
  href: string
  markBareRootVisited: boolean
}

function resolveBrowserLocale(browserLanguages: readonly string[]): Locale {
  for (const language of browserLanguages) {
    const locale = toLocale(language) ?? toLocale(language.split('-')[0])
    if (locale) return locale
  }
  return 'en'
}

/** Resolve and canonicalize the active locale before the SPA starts. */
export function resolveInitialLocale({
  href,
  savedLocale,
  hasVisitedBareRoot,
  browserLanguages,
}: InitialLocaleInput): InitialLocaleResult {
  const url = new URL(href)
  let locale: Locale
  let markBareRootVisited = false

  if (url.pathname === '/en' || url.pathname.startsWith('/en/')) {
    url.pathname = url.pathname.slice(3) || '/'
    locale = 'en'
  } else if (url.pathname === '/') {
    if (savedLocale === 'en' || savedLocale === 'zh') {
      locale = savedLocale
    } else if (!hasVisitedBareRoot) {
      locale = resolveBrowserLocale(browserLanguages)
      markBareRootVisited = true
    } else {
      locale = 'en'
    }

  } else {
    locale = extractLocaleFromUrl(url) ?? 'en'
  }

  const canonicalUrl = localizeUrl(deLocalizeUrl(url), { locale })
  return { locale, href: canonicalUrl.href, markBareRootVisited }
}

/** Apply URL normalization and document locale before React and the router start. */
export function initializeLocale(): Locale {
  const result = resolveInitialLocale({
    href: window.location.href,
    savedLocale: localStorage.getItem(LOCALE_PREFERENCE_KEY),
    hasVisitedBareRoot: localStorage.getItem(BARE_ROOT_RESOLVED_KEY) === '1',
    browserLanguages: navigator.languages,
  })

  if (result.markBareRootVisited) localStorage.setItem(BARE_ROOT_RESOLVED_KEY, '1')
  if (result.href !== window.location.href) {
    window.history.replaceState(window.history.state, '', result.href)
  }
  document.documentElement.lang = result.locale
  return result.locale
}

/** Return the localized Workshop Home URL for a completed sign-up. */
export function getWorkshopHomeHref(href: string = window.location.href): string {
  const locale = extractLocaleFromUrl(new URL(href)) ?? 'en'
  return localizeHref('/', { locale })
}

/** Save an explicit locale choice and navigate to the equivalent localized URL. */
export function changeLocale(
  locale: Locale,
  navigate: (href: string) => void = href => window.location.assign(href),
): void {
  const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`
  const href = localizeHref(deLocalizeHref(currentHref), { locale })

  localStorage.setItem(LOCALE_PREFERENCE_KEY, locale)
  document.documentElement.lang = locale
  navigate(href)
}
