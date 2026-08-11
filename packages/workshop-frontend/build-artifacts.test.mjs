import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unstable_readConfig, unstable_startWorker } from 'wrangler'

const packageRoot = fileURLToPath(new URL('.', import.meta.url))
const outputDirectories = {
  public: join(tmpdir(), `azhen-frontend-public-build-${process.pid}`),
  access: join(tmpdir(), `azhen-frontend-access-build-${process.pid}`),
}
const routerConfigPath = fileURLToPath(new URL('../router/wrangler.jsonc', import.meta.url))
const routerEntryPath = fileURLToPath(new URL('../router/src/index.ts', import.meta.url))
const integrationConfigPath = join(tmpdir(), `azhen-router-integration-${process.pid}.json`)
const integrationOrigin = 'http://localhost:8788'

describe('production Marketing Landing Page documents', () => {
  /** @type {Record<'public' | 'access', Map<string, string>>} */
  const documents = {
    public: new Map(),
    access: new Map(),
  }
  /** @type {Awaited<ReturnType<typeof unstable_startWorker>> | undefined} */
  let routerWorker

  beforeAll(async () => {
    const previousAccessMode = process.env.VITE_CF_ACCESS_MODE
    try {
      for (const [variant, accessMode] of [['public', 'false'], ['access', 'true']]) {
        process.env.VITE_CF_ACCESS_MODE = accessMode
        await build({
          root: packageRoot,
          logLevel: 'silent',
          build: {
            emptyOutDir: true,
            outDir: outputDirectories[variant],
          },
        })

        await Promise.all([
          ['en', 'index.html'],
          ['zh', join('zh', 'index.html')],
        ].map(async ([locale, path]) => {
          documents[variant].set(
            locale,
            await readFile(join(outputDirectories[variant], path), 'utf8'),
          )
        }))
      }
    } finally {
      if (previousAccessMode === undefined) delete process.env.VITE_CF_ACCESS_MODE
      else process.env.VITE_CF_ACCESS_MODE = previousAccessMode
    }

    const routerConfig = unstable_readConfig(
      { config: routerConfigPath },
      { hideWarnings: true },
    )
    await writeFile(integrationConfigPath, JSON.stringify({
      assets: {
        ...routerConfig.assets,
        directory: outputDirectories.public,
      },
      compatibility_date: routerConfig.compatibility_date,
      main: routerEntryPath,
      name: 'router-seo-integration',
      vars: { PUBLIC_BASE_URL: integrationOrigin },
    }))
    routerWorker = await unstable_startWorker({ config: integrationConfigPath })
  }, 180_000)

  afterAll(async () => {
    await routerWorker?.dispose()
    await Promise.all([
      ...Object.values(outputDirectories)
        .map(path => rm(path, { force: true, recursive: true })),
      rm(integrationConfigPath, { force: true }),
    ])
  })

  it.each(['public', 'access'].flatMap(variant => ([
    {
      variant,
      locale: 'en',
      title: 'E-commerce Operations AI Workspace - azhen',
      description: 'Research content, create campaign materials, and build tools with an AI partner in your secure workspace.',
      heading: 'From brief to usable result.',
      workflow: 'Move from question to working output',
    },
    {
      variant,
      locale: 'zh',
      title: '电商运营 AI 工作台 - 阿珍',
      description: '调研内容、制作运营物料、搭建专用应用，与 AI 电商运营伙伴一起，在安全的工作台内完成。',
      heading: '从任务到可用成果。',
      workflow: '让问题一步步变成可用成果',
    },
  ])))('emits localized $variant $locale content and metadata without JavaScript', ({
    variant,
    locale,
    title,
    description,
    heading,
    workflow,
  }) => {
    const document = new JSDOM(documents[variant].get(locale)).window.document
    const root = document.querySelector('#root')

    expect(document.documentElement.lang).toBe(locale)
    expect(document.title).toBe(title)
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(description)
    expect(document.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(title)
    expect(document.querySelector('meta[property="og:description"]')?.getAttribute('content')).toBe(description)
    expect(document.querySelector('meta[name="twitter:title"]')?.getAttribute('content')).toBe(title)
    expect(document.querySelector('meta[name="twitter:description"]')?.getAttribute('content')).toBe(description)
    expect(root?.dataset.prerenderedLocale).toBe(locale)
    expect(root?.querySelector('h1')?.textContent).toBe(heading)
    expect(root?.querySelector('#workflow')?.textContent).toContain(workflow)
  })

  it.each(['public', 'access'])('keeps English landing copy out of the %s Chinese document', (variant) => {
    const document = new JSDOM(documents[variant].get('zh')).window.document
    const body = document.querySelector('#root')?.textContent

    expect(body).not.toContain('E-commerce Operations AI Workspace')
    expect(body).not.toContain('From brief to usable result.')
    expect(body).not.toContain('Move from question to working output')
  })

  it.each(['public', 'access'])(
    'boots the same SPA entry from one prerendered interactive root per %s document',
    (variant) => {
      const parsedDocuments = ['en', 'zh'].map(locale => (
        new JSDOM(documents[variant].get(locale)).window.document
      ))
      const entrySources = parsedDocuments.map(document => (
        document.querySelector('script[type="module"]')?.getAttribute('src')
      ))

      expect(parsedDocuments.map(document => document.querySelectorAll('#root').length)).toEqual([1, 1])
      expect(entrySources[0]).toMatch(/^\/assets\/[^/]+\.js$/)
      expect(entrySources[1]).toBe(entrySources[0])
    },
  )

  it.each([
    ['public', '/', 'en', false],
    ['public', '/zh', 'zh', false],
    ['access', '/', 'en', true],
    ['access', '/zh', 'zh', true],
  ])('%s variant sets initial landing visibility for %s', (variant, path, locale, hidden) => {
    const document = new JSDOM(documents[variant].get(locale), {
      runScripts: 'dangerously',
      url: `https://production.example${path}`,
    }).window.document

    expect(document.querySelector('#root')?.hidden).toBe(hidden)
  })

  it.each([
    ['/', 'en'],
    ['/zh', 'zh'],
  ])('passes the real %s Marketing Landing Page through the Production Site Router', async (
    path,
    locale,
  ) => {
    const response = await routerWorker.fetch(`${integrationOrigin}${path}`, {
      redirect: 'manual',
    })
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('x-robots-tag')).toBeNull()
    expect(html).toContain(`data-prerendered-locale="${locale}"`)
    expect(html).toContain(`<link rel="canonical" href="${integrationOrigin}${path}">`)
  })
})
