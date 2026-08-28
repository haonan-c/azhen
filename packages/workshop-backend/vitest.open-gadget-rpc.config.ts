import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./__rpc__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["enhanced_error_serialization", "nodejs_compat"],
        durableObjects: {
          TEST_USAGE_PROJECTION_MONTH: {className: "UsageProjectionMonth", useSQLite: true},
          OPEN_GADGET_ERROR_TEST: {
            className: "OpenGadgetErrorDurableObject",
            useSQLite: true,
          },
        },
      },
    }),
  ],
  test: {
    include: ["__rpc__/*.test.ts"],
    // Cap'n Web reports the rejected future capability independently from the awaited value. The
    // test asserts this exact rejection; all unrelated unhandled errors remain fatal.
    onUnhandledError(error) {
      if ("code" in error &&
          error.code === "OBSERVER_VERIFICATION_FAILED") return false;
    },
  },
});
