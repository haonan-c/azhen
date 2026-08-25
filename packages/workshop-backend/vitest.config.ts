import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import capnwebValidate from 'capnweb-validate/vite'

/**
 * Tests run inside workerd (via vitest-pool-workers) so they exercise the same runtime APIs as
 * production -- e.g. Uint8Array.toHex/fromHex and crypto.subtle used by the sharing module. Most
 * tests import modules directly; the main Worker and a test-only SQLite DO binding support the
 * Overseer cost-persistence integration test without loading the full deployment configuration.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: './src/server.ts',
      miniflare: {
        compatibilityDate: '2026-02-02',
        compatibilityFlags: ['experimental', 'nodejs_compat'],
        durableObjects: {
          TEST_OVERSEER: { className: 'OverseerDurableObject', useSQLite: true },
          TEST_ADMIN_SETTINGS: { className: 'AdminSettings', useSQLite: true },
          TEST_USER: { className: 'UserDurableObject', useSQLite: true },
          TEST_USAGE_PROJECTION: { className: 'UsageProjection', useSQLite: true },
        },
        kvNamespaces: ['AVATARS'],
      },
    }),
  ],
  test: {
    include: ['__tests__/*.test.ts'],
    // Expected rejected Durable Object RPCs need a file-scoped unhandled-error policy. The package
    // test script runs this file separately with vitest.usage-admin.config.ts.
    exclude: [
      '__tests__/usage-account-admin.test.ts',
      '__tests__/metered-model.test.ts',
      '__tests__/usage-summary-facts.test.ts',
      '__tests__/usage-retention.test.ts',
      '__tests__/usage-anonymization.test.ts',
      '__tests__/usage-projection.test.ts',
    ],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ['../../test-setup/assert-workerd.ts'],
  },
})
