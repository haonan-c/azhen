import {runDurableObjectAlarm} from "cloudflare:test";
import {exports} from "cloudflare:workers";
import {expect, test} from "vitest";
import type {GatekeeperChargeSnapshot} from "@gadgets/workshop-shared/api";
import {publicBillingMethodInventory} from "../src/generated/public-billing-methods.js";
import type {GatekeeperUsageAttribution} from "../src/usage-account.js";
import type {UsageProjectionFact} from "../src/usage-projection.js";
import {readAcrossProjection} from "./projection-rows.js";

test("delivers every generated public billing method through User authority and Projection", async () => {
  expect(publicBillingMethodInventory).toHaveLength(355);
  const expected = publicBillingMethodInventory.map(method =>
    `${method.vendorId}\u0000${method.billingMethodKey}`).toSorted();
  expect(new Set(expected).size).toBe(expected.length);

  const identity = "usagecapacityv1methodinventory";
  const id = exports.UserDurableObject.idFromName(identity);
  const user = exports.UserDurableObject.get(id);
  expect(await user.createAccount(
    identity, "Capacity Method Inventory", new Uint8Array([1]),
  )).not.toBeNull();
  await user.activateUsageAccount();
  const projection = exports.UsageProjection.getByName(crypto.randomUUID());
  for (let step = 0; step < 1_000 && !await projection.ensureBootstrap(); step += 1) {
    await runDurableObjectAlarm(projection);
  }
  expect(await projection.ensureBootstrap()).toBe(true);

  for (let offset = 0; offset < publicBillingMethodInventory.length; offset += 25) {
    await Promise.all(publicBillingMethodInventory.slice(offset, offset + 25)
        .map(async (method, index) => {
          const ordinal = offset + index;
          const operationId = `usage-capacity-method:${ordinal}`;
          const attribution: GatekeeperUsageAttribution = {
            principal: {version: 1, kind: "user", userId: id.toString()},
            source: "agent",
            workspaceId: "e".repeat(64),
            vendorId: method.vendorId,
            billingMethodKey: method.billingMethodKey,
            externalAccountId: `capacity-method-account-${ordinal}`,
          };
          const snapshot: GatekeeperChargeSnapshot = {
            kind: "gatekeeper",
            pricing: "unpriced",
            usageRateVersion: 1n,
            issuedAt: "2026-08-26T00:00:00.000Z",
            vendorId: method.vendorId,
            billingMethodKey: method.billingMethodKey,
            chargeSubunits: 0n,
            configurationGap: true,
          };
          await user.beginGatekeeperUsage(operationId, attribution, snapshot);
          await user.markGatekeeperUsageStarted(operationId);
          await user.completeGatekeeperUsage(operationId, "executed");
        }));
  }

  const facts: UsageProjectionFact[] = [];
  let afterSourceSequence: bigint | null = null;
  do {
    const page = await user.listUsageProjectionFacts(afterSourceSequence, 100);
    facts.push(...page.facts);
    afterSourceSequence = page.nextSourceSequence;
  } while (afterSourceSequence !== null);
  expect(facts.filter(fact => fact.rowKind === "detail")).toHaveLength(355);
  for (let offset = 0; offset < facts.length; offset += 64) {
    const ingest = await projection.ingest(facts.slice(offset, offset + 64));
    expect(ingest.rejected).toEqual([]);
  }
  // Delivered rows live in their UTC month object, so the covered methods are the union over
  // every store this projection writes to.
  const methods = await readAcrossProjection<{
    vendor_id: string;
    billing_method_key: string;
  }>(projection, `
    SELECT DISTINCT vendor_id, billing_method_key
    FROM usage_projection_facts
    WHERE row_kind = 'detail' AND applied = 1
  `);
  const actual = [...new Set(methods.map(
    method => `${method.vendor_id}\u0000${method.billing_method_key}`))].toSorted();
  expect(actual).toEqual(expected);
});
