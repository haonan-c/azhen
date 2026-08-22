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
          TEST_SPOTIFY_GATEKEEPER: {
            className: "SpotifyGatekeeperImpl",
            useSQLite: true,
          },
          TEST_USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
          SPOTIFY_BILLING_TEST_PARENT: {
            className: "SpotifyBillingTestParent",
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
