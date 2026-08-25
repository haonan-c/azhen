import {cloudflareTest} from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import {defineConfig} from "vitest/config";

const EXPECTED_USAGE_RETENTION_RPC_ERROR_MESSAGES = new Set([
  "This User has been deleted.",
  "invalid session token",
]);

export default defineConfig({
  esbuild: {target: "es2022"},
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./src/server.ts",
      remoteBindings: false,
      wrangler: {configPath: "./wrangler.jsonc"},
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
    include: ["__integration__/usage-retention-rpc.test.ts"],
    setupFiles: ["../../test-setup/assert-workerd.ts"],
    testTimeout: 60_000,
    // Cap'n Web reports these two awaited revocation failures independently in this one file.
    // Every other integration file keeps the narrower shared policy.
    onUnhandledError(error) {
      if (EXPECTED_USAGE_RETENTION_RPC_ERROR_MESSAGES.has(error.message)) return false;
    },
  },
});
