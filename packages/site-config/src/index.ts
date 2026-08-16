/** The canonical origin of the Production Site. A deployment overrides it with PUBLIC_BASE_URL. */
export const DEFAULT_PUBLIC_BASE_URL = "https://ugcangle.com";

/** The product brand, as it appears in document titles and structured data. */
export const BRAND_NAME = "UGC Angle";

/** A locale that the Production Site publishes documents in. */
export type SiteLocale = "en" | "zh";

/** The URL prefix a locale uses. English is unprefixed; other locales use a directory. */
export const LOCALE_PREFIX: Record<SiteLocale, string> = { en: "", zh: "/zh" };

/** One public page of the Production Site. */
export interface SitePage {
  /** Locale-free canonical path. Always starts with "/" and keeps any required trailing slash. */
  path: string;
  /** Locales this page exists in. A locale absent here gets no document and no alternate. */
  locales: readonly SiteLocale[];
  /** False keeps the row as a reservation: no document, no sitemap entry, no internal link. */
  enabled: boolean;
  /** False marks a page that is reachable but must not be indexed. */
  indexable: boolean;
  /** True builds a static document for every locale of this page. */
  prerendered: boolean;
}

/** Every public page of the Production Site, in navigation order. */
export const SITE_PAGES: readonly SitePage[] = [
  { path: "/",        locales: ["en", "zh"], enabled: true,  indexable: true, prerendered: true },
  { path: "/pricing", locales: ["en", "zh"], enabled: false, indexable: true, prerendered: true },
  { path: "/about",   locales: ["en", "zh"], enabled: false, indexable: true, prerendered: true },
  { path: "/privacy", locales: ["en", "zh"], enabled: false, indexable: true, prerendered: true },
  { path: "/terms",   locales: ["en", "zh"], enabled: false, indexable: true, prerendered: true },
  { path: "/hub/",    locales: ["en"],       enabled: false, indexable: true, prerendered: true },
];

const HREFLANG: Record<SiteLocale, string> = { en: "en", zh: "zh-Hans" };

/** x-default always resolves to English, by deliberate product decision (not page.locales order). */
export const DEFAULT_LOCALE: SiteLocale = "en";

/** Return the localized public path for one site page. */
export function localizedPath(path: string, locale: SiteLocale): string {
  const prefix = LOCALE_PREFIX[locale];
  if (path === "/") return prefix || "/";
  return `${prefix}${path}`;
}

/** Return the canonical URL for one localized site page. */
export function canonicalUrl(origin: string, path: string, locale: SiteLocale): string {
  return `${origin.replace(/\/$/, "")}${localizedPath(path, locale)}`;
}

/** Return every locale alternate and the English x-default alternate for one site page. */
export function alternatesOf(origin: string, page: SitePage) {
  return [
    ...page.locales.map((locale) => ({
      hreflang: HREFLANG[locale],
      url: canonicalUrl(origin, page.path, locale),
    })),
    { hreflang: "x-default", url: canonicalUrl(origin, page.path, DEFAULT_LOCALE) },
  ];
}

/** Return every enabled public page in navigation order. */
export function enabledPages(): readonly SitePage[] {
  return SITE_PAGES.filter(({ enabled }) => enabled);
}
