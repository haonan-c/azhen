import { describe, expect, it } from 'vitest';
import { parse } from 'jsonc-parser';
import router, { type Env } from '../src/index';
// Imported as text so the config-integrity tests run inside workerd without filesystem access.
import wranglerConfigText from '../wrangler.jsonc?raw';

function stubFetcher(label: string): Fetcher {
  return {
    fetch: async () => new Response(label),
  } as unknown as Fetcher;
}

function stubHtmlFetcher(): Fetcher {
  return {
    fetch: async () => new Response(
      '<!doctype html><html><head><title>Page</title></head><body>Page</body></html>',
      { headers: { 'content-type': 'text/html; charset=UTF-8' } },
    ),
  } as unknown as Fetcher;
}

function makeEnv(extra: Record<string, unknown> = {}): Env {
  return {
    PUBLIC_BASE_URL: 'https://production.example',
    WORKSHOP_BACKEND: stubFetcher('backend'),
    ...extra,
  } as Env;
}

async function fetchRoute(env: Env, url: string): Promise<Response> {
  return router.fetch!(new Request(url), env, {} as ExecutionContext);
}

async function route(env: Env, path: string): Promise<string> {
  const req = new Request(`https://example.com${path}`);
  const res = await router.fetch!(req, env, {} as ExecutionContext);
  return res.text();
}

describe('router fetch', () => {
  it.each([
    ['/', 'https://production.example/'],
    ['/zh', 'https://production.example/zh'],
  ])('adds absolute SEO links to canonical %s documents', async (path, canonicalUrl) => {
    const env = makeEnv({
      ASSETS: stubHtmlFetcher(),
      PUBLIC_BASE_URL: 'https://production.example/',
    });

    const response = await fetchRoute(env, `https://production.example${path}`);
    const html = await response.text();

    expect(response.headers.get('x-robots-tag')).toBeNull();
    expect(html).toContain(`<link rel="canonical" href="${canonicalUrl}">`);
    expect(html).toContain('<link rel="alternate" hreflang="en" href="https://production.example/">');
    expect(html).toContain('<link rel="alternate" hreflang="zh-Hans" href="https://production.example/zh">');
    expect(html).toContain('<link rel="alternate" hreflang="x-default" href="https://production.example/">');
  });

  it.each([
    ['https://preview.example/', 'https://production.example'],
    ['https://localhost.test/zh', 'https://production.example/'],
    ['https://production.example/signin', 'https://production.example'],
    ['https://production.example/workspaces', 'https://production.example'],
    ['https://production.example/admin', 'https://production.example'],
    ['https://production.example/blueprints/123', 'https://production.example'],
    ['https://production.example/', 'not a URL'],
    ['https://production.example/', undefined],
  ])('marks non-indexable document %s as noindex', async (requestUrl, publicBaseUrl) => {
    const env = makeEnv({
      ASSETS: stubHtmlFetcher(),
      PUBLIC_BASE_URL: publicBaseUrl,
    });

    const response = await fetchRoute(env, requestUrl);

    expect(response.headers.get('x-robots-tag')).toBe('noindex');
  });

  it('points an alternate-origin Marketing Landing Page at the Production Site', async () => {
    const env = makeEnv({
      ASSETS: stubHtmlFetcher(),
      PUBLIC_BASE_URL: 'https://production.example/',
    });

    const response = await fetchRoute(env, 'https://preview.example/zh');
    const html = await response.text();

    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(html).toContain('<link rel="canonical" href="https://production.example/zh">');
  });

  it('allows crawlers to retrieve noindex documents through robots.txt', async () => {
    const response = await fetchRoute(makeEnv({
      ASSETS: stubHtmlFetcher(),
      PUBLIC_BASE_URL: 'https://production.example/',
    }), 'https://preview.example/robots.txt');
    const body = await response.text();

    expect(response.headers.get('content-type')).toBe('text/plain; charset=UTF-8');
    expect(body).toContain('User-agent: *\nAllow: /');
    expect(body).toContain('Sitemap: https://production.example/sitemap.xml');
    expect(body).not.toContain('Disallow:');
  });

  it('lists only the two canonical localized Marketing Landing Pages in sitemap.xml', async () => {
    const response = await fetchRoute(makeEnv({
      ASSETS: stubHtmlFetcher(),
      PUBLIC_BASE_URL: 'https://production.example/',
    }), 'https://preview.example/sitemap.xml');
    const body = await response.text();

    expect(response.headers.get('content-type')).toBe('application/xml; charset=UTF-8');
    expect([...body.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1])).toEqual([
      'https://production.example/',
      'https://production.example/zh',
    ]);
  });

  it('routes /api and /blueprint-screenshot prefixes to the backend', async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets') });
    expect(await route(env, '/api')).toBe('backend');
    expect(await route(env, '/api/workshop')).toBe('backend');
    expect(await route(env, '/blueprint-screenshot')).toBe('backend');
    expect(await route(env, '/blueprint-screenshot/abc')).toBe('backend');
  });

  it.each([
    ['/api/workshop', 'application/json', 'backend'],
    ['/api/websocket', 'application/octet-stream', 'backend'],
    ['/blueprint-screenshot/abc', 'image/png', 'backend'],
    ['/gatekeeper/google/oauth', 'text/html; charset=UTF-8', 'gatekeeper'],
    ['/assets/app.js', 'application/javascript', 'asset'],
    ['/favicon.svg', 'image/svg+xml', 'asset'],
  ])('does not add page SEO headers to %s traffic', async (path, contentType, expectedBody) => {
    const responseFetcher = {
      fetch: async () => new Response(expectedBody, {
        headers: { 'content-type': contentType, 'x-upstream': 'unchanged' },
      }),
    } as unknown as Fetcher;
    const env = makeEnv({
      ASSETS: responseFetcher,
      GATEKEEPER_GOOGLE: responseFetcher,
      WORKSHOP_BACKEND: responseFetcher,
    });
    const request = new Request(`https://production.example${path}`, {
      headers: path === '/api/websocket' ? { upgrade: 'websocket' } : undefined,
    });

    const response = await router.fetch!(request, env, {} as ExecutionContext);

    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(expectedBody);
    expect(response.headers.get('x-upstream')).toBe('unchanged');
    expect(response.headers.get('x-robots-tag')).toBeNull();
  });

  it('does not treat /api-lookalike paths as backend routes', async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets') });
    expect(await route(env, '/apiary')).toBe('assets');
    expect(await route(env, '/blueprint-screenshots')).toBe('assets');
  });

  it('routes /gatekeeper/<short> by scanning GATEKEEPER_* bindings', async () => {
    const env = makeEnv({
      ASSETS: stubFetcher('assets'),
      GATEKEEPER_GOOGLE: stubFetcher('google'),
      GATEKEEPER_HOMEASSISTANT: stubFetcher('homeassistant'),
    });
    expect(await route(env, '/gatekeeper/google')).toBe('google');
    expect(await route(env, '/gatekeeper/google/oauth')).toBe('google');
    expect(await route(env, '/gatekeeper/homeassistant/foo')).toBe('homeassistant');
  });

  it('maps underscores in binding names to dashes in the path', async () => {
    const env = makeEnv({
      ASSETS: stubFetcher('assets'),
      GATEKEEPER_MY_SERVICE: stubFetcher('my-service'),
    });
    expect(await route(env, '/gatekeeper/my-service')).toBe('my-service');
    expect(await route(env, '/gatekeeper/my-service/oauth')).toBe('my-service');
  });

  it('does not match gatekeeper prefixes on longer path segments', async () => {
    const env = makeEnv({
      ASSETS: stubFetcher('assets'),
      GATEKEEPER_GOOGLE: stubFetcher('google'),
    });
    expect(await route(env, '/gatekeeper/googles')).toBe('assets');
  });

  it('serves everything else from ASSETS when the binding is present', async () => {
    const env = makeEnv({ ASSETS: stubFetcher('assets') });
    expect(await route(env, '/')).toBe('assets');
    expect(await route(env, '/blueprints/123')).toBe('assets');
    expect(await route(env, '/gatekeeper/not-installed')).toBe('assets');
  });

  // Dev has no ASSETS binding: the backend serves the frontend from its own assets binding in
  // `run-local` mode, and in normal dev mode you open the Vite server on :3000 directly.
  it('falls through to the backend when ASSETS is absent', async () => {
    const env = makeEnv();
    expect(await route(env, '/')).toBe('backend');
    expect(await route(env, '/blueprints/123')).toBe('backend');
  });
});

describe('router email', () => {
  it('forwards to GATEKEEPER_EMAIL when bound', async () => {
    const received: unknown[] = [];
    const env = makeEnv({
      GATEKEEPER_EMAIL: { email: async (m: unknown) => { received.push(m); } },
    });
    const message = {} as ForwardableEmailMessage;
    await router.email!(message, env, {} as ExecutionContext);
    expect(received).toEqual([message]);
  });

  it('rejects mail when no email gatekeeper is installed', async () => {
    const rejections: string[] = [];
    const env = makeEnv();
    const message = {
      setReject: (reason: string) => { rejections.push(reason); },
    } as unknown as ForwardableEmailMessage;
    await router.email!(message, env, {} as ExecutionContext);
    expect(rejections).toHaveLength(1);
  });
});

// The deploy service renders customer instances from this config (via the release manifest), so
// the asset-routing contract must hold: worker-first prefixes cover every dynamic route, or asset
// 404 handling would swallow API and gatekeeper traffic.
describe('wrangler.jsonc contract', () => {
  const config = parse(wranglerConfigText);

  it('runs the worker first for documents while static assets keep their direct path', () => {
    const first: string[] = config.assets.run_worker_first;
    expect(first).toEqual([
      '/*',
      '!/assets/*',
      '!/favicon.svg',
      '!/marketing/*',
    ]);
  });

  it('serves the frontend as a single-page application', () => {
    expect(config.assets.html_handling).toBe('drop-trailing-slash');
    expect(config.assets.not_found_handling).toBe('single-page-application');
    expect(config.assets.directory).toBe('../workshop-frontend/dist');
    expect(config.assets.binding).toBe('ASSETS');
  });

  it('binds the workshop backend', () => {
    expect(config.services).toContainEqual({
      binding: 'WORKSHOP_BACKEND',
      service: 'workshop-backend',
    });
  });
});
