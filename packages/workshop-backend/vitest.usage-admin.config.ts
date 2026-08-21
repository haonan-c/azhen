import {defineConfig} from "vitest/config";
import {cloudflareTest} from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";

const EXPECTED_USAGE_ADMIN_ERROR_MESSAGES = new Set([
  "A User account must exist before its Usage Account can be activated.",
  "Administrator operation ID conflicts with its stored request.",
  "Original Credit Ledger Entry has already been reversed.",
  "A Credit Reversal cannot itself be reversed.",
  "Insufficient Usage Credit.",
  "Registry search cursor is invalid.",
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
    include: ["__tests__/usage-account-admin.test.ts"],
    setupFiles: ["../../test-setup/assert-workerd.ts"],
    // Durable Object RPC reports these rejected calls independently from the assertions in this
    // one negative-test file. Every other unit file keeps Vitest's fail-closed default.
    onUnhandledError(error) {
      if (EXPECTED_USAGE_ADMIN_ERROR_MESSAGES.has(error.message)) return false;
    },
  },
});
