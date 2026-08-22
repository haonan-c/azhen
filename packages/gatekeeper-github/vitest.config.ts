import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
        durableObjects: {
          TEST_GITHUB_GATEKEEPER: {
            className: "GitHubBillingTestGatekeeper",
            useSQLite: true,
          },
          TEST_GITHUB_USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
          GITHUB_BILLING_TEST_PARENT: {
            className: "GitHubBillingTestParent",
            useSQLite: true,
          },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    setupFiles: ["../../test-setup/assert-workerd.ts"],
  },
});
