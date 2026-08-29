import {cloudflareTest} from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import {defineConfig} from "vitest/config";

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
    include: ["__tests__/usage-projection.test.ts"],
    fileParallelism: false,
    setupFiles: ["../../test-setup/assert-workerd.ts"],
    // The capacity-review fail-soft test drops the table the review reads, and asserts the read
    // rejects so the administrator path is the one that softens it. All other errors stay
    // fail-closed.
    onUnhandledError(error) {
      if (error.message ===
        "no such table: usage_projection_capacity_review_state: SQLITE_ERROR") return false;
    },
  },
});
