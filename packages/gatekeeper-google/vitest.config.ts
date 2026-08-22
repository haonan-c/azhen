import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-02-02",
        compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
        durableObjects: {
          TEST_GMAIL_GATEKEEPER: { className: "GmailGatekeeperImpl", useSQLite: true },
          TEST_GOOGLE_DOC_GATEKEEPER: { className: "GoogleDocGatekeeperImpl", useSQLite: true },
          TEST_GOOGLE_SHEETS_GATEKEEPER: {
            className: "GoogleSheetsGatekeeperImpl",
            useSQLite: true,
          },
          TEST_GOOGLE_CALENDAR_GATEKEEPER: {
            className: "GoogleCalendarGatekeeperImpl",
            useSQLite: true,
          },
          TEST_BIGQUERY_GATEKEEPER: {
            className: "BigQueryGatekeeperImpl",
            useSQLite: true,
          },
          GOOGLE_BILLING_TEST_PARENT: {
            className: "GoogleBillingTestParent",
            useSQLite: true,
          },
          TEST_USER_ACCOUNT: { className: "UserAccount", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    setupFiles: ["../../test-setup/assert-workerd.ts"],
  },
});
