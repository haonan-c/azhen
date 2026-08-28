import {cloudflareTest} from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import {defineConfig} from "vitest/config";

const EXPECTED_COMPACTION_ERROR_MESSAGES = new Set([
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
    include: ["__tests__/usage-projection-compaction.test.ts"],
    fileParallelism: false,
    setupFiles: ["../../test-setup/assert-workerd.ts"],
    // The frozen-report negative test asserts this rejection through the RPC boundary.
    // All other errors remain fail-closed.
    onUnhandledError(error) {
      if (EXPECTED_COMPACTION_ERROR_MESSAGES.has(error.message)) return false;
    },
  },
});
