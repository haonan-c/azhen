import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import { kCurrentWorker } from "miniflare";

const EXPECTED_BILLING_REJECTIONS = new Set([
  "Insufficient Usage Credit.",
  "Observation withheld by the host.",
  "Admin access required.",
  "Simulated propagation failure.",
  "Simulated Git propagation failure.",
  "Simulated completion response loss.",
  "Gatekeeper Metering completion conflicts with its Usage Record.",
  "Simulated background artifact refresh failure.",
  "Simulated Artifacts response loss.",
  "Simulated Artifacts read-token cleanup failure.",
  "Simulated management result delivery failure.",
  "Collection is not git-based.",
]);

export default defineConfig({
  plugins: [
    tsconfigPaths(),
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/production-worker.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_compat"],
        durableObjects: {
          TEST_CONTEXT_COLLECTION: {
            className: "ContextCollectionDurableObject",
            useSQLite: true,
          },
          TEST_USER_LIBRARY: { className: "UserLibraryDurableObject", useSQLite: true },
          TEST_LIBRARY_REGISTRY: { className: "LibraryRegistryDurableObject", useSQLite: true },
          TEST_CONTEXT_GATEKEEPER: { className: "ContextGatekeeper", useSQLite: true },
          TEST_USER: { className: "UserDurableObject", useSQLite: true },
          TEST_ADMIN_SETTINGS: { className: "AdminSettings", useSQLite: true },
          TEST_ARTIFACT_REPO: { className: "ArtifactRepoMock", useSQLite: true },
        },
        kvNamespaces: ["CONTEXT_COLLECTIONS"],
        serviceBindings: {
          ARTIFACTS: { name: kCurrentWorker, entrypoint: "ArtifactsMock" },
          TEST_ARTIFACTS_TRACE: { name: kCurrentWorker, entrypoint: "ArtifactsTrace" },
          TEST_GIT_HTTP: { name: kCurrentWorker, entrypoint: "GitHttpControl" },
        },
        outboundService: { name: kCurrentWorker, entrypoint: "GitHttpMock" },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.workerd.ts"],
    setupFiles: ["../../test-setup/assert-workerd.ts"],
    // Durable Object RPC reports expected rejections outside their awaited calls. Keep the
    // allowlist local to this negative tracer and fail closed for every other runtime error.
    onUnhandledError(error) {
      if (EXPECTED_BILLING_REJECTIONS.has(error.message)) return false;
    },
  },
});
