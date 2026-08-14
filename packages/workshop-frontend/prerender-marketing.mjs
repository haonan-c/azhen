import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { localizedPath, SITE_PAGES } from '../site-config/src/index.ts'

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function serializeStructuredData(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

function startupVisibilityScript(page, accessMode, localeKeys) {
  return `<script>(() => {
    const expectedPath = ${JSON.stringify(page.documentPath)};
    let hide = ${JSON.stringify(accessMode)} || window.location.pathname !== expectedPath;
    try {
      hide ||= Boolean(window.localStorage.getItem('authToken'));
      if (!hide && expectedPath === '/') {
        const savedLocale = window.localStorage.getItem(${JSON.stringify(localeKeys.preference)});
        if (savedLocale === 'zh') {
          hide = true;
        } else if (savedLocale !== 'en' && window.localStorage.getItem(${JSON.stringify(localeKeys.bareRootResolved)}) !== '1') {
          const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
          for (const language of languages) {
            const baseLanguage = language.toLowerCase().split('-')[0];
            if (baseLanguage === 'zh') {
              hide = true;
              break;
            }
            if (baseLanguage === 'en') break;
          }
        }
      }
    } catch {
      hide = true;
    }
    if (hide) document.getElementById('root').hidden = true;
  })();</script>`
}

function outputFilePath(outputDirectory, publicPath) {
  const relativeDirectory = publicPath === '/' ? '' : publicPath.slice(1)
  return join(outputDirectory, relativeDirectory, 'index.html')
}

export function createDocument(template, page, accessMode, localeKeys) {
  const title = escapeHtml(page.title)
  const description = escapeHtml(page.description)
  const openGraphTitle = escapeHtml(page.openGraphTitle)
  const openGraphDescription = escapeHtml(page.openGraphDescription)
  const structuredData = page.structuredData
    .map(value => `<script type="application/ld+json">${serializeStructuredData(value)}</script>`)
    .join('\n    ')
  const metadata = `<title>${title}</title>
    <meta name="description" content="${description}" />
    <meta property="og:type" content="website" />
    <meta property="og:locale" content="${page.locale === 'zh' ? 'zh_CN' : 'en_US'}" />
    <meta property="og:title" content="${openGraphTitle}" />
    <meta property="og:description" content="${openGraphDescription}" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${openGraphTitle}" />
    <meta name="twitter:description" content="${openGraphDescription}" />
    ${structuredData}`
  const root = `<div id="root" data-prerendered-locale="${page.locale}">${page.body}</div>
    ${startupVisibilityScript(page, accessMode, localeKeys)}`

  if (!template.includes('<div id="root"></div>')) {
    throw new Error('The frontend HTML template does not contain an empty #root element.')
  }

  return template
    .replace(/<html lang="[^"]*">/, () => `<html lang="${page.locale}">`)
    .replace(/<title>[\s\S]*?<\/title>/, () => metadata)
    .replace('<div id="root"></div>', () => root)
}

export function prerenderMarketingPages() {
  let config

  return {
    name: 'prerender-marketing-pages',
    apply: 'build',
    configResolved(resolvedConfig) {
      config = resolvedConfig
    },
    async closeBundle() {
      const outputDirectory = isAbsolute(config.build.outDir)
        ? config.build.outDir
        : resolve(config.root, config.build.outDir)
      const template = await readFile(join(outputDirectory, 'index.html'), 'utf8')
      const server = await createServer({
        appType: 'custom',
        configFile: false,
        envDir: config.envDir,
        logLevel: config.logLevel,
        mode: config.mode,
        plugins: [react(), tsconfigPaths()],
        resolve: {
          // Keep the prerender Vite server equal to the production build. y-monaco still imports
          // this old Monaco path while Monaco 0.56 exports the editor from the path below.
          alias: {
            'monaco-editor/esm/vs/editor/editor.api.js': 'monaco-editor/editor',
          },
        },
        root: config.root,
        server: { middlewareMode: true },
      })

      try {
        const {
          BARE_ROOT_RESOLVED_KEY,
          LOCALE_PREFERENCE_KEY,
          renderMarketingPage,
        } = await server.ssrLoadModule('/src/marketing-prerender.tsx')
        const accessMode = config.env.VITE_CF_ACCESS_MODE === 'true'
        const localeKeys = {
          bareRootResolved: BARE_ROOT_RESOLVED_KEY,
          preference: LOCALE_PREFERENCE_KEY,
        }
        const targets = SITE_PAGES
          .filter(page => page.enabled && page.prerendered)
          .flatMap(page => page.locales.map(locale => ({
            locale,
            pagePath: page.path,
            publicPath: localizedPath(page.path, locale),
          })))
        const documents = []
        // The renderer changes the shared Paraglide locale. Render one target at a time.
        for (const target of targets) {
          documents.push({
            ...target,
            content: createDocument(
              template,
              await renderMarketingPage(target.pagePath, target.locale),
              accessMode,
              localeKeys,
            ),
          })
        }

        await Promise.all(documents.map(async ({ content, publicPath }) => {
          const outputPath = outputFilePath(outputDirectory, publicPath)
          await mkdir(dirname(outputPath), { recursive: true })
          await writeFile(outputPath, content)
        }))
      } finally {
        await server.close()
      }
    },
  }
}
