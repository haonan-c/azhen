# Prerender bilingual marketing pages without replacing the Workshop SPA

Status: accepted

The Workshop frontend is a client-only SPA built around a persistent WebSocket RPC session. The
Production Site also needs an English and Chinese Marketing Landing Page whose useful content and
search metadata are present before JavaScript runs. The reference project achieves that with
TanStack Start server rendering, but adopting its application framework would turn a marketing and
localization change into a frontend architecture migration.

We will keep the existing SPA and its single locale-free route tree. Paraglide will own localized
URLs: English remains unprefixed and Chinese uses `/zh`. A focused build step will prerender only
the two localized Marketing Landing Page documents from the same React component and message
catalogs used by the browser. The Workshop, auth, admin, and Blueprint surfaces remain client-side.

The Router will receive the Production Site's Public Base URL. It will use that origin for
canonical links, localized alternates, robots, and the sitemap, and will mark other origins and
non-indexable surfaces as `noindex`. The first release admits only the two localized Marketing
Landing Page URLs to the sitemap. Robots rules will let crawlers retrieve documents that carry
`noindex`; they will not use crawl blocking as a substitute. SEO response handling will apply only
to document HTML, robots, and sitemap responses, without changing API, persistent connection,
Gatekeeper, asset, or other non-document traffic.

This keeps the runtime and RPC architecture unchanged, avoids duplicate landing-page markup, and
gives crawlers useful localized HTML. It also means admin branding changes affect the live client
immediately but require a new build to change prerendered search metadata. The build and Router now
share responsibility for the public SEO response, so their contract needs an integration test.

We rejected three alternatives:

- Migrating the frontend to TanStack Start, because the required result does not justify replacing
  the Workshop's application runtime.
- Keeping the Marketing Landing Page client-rendered only, because it weakens the agreed SEO
  foundation.
- Maintaining separate handwritten English and Chinese HTML, because it would create a second UI
  and translation source that could drift from the application.
