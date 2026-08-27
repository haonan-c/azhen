import {cloudflareTest} from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import {defineConfig} from "vitest/config";

// Retention deliberately invalidates a report frozen before its cutoff, and the RPC layer
// surfaces that rejection outside the awaiting test.
const EXPECTED_DELIVERY_ERROR_MESSAGES = new Set([
  "Usage report snapshot is stale.",
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
          TEST_USAGE_PROJECTION: {className: "UsageProjection", useSQLite: true},
          TEST_USAGE_PROJECTION_MONTH: {className: "UsageProjectionMonth", useSQLite: true},
        },
        kvNamespaces: ["AVATARS"],
      },
    }),
  ],
  test: {
    include: ["__tests__/usage-projection-month-delivery.test.ts"],
    // This suite reports a measured size breakdown, so its output must reach the run log.
    disableConsoleIntercept: true,
    fileParallelism: false,
    setupFiles: ["../../test-setup/assert-workerd.ts"],
    // All other errors remain fail-closed.
    onUnhandledError(error) {
      if (EXPECTED_DELIVERY_ERROR_MESSAGES.has(error.message)) return false;
    },
  },
});
