import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unstable_readConfig, unstable_startWorker } from 'wrangler'

const packageRoot = fileURLToPath(new URL('.', import.meta.url))
const outputDirectory = join(tmpdir(), `azhen-frontend-build-${process.pid}`)
const routerConfigPath = fileURLToPath(new URL('../router/wrangler.jsonc', import.meta.url))
const routerEntryPath = fileURLToPath(new URL('../router/src/index.ts', import.meta.url))
const integrationConfigPath = join(tmpdir(), `azhen-router-integration-${process.pid}.json`)
const integrationOrigin = 'http://localhost:8788'

describe('production Marketing Landing Page documents', () => {
  /** @type {Map<string, string>} */
  const documents = new Map()
  /** @type {Awaited<ReturnType<typeof unstable_startWorker>> | undefined} */
  let routerWorker

  beforeAll(async () => {
    await build({
      root: packageRoot,
      logLevel: 'silent',
      build: {
        emptyOutDir: true,
        outDir: outputDirectory,
      },
    })

    await Promise.all([
      ['en', 'index.html'],
      ['zh', join('zh', 'index.html')],
    ].map(async ([locale, path]) => {
      documents.set(locale, await readFile(join(outputDirectory, path), 'utf8'))
    }))

    const routerConfig = unstable_readConfig(
      { config: routerConfigPath },
      { hideWarnings: true },
    )
    await writeFile(integrationConfigPath, JSON.stringify({
      assets: {
        ...routerConfig.assets,
        directory: outputDirectory,
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
      rm(outputDirectory, { force: true, recursive: true }),
      rm(integrationConfigPath, { force: true }),
    ])
  })

  it.each([
    {
      locale: 'en',
      title: 'E-commerce Operations AI Workspace - azhen',
      description: 'Research content, create campaign materials, and build tools with an AI partner in your secure workspace.',
      heading: 'From brief to usable result.',
      workflow: 'Move from question to working output',
    },
    {
      locale: 'zh',
      title: '电商运营 AI 工作台 - 阿珍',
      description: '调研内容、制作运营物料、搭建专用应用，与 AI 电商运营伙伴一起，在安全的工作台内完成。',
      heading: '从任务到可用成果。',
      workflow: '让问题一步步变成可用成果',
    },
  ])('emits localized $locale content and metadata without JavaScript', ({
    locale,
    title,
    description,
    heading,
    workflow,
  }) => {
    const document = new JSDOM(documents.get(locale)).window.document
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

  it('keeps English landing copy out of the Chinese document', () => {
    const document = new JSDOM(documents.get('zh')).window.document
    const body = document.querySelector('#root')?.textContent

    expect(body).not.toContain('E-commerce Operations AI Workspace')
    expect(body).not.toContain('From brief to usable result.')
    expect(body).not.toContain('Move from question to working output')
  })

  it('boots the same SPA entry from one prerendered interactive root per document', () => {
    const parsedDocuments = ['en', 'zh'].map(locale => (
      new JSDOM(documents.get(locale)).window.document
    ))
    const entrySources = parsedDocuments.map(document => (
      document.querySelector('script[type="module"]')?.getAttribute('src')
    ))

    expect(parsedDocuments.map(document => document.querySelectorAll('#root').length)).toEqual([1, 1])
    expect(entrySources[0]).toMatch(/^\/assets\/[^/]+\.js$/)
    expect(entrySources[1]).toBe(entrySources[0])
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
