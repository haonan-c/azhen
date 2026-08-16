import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { canonicalUrl, enabledPages, localizedPath, SITE_PAGES } from '../site-config/src/index.ts'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unstable_readConfig, unstable_startWorker } from 'wrangler'
import { createDocument } from './prerender-marketing.mjs'

const packageRoot = fileURLToPath(new URL('.', import.meta.url))
const outputDirectories = {
  public: join(tmpdir(), `azhen-frontend-public-build-${process.pid}`),
  access: join(tmpdir(), `azhen-frontend-access-build-${process.pid}`),
}
const routerConfigPath = fileURLToPath(new URL('../router/wrangler.jsonc', import.meta.url))
const routerEntryPath = fileURLToPath(new URL('../router/src/index.ts', import.meta.url))
const integrationConfigPath = join(tmpdir(), `azhen-router-integration-${process.pid}.json`)
const integrationOrigin = 'http://localhost:8788'

const HREFLANG = { en: 'en', zh: 'zh-Hans' }
const prerenderedDocuments = enabledPages()
  .filter(page => page.prerendered)
  .flatMap(page => page.locales.map(locale => ({
    locale,
    page,
    publicPath: localizedPath(page.path, locale),
  })))
const reservedDocuments = SITE_PAGES
  .filter(page => !page.enabled && page.prerendered)
  .flatMap(page => page.locales.map(locale => ({
    locale,
    page,
    publicPath: localizedPath(page.path, locale),
  })))

function documentRelativePath(publicPath) {
  return publicPath === '/' ? 'index.html' : join(publicPath.slice(1), 'index.html')
}

async function listHtmlDocuments(directory, relativeDirectory = '') {
  const documents = []
  const entries = await readdir(join(directory, relativeDirectory), { withFileTypes: true })
  for (const entry of entries) {
    const relativePath = join(relativeDirectory, entry.name)
    if (entry.isDirectory()) {
      documents.push(...await listHtmlDocuments(directory, relativePath))
    } else if (entry.name.endsWith('.html')) {
      documents.push(relativePath)
    }
  }
  return documents.toSorted()
}

function structuredData(document) {
  return [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map(script => JSON.parse(script.textContent ?? 'null'))
}

function visibleFaq(document) {
  return [...document.querySelectorAll('#marketing-faq details')].map(details => ({
    question: details.querySelector('summary')?.textContent?.trim(),
    answer: details.querySelector('[data-faq-answer]')?.textContent?.trim(),
  }))
}

function faqStructuredData(document) {
  const value = structuredData(document).find(item => item['@type'] === 'FAQPage')
  return value?.mainEntity?.map(item => ({
    question: item.name,
    answer: item.acceptedAnswer?.text,
  }))
}

const expectedStaticSectionOrder = [
  'marketing-hero',
  'marketing-steps',
  'marketing-difference',
  'marketing-whatis',
  'marketing-compare',
  'marketing-access',
  'marketing-faq',
]

const localizedExpectations = [
  {
    locale: 'en',
    title: 'AI UGC Ad Angles in 60 Seconds | UGC Angle',
    description: 'See what AI UGC ads are actually made of before you make one. UGC Angle turns your product and your market into 3 testable ad angles — each with its tension, hypothesis, opening Hook, and reason to test. Free, no account.',
    openGraphTitle: 'AI UGC ads start with the angle, not the prompt',
    openGraphDescription: '3 testable ad angles for your product and market, in about 60 seconds. Free, no account.',
    heading: 'AI UGC ads start with the angle, not the prompt',
    sections: {
      'marketing-steps': 'From a product to a script you can shoot, in three steps',
      'marketing-difference': 'Most AI UGC tools start with a prompt. We start with an angle.',
      'marketing-whatis': 'What is AI UGC, and when is it worth using?',
      'marketing-compare': 'How UGC Angle compares',
      'marketing-access': 'Free while we are in early access',
      'marketing-faq': 'Frequently asked questions',
    },
    requiredBodyCopy: [
      'No brief. No prompt engineering. One line is enough.',
      'Every angle names the audience tension it targets, the hypothesis you are testing, the opening hook, and why it is worth spending on.',
      'Pick one. We write the script around that angle — the hook, the beats, and the lines said to camera — not around a generic prompt.',
      'A prompt gets you one video. An angle gets you a batch of variants you can compare.',
      'The bottleneck in high-volume creative testing was never production capacity. It is not knowing what to test next.',
      'UGC Angle answers that first — and hands you the script that tests it.',
      'AI UGC is ad creative that looks and sounds like a real customer talking to camera, produced with generative tools instead of filmed with a hired creator.',
      'It works when you need volume and speed: hook testing, angle testing, and markets where ten variants have to be live this week.',
      'It does not replace a customer who has genuinely used the product for a year.',
      'It also does not fix a weak argument. A generated video of a weak claim is a weak ad, delivered faster.',
      'A hired creator gives you authenticity you cannot fake, and a rate card, a brief round, a shipping window, and one deliverable per booking.',
      'That is the part most teams are missing. Production stopped being the constraint some time ago; deciding what to test next did not.',
      'Angles and scripts are free. Create an account to save them — and to be first in line when video production opens.',
      'No card. Nothing to cancel.',
    ],
    forbiddenLandingCopy: [
      'AI UGC 广告的起点是角度，不是提示词',
      '从产品到可开拍的脚本，三步',
      '什么是 AI UGC，什么时候值得用？',
    ],
  },
  {
    locale: 'zh',
    title: 'AI UGC 广告角度，约 60 秒返回 | UGC Angle',
    description: '在动手拍之前，先看清 AI UGC 广告到底由什么构成。输入产品与目标人群，约 60 秒拿到 3 个可测试的广告角度，每个都带人群张力、测试假设、开场 Hook 和为什么值得测。免费，无需注册。',
    openGraphTitle: 'AI UGC 广告的起点是角度，不是提示词',
    openGraphDescription: '约 60 秒拿到 3 个可测试的广告角度。免费，无需注册。',
    heading: 'AI UGC 广告的起点是角度，不是提示词',
    sections: {
      'marketing-steps': '从产品到可开拍的脚本，三步',
      'marketing-difference': '多数 AI UGC 工具从提示词开始，我们从角度开始。',
      'marketing-whatis': '什么是 AI UGC，什么时候值得用？',
      'marketing-compare': 'UGC Angle 与其他工具有什么不同',
      'marketing-access': '早期访问期间免费',
      'marketing-faq': '常见问题',
    },
    requiredBodyCopy: [
      '不用写 brief，不用调提示词，一句话就够。',
      '每个角度写清人群张力、测试假设、开场 Hook，以及为什么值得投预算。',
      '选一个，我们围绕这个角度写脚本：开场、节奏、镜头前要说的话。',
      '一个提示词只换来一条视频；一个角度换来一整批可以互相对照的变体。',
      '高频创意测试的瓶颈从来不是产能，是不知道下一个该测什么。',
      'UGC Angle 先回答这个问题，再把验证它的脚本交给你。',
      'AI UGC 是"看起来像真实顾客对着镜头说话"的广告素材，用生成工具做出来，而不是请达人拍出来。',
      '需要量与速度的时候有用：测 Hook、测角度、这周就要上线十条变体。',
      '它替代不了一个真的用了一年产品的顾客。',
      '它也修不好一个站不住的说法。把一个弱论点生成成视频，只是更快地得到一条弱广告。',
      '达人给你伪造不出的真实感，同时也给你报价单、改稿轮次、排期，以及一次合作一条成品。',
      '多数团队缺的正是这一块。产能早就不是瓶颈了，"下一个该测什么"才是。',
      '角度与脚本免费。注册可以保存它们 —— 视频生产开放时，也会先通知你。',
      '不需要绑卡，也没有什么要取消的。',
    ],
    forbiddenLandingCopy: [
      'AI UGC ads start with the angle, not the prompt',
      'From a product to a script you can shoot, in three steps',
      'What is AI UGC, and when is it worth using?',
      'Frequently asked questions',
    ],
  },
]

const forbiddenWorkshopCopy = [
  'What are we working on?',
  'Ask a question, create an output, or create an app that works with your tools and data.',
  '今天要处理什么？',
  '提出问题、创建成果，或创建能使用你的工具和数据的应用。',
  'Recent workspaces',
  '最近的工作区',
]

const forbiddenVideoPromises = [
  /free\s+UGC\s+video/i,
  /UGC\s+video\s+generator/i,
  /generate\s+UGC\s+videos?/i,
  /生成\s*UGC\s*视频/i,
  /免费(?:生成|制作)[^。；]{0,24}视频/i,
  /UGC\s*视频生成器/i,
]

describe('Marketing Landing Page prerender document assembly', () => {
  const localeKeys = {
    bareRootResolved: 'fixture.bare-root-resolved',
    preference: 'fixture.locale-preference',
  }
  const page = {
    body: '<p>Fixture body</p>',
    description: 'Fixture description',
    documentPath: '/',
    locale: 'en',
    openGraphDescription: 'Fixture Open Graph description',
    openGraphTitle: 'Fixture Open Graph title',
    structuredData: [],
    title: 'Fixture title',
  }
  const replacementCopy = "Literal $$ | $& | $` | $'"

  it('preserves dollar replacement patterns in every dynamic document replacement', async () => {
    // Exercise the production assembly helper without changing any copy shipped by the real build.
    const template = await readFile(join(packageRoot, 'index.html'), 'utf8')
    const localeDocument = createDocument(
      template,
      { ...page, locale: replacementCopy },
      false,
      localeKeys,
    )
    expect(localeDocument).toContain(`<html lang="${replacementCopy}">`)

    const metadataDocument = new JSDOM(createDocument(
      template,
      {
        ...page,
        description: replacementCopy,
        openGraphDescription: replacementCopy,
        openGraphTitle: replacementCopy,
        title: replacementCopy,
      },
      false,
      localeKeys,
    )).window.document
    expect(metadataDocument.title).toBe(replacementCopy)
    expect(metadataDocument.querySelector('meta[name="description"]')?.getAttribute('content'))
      .toBe(replacementCopy)
    expect(metadataDocument.querySelector('meta[property="og:title"]')?.getAttribute('content'))
      .toBe(replacementCopy)

    const rootDocument = new JSDOM(createDocument(
      template,
      { ...page, body: `<p data-replacement-copy="">${replacementCopy}</p>` },
      false,
      localeKeys,
    )).window.document
    expect(rootDocument.querySelector('[data-replacement-copy]')?.textContent).toBe(replacementCopy)
  })
})

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

        await Promise.all(prerenderedDocuments.map(async ({ publicPath }) => {
          documents[variant].set(
            publicPath,
            await readFile(
              join(outputDirectories[variant], documentRelativePath(publicPath)),
              'utf8',
            ),
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

  it.each(['public', 'access'])(
    'writes exactly the enabled prerendered site documents for the %s build',
    async (variant) => {
      const expectedDocuments = prerenderedDocuments
        .map(({ publicPath }) => documentRelativePath(publicPath))
        .toSorted()

      expect(await listHtmlDocuments(outputDirectories[variant])).toEqual(expectedDocuments)
      await Promise.all(reservedDocuments.map(({ publicPath }) => (
        expect(readFile(
          join(outputDirectories[variant], documentRelativePath(publicPath)),
          'utf8',
        )).rejects.toThrow()
      )))
    },
  )

  it.each(['public', 'access'].flatMap(variant => localizedExpectations.map(value => ({
    variant,
    ...value,
  }))))('emits localized $variant $locale metadata and the complete verified static page', ({
    variant,
    locale,
    title,
    description,
    openGraphTitle,
    openGraphDescription,
    heading,
    sections,
    requiredBodyCopy,
  }) => {
    const document = new JSDOM(documents[variant].get(localizedPath('/', locale))).window.document
    const root = document.querySelector('#root')

    expect(document.documentElement.lang).toBe(locale)
    expect(document.title).toBe(title)
    expect(document.querySelector('meta[name="description"]')?.getAttribute('content')).toBe(description)
    expect(document.querySelector('meta[property="og:type"]')?.getAttribute('content')).toBe('website')
    expect(document.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(openGraphTitle)
    expect(document.querySelector('meta[property="og:description"]')?.getAttribute('content')).toBe(openGraphDescription)
    expect(document.querySelector('meta[name="twitter:card"]')?.getAttribute('content')).toBe('summary')
    expect(document.querySelector('meta[name="twitter:title"]')?.getAttribute('content')).toBe(openGraphTitle)
    expect(document.querySelector('meta[name="twitter:description"]')?.getAttribute('content')).toBe(openGraphDescription)
    expect(document.querySelector('meta[property="og:image"]')).toBeNull()
    expect(document.querySelector('meta[name="twitter:image"]')).toBeNull()
    expect(root?.dataset.prerenderedLocale).toBe(locale)
    expect(root?.querySelector('h1')?.textContent).toBe(heading)
    expect(root?.querySelector('[data-marketing-tool]')).not.toBeNull()
    expect(root?.querySelector('#anonymous-angle-results')).toBeNull()

    for (const [sectionId, sectionHeading] of Object.entries(sections)) {
      const section = root?.querySelector(`#${sectionId}`)
      expect(section, `${sectionId} must exist in the initial HTML`).not.toBeNull()
      expect(section?.querySelector('h2')?.textContent).toBe(sectionHeading)
    }

    expect([...(root?.querySelectorAll('main > section') ?? [])].map(section => section.id))
      .toEqual(expectedStaticSectionOrder)
    const body = root?.textContent ?? ''
    for (const copy of requiredBodyCopy) expect(body).toContain(copy)

    // The repository intentionally ships no fabricated Angle Wall entry. The whole section stays absent.
    expect(root?.querySelector('#marketing-wall')).toBeNull()
    // The repository has no verified usage evidence. The whole section stays absent.
    expect(root?.querySelector('#marketing-proof')).toBeNull()
    expect(root?.querySelector('[data-marketing-compare-scroll]')).not.toBeNull()
    expect(root?.querySelectorAll('#marketing-faq details')).toHaveLength(8)
    expect(root?.querySelector('#marketing-faq details')?.hasAttribute('open')).toBe(true)
    expect(root?.querySelector('[data-video-production-row]')?.textContent)
      .toContain(locale === 'zh' ? '在路线图中' : 'On the roadmap')

    const sitePageHrefs = [...(root?.querySelectorAll('[data-site-page-link]') ?? [])]
      .map(link => link.getAttribute('href'))
    const expectedSitePageHrefs = enabledPages()
      .filter(page => page.locales.includes(locale))
      .map(page => localizedPath(page.path, locale))
    expect(sitePageHrefs).toEqual(expectedSitePageHrefs)
    expect(root?.querySelector('a[href*="pricing"]')).toBeNull()
    expect(root?.querySelector('a[href*="privacy"]')).toBeNull()
    expect(root?.querySelector('a[href*="terms"]')).toBeNull()
    expect(root?.querySelector('a[href*="hub"]')).toBeNull()
    expect(root?.querySelector(`a[href="${localizedPath('/signup', locale)}"]`)).not.toBeNull()
  })

  it.each(['public', 'access'].flatMap(variant => localizedExpectations.map(value => ({
    variant,
    ...value,
  }))))('keeps other-locale landing copy out of the $variant $locale document', ({
    variant,
    locale,
    forbiddenLandingCopy,
  }) => {
    const document = new JSDOM(documents[variant].get(localizedPath('/', locale))).window.document
    const body = document.querySelector('#root')?.textContent ?? ''

    for (const copy of forbiddenLandingCopy) expect(body).not.toContain(copy)
  })

  it.each(['public', 'access'].flatMap(variant => localizedExpectations.map(({ locale }) => ({
    variant,
    locale,
  }))))('keeps Workshop Home and user data out of the $variant $locale document', ({
    variant,
    locale,
  }) => {
    const html = documents[variant].get(localizedPath('/', locale)) ?? ''
    for (const copy of forbiddenWorkshopCopy) expect(html).not.toContain(copy)
    expect(html).not.toMatch(/data-workspace-id|data-user-id|authToken&quot;\s*:/i)
  })

  it.each(['public', 'access'].flatMap(variant => localizedExpectations.map(({ locale }) => ({
    variant,
    locale,
  }))))('renders visible FAQ and FAQPage JSON-LD from the same localized source for $variant $locale', ({
    variant,
    locale,
  }) => {
    const document = new JSDOM(documents[variant].get(localizedPath('/', locale))).window.document
    const values = structuredData(document)

    expect(values.map(value => value['@type'])).toEqual(['Organization', 'WebSite', 'FAQPage'])
    expect(values.some(value => value['@type'] === 'SoftwareApplication')).toBe(false)
    expect(faqStructuredData(document)).toEqual(visibleFaq(document))
  })

  it.each(['public', 'access'].flatMap(variant => localizedExpectations.map(({ locale }) => ({
    variant,
    locale,
  }))))('does not promise free UGC video generation in the $variant $locale document', ({
    variant,
    locale,
  }) => {
    const body = new JSDOM(documents[variant].get(localizedPath('/', locale)))
      .window.document.querySelector('#root')?.textContent ?? ''

    // UGC Angle currently returns Ad Angles and scripts. This guard must not erase the honest roadmap row.
    for (const pattern of forbiddenVideoPromises) expect(body).not.toMatch(pattern)
  })

  it.each(['public', 'access'])(
    'boots the same SPA entry from one prerendered interactive root per %s document',
    (variant) => {
      const parsedDocuments = ['en', 'zh'].map(locale => (
        new JSDOM(documents[variant].get(localizedPath('/', locale))).window.document
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
    const document = new JSDOM(documents[variant].get(localizedPath('/', locale)), {
      runScripts: 'dangerously',
      url: `https://production.example${path}`,
    }).window.document

    expect(document.querySelector('#root')?.hidden).toBe(hidden)
  })

  it.each(prerenderedDocuments.filter(({ page }) => page.indexable))(
    'passes the real $publicPath document through the Production Site Router with all URL relations',
    async ({ locale, page, publicPath }) => {
      const response = await routerWorker.fetch(`${integrationOrigin}${publicPath}`, {
        redirect: 'manual',
      })
      const html = await response.text()

      expect(response.status).toBe(200)
      expect(response.headers.get('location')).toBeNull()
      expect(response.headers.get('x-robots-tag')).toBeNull()
      expect(html).toContain(`data-prerendered-locale="${locale}"`)
      expect(html).toContain(
        `<link rel="canonical" href="${canonicalUrl(integrationOrigin, page.path, locale)}">`,
      )
      for (const alternateLocale of page.locales) {
        expect(html).toContain(
          `<link rel="alternate" hreflang="${HREFLANG[alternateLocale]}" href="${canonicalUrl(
            integrationOrigin,
            page.path,
            alternateLocale,
          )}">`,
        )
      }
      expect(html).toContain(
        `<link rel="alternate" hreflang="x-default" href="${canonicalUrl(
          integrationOrigin,
          page.path,
          'en',
        )}">`,
      )
    },
  )

  it('serves crawler documents from the enabled and indexable site page registry', async () => {
    const [robotsResponse, sitemapResponse] = await Promise.all([
      routerWorker.fetch(`${integrationOrigin}/robots.txt`),
      routerWorker.fetch(`${integrationOrigin}/sitemap.xml`),
    ])
    const robots = await robotsResponse.text()
    const sitemap = await sitemapResponse.text()
    const expectedUrls = enabledPages()
      .filter(page => page.indexable)
      .flatMap(page => page.locales.map(
        locale => canonicalUrl(integrationOrigin, page.path, locale),
      ))

    expect(robotsResponse.headers.get('content-type')).toBe('text/plain; charset=UTF-8')
    expect(robots).toBe(
      `User-agent: *\nAllow: /\nSitemap: ${integrationOrigin}/sitemap.xml\n`,
    )
    expect(robots).not.toContain('Disallow:')
    expect(sitemapResponse.headers.get('content-type')).toBe('application/xml; charset=UTF-8')
    expect([...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]))
      .toEqual(expectedUrls)
  })

  it.each([
    '/login',
    '/signup',
    '/workspaces',
    '/admin',
    '/blueprints/example',
    ...reservedDocuments.map(({ publicPath }) => publicPath),
  ])('marks application or reserved document %s as noindex', async (publicPath) => {
    const response = await routerWorker.fetch(`${integrationOrigin}${publicPath}`, {
      redirect: 'manual',
    })

    expect(response.headers.get('x-robots-tag')).toBe('noindex')
  })
})
