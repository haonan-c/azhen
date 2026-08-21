import {cloudflareTest} from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import {defineConfig} from "vitest/config";

const EXPECTED_METERED_MODEL_ERROR_MESSAGES = new Set([
  "Insufficient Usage Credit.",
  "Usage Account is blocked pending billing reconciliation.",
  "stubbed provider stream failure",
]);

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./src/server.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["experimental", "nodejs_compat"],
        durableObjects: {
          TEST_OVERSEER: {className: "OverseerDurableObject", useSQLite: true},
          TEST_ADMIN_SETTINGS: {className: "AdminSettings", useSQLite: true},
          TEST_USER: {className: "UserDurableObject", useSQLite: true},
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/metered-model.test.ts"],
    setupFiles: ["../../test-setup/assert-workerd.ts"],
    // Durable Object RPC and the deliberately broken provider body report these failures outside
    // the awaited pi stream. The allowlist is confined to this one negative-test file.
    onUnhandledError(error) {
      if (EXPECTED_METERED_MODEL_ERROR_MESSAGES.has(error.message)) return false;
    },
  },
});
