// The public origin of a gadgets instance. Routes by path prefix to the workshop backend and
// whichever gatekeepers are bound, and serves the workshop frontend for everything else.
//
// Routing config IS the binding set: gatekeepers are discovered by scanning `GATEKEEPER_*` env
// keys, so installing a gatekeeper only requires re-deploying this worker with one more service
// binding — no code or config changes here.
//
// The same worker doubles as the dev router (`pnpm dev-server` at the repo root): dev has no
// `ASSETS` binding, so frontend requests fall through to the backend instead.

// gatekeeper-email's entrypoint: a WorkerEntrypoint whose optional email() handler is present.
type EmailEntrypoint = CloudflareWorkersModule.WorkerEntrypoint &
    Required<Pick<CloudflareWorkersModule.WorkerEntrypoint, "email">>;

/** Bindings used by the public origin router. */
export interface Env {
  /** Present in release deployments; may be absent in local development. */
  PUBLIC_BASE_URL?: string;
  /** The Workshop backend service binding. */
  WORKSHOP_BACKEND: Fetcher;
  /** Present in production (wrangler.jsonc assets stanza); absent in dev. */
  ASSETS?: Fetcher;
  /** Dormant until custom domains + Email Routing exist; the handler ships anyway. */
  GATEKEEPER_EMAIL?: Service<EmailEntrypoint>;
  [key: string]: unknown;
}

const MARKETING_LANDING_PAGES = [
  { path: "/", hreflang: "en", isDefault: true },
  { path: "/zh", hreflang: "zh-Hans", isDefault: false },
] as const;

function absoluteMarketingLandingPages(publicOrigin: string) {
  return MARKETING_LANDING_PAGES.map((page) => ({
    ...page,
    url: `${publicOrigin}${page.path}`,
  }));
}

function normalizePublicOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") ||
        url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function crawlerDocument(pathname: string, publicBaseUrl: string | undefined): Response | null {
  if (pathname !== "/robots.txt" && pathname !== "/sitemap.xml") return null;

  const publicOrigin = normalizePublicOrigin(publicBaseUrl);
  if (pathname === "/robots.txt") {
    const sitemap = publicOrigin ? `\nSitemap: ${publicOrigin}/sitemap.xml` : "";
    return new Response(`User-agent: *\nAllow: /${sitemap}\n`, {
      headers: { "content-type": "text/plain; charset=UTF-8" },
    });
  }

  if (!publicOrigin) {
    return new Response("Public Base URL is not configured.", {
      headers: { "content-type": "text/plain; charset=UTF-8" },
      status: 503,
    });
  }

  const marketingLandingPages = absoluteMarketingLandingPages(publicOrigin);
  return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
      marketingLandingPages.map(({ url }) => `<url><loc>${url}</loc></url>`).join("") +
      `</urlset>\n`,
      { headers: { "content-type": "application/xml; charset=UTF-8" } },
  );
}

function applyPageSeo(
    response: Response, requestUrl: URL, publicBaseUrl: string | undefined): Response {
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/html")) {
    return response;
  }

  const publicOrigin = normalizePublicOrigin(publicBaseUrl);
  const marketingLandingPage = MARKETING_LANDING_PAGES.find(
      ({ path }) => path === requestUrl.pathname);
  const headers = new Headers(response.headers);
  if (publicOrigin && requestUrl.origin === publicOrigin && marketingLandingPage) {
    headers.delete("x-robots-tag");
  } else {
    headers.set("x-robots-tag", "noindex");
  }
  const pageResponse = new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });

  if (!publicOrigin || !marketingLandingPage) return pageResponse;

  const marketingLandingPages = absoluteMarketingLandingPages(publicOrigin);
  const defaultPage = marketingLandingPages.find(({ isDefault }) => isDefault)!;
  const links = [
    `<link rel="canonical" href="${publicOrigin}${marketingLandingPage.path}">`,
    ...marketingLandingPages.map(({ hreflang, url }) => (
      `<link rel="alternate" hreflang="${hreflang}" href="${url}">`
    )),
    `<link rel="alternate" hreflang="x-default" href="${defaultPage.url}">`,
  ].join("");

  return new HTMLRewriter()
      .on("head", { element: (element) => { element.append(links, { html: true }); } })
      .transform(pageResponse);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const crawlerResponse = crawlerDocument(url.pathname, env.PUBLIC_BASE_URL);
    if (crawlerResponse) return crawlerResponse;

    for (const key of Object.keys(env)) {
      if (!key.startsWith("GATEKEEPER_")) continue;
      const suffix = key.slice("GATEKEEPER_".length).toLowerCase().replaceAll("_", "-");
      const prefix = `/gatekeeper/${suffix}`;
      if (url.pathname === prefix || url.pathname.startsWith(prefix + "/")) {
        return (env[key] as Fetcher).fetch(req);
      }
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/") ||
        url.pathname === "/blueprint-screenshot" ||
        url.pathname.startsWith("/blueprint-screenshot/")) {
      return env.WORKSHOP_BACKEND.fetch(req);
    }

    // Note: gatekeeper OAuth redirects land on the gatekeeper Workers themselves, at
    // `/gatekeeper/<name>/oauth` (handled by the loop above) — there are no backend /auth
    // callbacks.

    if (env.ASSETS) {
      const response = await env.ASSETS.fetch(req);
      return applyPageSeo(response, url, env.PUBLIC_BASE_URL);
    }

    // Dev only: with no assets binding here, everything else goes to the backend.
    //
    // In `run-local` mode the backend has a static `assets` binding configured (with
    // `run_worker_first` for the API routes), so it serves the pre-built single-page app for these
    // frontend requests. In normal dev mode the backend has no assets and frontend requests aren't
    // expected here -- run the Vite dev server with `pnpm dev-client` and open localhost:3000
    // directly instead. (We don't try to forward to localhost:3000 becaues it doesn't work well:
    // Vite's HMR socket gets disconnected every time wrangler restarts workerd.)
    const response = await env.WORKSHOP_BACKEND.fetch(req);
    return applyPageSeo(response, url, env.PUBLIC_BASE_URL);
  },

  async email(message, env) {
    if (!env.GATEKEEPER_EMAIL) {
      message.setReject("No email gatekeeper is installed on this instance.");
      return;
    }
    await env.GATEKEEPER_EMAIL.email(message);
  },
} satisfies ExportedHandler<Env>;
