import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { createServer } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function startupVisibilityScript(page, accessMode, localeKeys) {
  return `<script>(() => {
    const expectedPath = ${JSON.stringify(page.homePath)};
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

function createDocument(template, page, accessMode, localeKeys) {
  const title = escapeHtml(page.title)
  const description = escapeHtml(page.description)
  const metadata = `<title>${title}</title>
    <meta name="description" content="${description}" />
    <meta property="og:type" content="website" />
    <meta property="og:locale" content="${page.locale === 'zh' ? 'zh_CN' : 'en_US'}" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />`
  const root = `<div id="root" data-prerendered-locale="${page.locale}">${page.body}</div>
    ${startupVisibilityScript(page, accessMode, localeKeys)}`

  if (!template.includes('<div id="root"></div>')) {
    throw new Error('The frontend HTML template does not contain an empty #root element.')
  }

  return template
    .replace(/<html lang="[^"]*">/, `<html lang="${page.locale}">`)
    .replace(/<title>[\s\S]*?<\/title>/, metadata)
    .replace('<div id="root"></div>', root)
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
          // Keep the SSR/prerender Vite server in sync with the production build. y-monaco still
          // imports this legacy Monaco path while Monaco 0.56 exposes the editor entrypoint via
          // the package export below.
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
        const english = await renderMarketingPage('en')
        const chinese = await renderMarketingPage('zh')

        await mkdir(join(outputDirectory, 'zh'), { recursive: true })
        await Promise.all([
          writeFile(join(outputDirectory, 'index.html'), createDocument(template, english, accessMode, localeKeys)),
          writeFile(join(outputDirectory, 'zh', 'index.html'), createDocument(template, chinese, accessMode, localeKeys)),
        ])
      } finally {
        await server.close()
      }
    },
  }
}
