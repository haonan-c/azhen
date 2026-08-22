import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "generated" || entry.name === "node_modules") return [];
    return sourceFiles(join(path, entry.name));
  });
}

function productionSource() {
  return [
    "packages/workshop-backend/src",
    "packages/workshop-frontend/src",
    "packages/workshop-frontend/messages",
    "packages/workshop-shared/src",
    "packages/gatekeeper-cloudflare/src",
    "packages/gatekeeper-cloudflare/README.md",
    "packages/workshop-shared/package.json",
    "docs/ai-gateway-billing.md",
    "docs/oauth-signin.md",
    "docs/public-server.md",
    "docs/sharing.md",
    "run-dev-server.js",
  ].flatMap((path) => sourceFiles(join(ROOT, path)))
    .filter((path) => /\.(?:json|js|md|ts|tsx)$/.test(path))
    .filter((path) => !/\.(?:test|spec)\.[^.]+$/.test(path))
    .map((path) => [path, readFileSync(path, "utf8")]);
}

describe("legacy user-funded model routing", () => {
  it("has no production entry point for the daily quota or personal AI Gateway funding", () => {
    const forbidden = [
      "ENABLE_CLOUDFLARE_LIMITS",
      "DAILY_LLM_CALL_LIMIT",
      "MINIMUM_CLOUDFLARE_BALANCE",
      "dailyLlmCount",
      "consumeDailyLlmCall",
      "checkDailyLlmCount",
      "cloudflareBilling",
      "CloudflareUsageInfo",
      "getCloudflareUsage",
      "listCloudflareAccounts",
      "selectCloudflareAccount",
      "getCloudflareGatekeeperAccount",
      "getUsableAccessToken",
      "linkConnectedAccountFromLogin",
      "UserGatewayRouting",
      "userGateway",
      "getModelViaUserGateway",
      "/ai-gateway-billing/credit_balance",
      "/ai/ai-gateway/credits",
      "aig.read",
      "aig.run",
      "account-settings.read",
    ];

    const findings = [];
    for (const [path, source] of productionSource()) {
      for (const symbol of forbidden) {
        if (source.includes(symbol)) findings.push(`${path.slice(ROOT.length + 1)}: ${symbol}`);
      }
    }

    assert.deepEqual(findings, []);
  });

  it("keeps both platform-funded model routes behind the metered model seam", () => {
    const modelSource = readFileSync(
      join(ROOT, "packages/workshop-backend/src/ai-models.ts"),
      "utf8",
    );
    const gatewaySource = readFileSync(
      join(ROOT, "packages/workshop-backend/src/ai-gateway.ts"),
      "utf8",
    );
    const apiSource = readFileSync(
      join(ROOT, "packages/workshop-shared/src/api.ts"),
      "utf8",
    );
    const oauthSource = readFileSync(
      join(ROOT, "packages/gatekeeper-cloudflare/src/oauth.ts"),
      "utf8",
    );
    const cloudflareGatekeeperSource = readFileSync(
      join(ROOT, "packages/gatekeeper-cloudflare/src/cloudflare.ts"),
      "utf8",
    );

    assert.match(modelSource, /function getModelViaGateway\(/);
    assert.match(modelSource, /function getModelDirect\(/);
    assert.match(modelSource, /return meterModelHandle\(handle, options\.metering\);/);
    assert.doesNotMatch(modelSource, /isMeteredModelProvider\(handle\.model\.provider\)/);
    assert.match(gatewaySource, /CF_AI_GATEWAY/);
    assert.match(apiSource, /apiToken\??: string/);
    assert.match(apiSource, /accountId\??: string/);
    assert.match(oauthSource, /export const AUTH_SCOPES/);
    assert.match(oauthSource, /"offline_access"[\s\S]+"user-details\.read"/);
    assert.match(cloudflareGatekeeperSource, /delete\("scopes"\)/);
    assert.match(cloudflareGatekeeperSource, /scopes: AUTH_SCOPES/);
  });
});
