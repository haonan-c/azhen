import {cloudflareTest} from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import {defineConfig} from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./src/server.ts",
      remoteBindings: false,
      wrangler: {configPath: "./wrangler.jsonc"},
      miniflare: {
        bindings: {
          USAGE_CAPACITY_MODE: process.env.USAGE_CAPACITY_MODE ?? "",
          ADMINS: [`usagecapacityv1${process.env.USAGE_CAPACITY_MODE ?? "missing"}0`],
          CF_AI_GATEWAY: "capacity-controlled-gateway",
          CF_AI_GATEWAY_ACCOUNT_ID: "capacity-controlled-account",
          CF_AI_GATEWAY_API_TOKEN: "capacity-controlled-token",
          CF_AI_GATEWAY_PROVIDERS: "openai",
        },
      },
    }),
  ],
  test: {
    include: [
      "__capacity__/usage-capacity-v1.test.ts",
      "__capacity__/usage-method-inventory.test.ts",
      "__capacity__/usage-retention-storage.test.ts",
      "__capacity__/usage-aggregate-compaction-storage.test.ts",
    ],
    disableConsoleIntercept: true,
    fileParallelism: false,
    hookTimeout: 12 * 60 * 60 * 1_000,
    testTimeout: 12 * 60 * 60 * 1_000,
    setupFiles: ["../../test-setup/assert-workerd.ts"],
    onUnhandledError(error) {
      if (error.message === "Too many Usage reports are open." ||
          error.message === "Usage Record does not exist." ||
          error.message === "usage-capacity-v1 controlled early cancel") return false;
    },
  },
});
