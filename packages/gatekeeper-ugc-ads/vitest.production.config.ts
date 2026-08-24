import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { kCurrentWorker } from "miniflare";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/production-worker.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_compat"],
        durableObjects: {
          TEST_UGC_GATEKEEPER: {className: "UgcAdsGatekeeper", useSQLite: true},
        },
        serviceBindings: {
          TEST_UGC_OUTBOUND_TRACE: {name: kCurrentWorker, entrypoint: "OutboundTrace"},
        },
        outboundService: {name: kCurrentWorker, entrypoint: "FailClosedOutbound"},
      },
    }),
  ],
  test: {
    include: ["__tests__/*.workerd.ts"],
    setupFiles: ["../../test-setup/assert-workerd.ts"],
  },
});
