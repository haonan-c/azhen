import {cloudflareTest} from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import {defineConfig} from "vitest/config";

const EXPECTED_DELETED_USER_RPC_ERROR = "This User has been deleted.";
const EXPECTED_SELF_DELETE_RPC_ERROR = "Administrators cannot delete their own User.";

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
    include: [
      "__tests__/usage-summary-facts.test.ts",
      "__tests__/usage-retention.test.ts",
      "__tests__/usage-anonymization.test.ts",
    ],
    fileParallelism: false,
    setupFiles: ["../../test-setup/assert-workerd.ts"],
    // Cap'n Web reports this asserted negative RPC independently. All other unhandled errors keep
    // the default fail-closed policy, and this file group remains serial because it uses singleton
    // production Durable Objects.
    onUnhandledError(error) {
      if (error.name === "Error" &&
          (error.message === EXPECTED_DELETED_USER_RPC_ERROR ||
           error.message === EXPECTED_SELF_DELETE_RPC_ERROR)) return false;
    },
  },
});
