import { useEffect, useState } from "react";
import type { UsageCreditBalance } from "@gadgets/workshop-shared/api";
import { useAuthenticatedApi } from "../../AuthContext";
import { m as messages } from "../../paraglide/messages.js";
import { formatUsageCreditSubunits } from "./formatUsageCredits";

type BalanceLoadState = {
  api: ReturnType<typeof useAuthenticatedApi>["authenticatedApi"];
  balance: UsageCreditBalance | null;
  failed: boolean;
};

/** Shows the authenticated User's authoritative available and reserved Usage Credit balance. */
export default function UsageCreditBalanceCard() {
  const { authenticatedApi } = useAuthenticatedApi();
  // RpcStub is callable, so it must stay wrapped in a state object.
  const [loadState, setLoadState] = useState<BalanceLoadState | null>(null);
  const currentState = loadState?.api === authenticatedApi ? loadState : null;
  const balance = currentState?.balance ?? null;
  const failed = currentState?.failed ?? false;

  useEffect(() => {
    let active = true;
    authenticatedApi.getUsageCreditBalance()
      .then((result) => {
        if (active) {
          setLoadState({ api: authenticatedApi, balance: result, failed: false });
        }
      })
      .catch(() => {
        if (active) {
          setLoadState({ api: authenticatedApi, balance: null, failed: true });
        }
      });
    return () => {
      active = false;
    };
  }, [authenticatedApi]);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="px-1 text-[12px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
        {messages.usage_credit_heading()}
      </h2>
      <div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
        {failed ? (
          <p role="alert" className="text-sm text-kumo-danger">
            {messages.usage_credit_load_error()}
          </p>
        ) : balance === null ? (
          <p role="status" className="text-sm text-kumo-subtle">
            {messages.usage_credit_loading()}
          </p>
        ) : (
          <div className="space-y-2 text-sm text-kumo-default">
            <p>{messages.usage_credit_available({
              amount: formatUsageCreditSubunits(balance.availableSubunits),
            })}</p>
            <p>{messages.usage_credit_reserved({
              amount: formatUsageCreditSubunits(balance.reservedSubunits),
            })}</p>
          </div>
        )}
      </div>
    </section>
  );
}
