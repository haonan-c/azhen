import { describe, expect, it, vi } from "vitest";
import type { AppUiContext, GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import { UserDurableObject } from "../src/user";

describe("Gatekeeper management app billing", () => {
  it("binds direct operations to the initiating User without a fake Workspace", async () => {
    const userId = "a".repeat(64);
    let context: AppUiContext | undefined;
    const account = {
      async startAppUi(value: AppUiContext) {
        context = {...value, billingAuthorizer: value.billingAuthorizer.dup()};
        return { iframeHtml: "", ui: {} };
      },
    } as unknown as Fetcher<GatekeeperUser>;
    const beginGatekeeperUsage = vi.fn(async () => ({}));
    const markGatekeeperUsageStarted = vi.fn(async () => ({}));
    const completeGatekeeperUsage = vi.fn(async () => ({}));
    const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
    Object.assign(user, {
      ctx: { id: { toString: () => userId } },
      storage: {
        connectedAccounts: {
          get: () => ({
            id: 7,
            account,
            vendorId: "context",
            description: { displayName: "Context", providesUi: { title: "Context", icon: {} } },
          }),
        },
      },
      adminSettings: {
        getByName: () => ({
          async issueGatekeeperChargeSnapshot(vendorId: string, billingMethodKey: string) {
            return {
              kind: "gatekeeper",
              pricing: "unpriced",
              usageRateVersion: 1n,
              issuedAt: new Date(0).toISOString(),
              vendorId,
              billingMethodKey,
              chargeSubunits: 0n,
              configurationGap: true,
            };
          },
        }),
      },
      beginGatekeeperUsage,
      markGatekeeperUsageStarted,
      completeGatekeeperUsage,
    });

    await user.startAccountAppUi(7, { isAdmin: false });
    const operation = await context!.billingAuthorizer.beginBillableOperation(
      "context.management.document.read.v1",
      "context-account",
    );
    await operation.markStarted();
    await operation.complete("executed");

    expect(beginGatekeeperUsage).toHaveBeenCalledWith(
      expect.stringMatching(/^gatekeeper-operation:/),
      {
        principal: { version: 1, kind: "user", userId },
        source: "direct-user",
        vendorId: "context",
        billingMethodKey: "context.management.document.read.v1",
        externalAccountId: "context-account",
      },
      expect.objectContaining({ pricing: "unpriced" }),
    );
    expect(markGatekeeperUsageStarted).toHaveBeenCalledOnce();
    expect(completeGatekeeperUsage).toHaveBeenCalledWith(
      expect.stringMatching(/^gatekeeper-operation:/),
      "executed",
    );
    context!.billingAuthorizer[Symbol.dispose]?.();
  });
});
