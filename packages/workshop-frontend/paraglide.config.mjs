/** @type {import('@inlang/paraglide-js').CompilerOptions} */
export const paraglideOptions = {
  project: './project.inlang',
  outdir: './src/paraglide',
  emitTsDeclarations: true,
  strategy: ['url', 'baseLocale'],
  urlPatterns: [
    {
      pattern: '/',
      localized: [
        ['zh', '/zh'],
        ['en', '/'],
      ],
    },
    {
      pattern: '/:path(.*)?',
      localized: [
        ['zh', '/zh/:path(.*)?'],
        ['en', '/:path(.*)?'],
      ],
    },
  ],
}
