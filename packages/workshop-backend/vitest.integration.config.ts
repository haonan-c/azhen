import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

const EXPECTED_OPEN_ERROR_CODES = new Set([
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_ACCESS_DENIED",
]);
const EXPECTED_USAGE_RATE_ERROR_MESSAGES = new Set([
  "Usage Rate change reason must be a non-empty string of at most 1000 characters.",
  "Model identifier must be a stable provider model identifier of at most 200 characters.",
  "Usage Rate change key appears more than once.",
]);

export default defineConfig({
  esbuild: {
    target: "es2022",
  },
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./src/server.ts",
      remoteBindings: false,
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        bindings: {
          ADMINS: ["deploymentadmin"],
          CF_AI_GATEWAY: "test-gateway",
          CF_AI_GATEWAY_ACCOUNT_ID: "test-account",
          CF_AI_GATEWAY_API_TOKEN: "test-gateway-token",
          CF_AI_GATEWAY_PROVIDERS: "openai",
        },
      },
    }),
  ],
  test: {
    include: ["__integration__/*.test.ts"],
    // Registry negative RPCs need a file-scoped unhandled-error policy. The package test script
    // runs this file separately with vitest.usage-registry-rpc.config.ts.
    exclude: ["__integration__/usage-registry-rpc.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["../../test-setup/assert-workerd.ts"],
    // Whichever test runs first pays for workerd booting and instantiating the whole backend
    // bundle -- ~6s on a dev machine and roughly 3x that on a CI runner, while every subsequent
    // test in the file finishes in tens of milliseconds. The timeout has to clear that cold
    // start, not the steady-state cost, or the first test fails wherever the runner is slow.
    testTimeout: 60_000,
    // A rejected future capability is reported independently from the awaited pipelined call.
    // The tests assert these exact rejections; all unrelated unhandled errors remain fatal.
    onUnhandledError(error) {
      const code = "code" in error ? error.code : undefined;
      if (typeof code === "string" && EXPECTED_OPEN_ERROR_CODES.has(code)) return false;
      // User deletion revokes both a live authenticated Usage surface and its original session.
      // The #65 retention RPC test asserts the matching awaited rejections.
      if (code === "INVALID_SESSION_TOKEN" || error.message === "This User has been deleted.") {
        return false;
      }
      // Cap'n Web also reports the rejected future capability independently from the awaited
      // revoked-model call asserted by the Deployment Model RPC test.
      if (code === "DEPLOYMENT_MODEL_UNAVAILABLE") return false;
      // Cap'n Web reports the rejected AdminApi call independently from the rejection that the
      // Usage Rate RPC test awaits and checks exactly.
      if (EXPECTED_USAGE_RATE_ERROR_MESSAGES.has(error.message)) return false;
      // The reset-recovery tests abort every Durable Object mid-session; capabilities that were
      // held across the abort (e.g. the fire-and-forget AdminSettings install kicked off by the
      // fetch handler) reject on their own schedule, independent of any awaited call.
      if (error.message?.includes("abortAllDurableObjects")) return false;
      // Same, for the test that aborts only the user DO (state.abort with this reason).
      if (error.message?.includes("user-DO reset injected by test")) return false;
      if (error.message?.includes("Action billing crash") ||
          error.message?.includes("Action recovery Overseer reset injected by test")) return false;
      // Cap'n Web also reports the deliberately invalid Gatekeeper response independently from
      // the rejection that the Action recovery test awaits and checks exactly.
      if (error.message === "Gatekeeper returned an invalid Action execution outcome.") return false;
    },
  },
});
