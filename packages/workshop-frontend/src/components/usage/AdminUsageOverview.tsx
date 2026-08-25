import {useCallback, useEffect, useRef, useState, type ReactNode} from "react";
import type {
  AdminApi,
  AdminUsageApi,
  AdminUsageOverview as AdminUsageOverviewView,
  AdminUsageProjectionState,
} from "@gadgets/workshop-shared/api";
import type {RpcStub} from "capnweb";
import {Button} from "@cloudflare/kumo";
import {m as messages} from "../../paraglide/messages.js";
import {getLocale} from "../../paraglide/runtime.js";
import {
  formatUsageCreditSubunits,
  formatUsdRateSubunits,
} from "../billing/formatUsageCredits.js";
import AdminUsageReportBrowser from "./AdminUsageReportBrowser.js";

/** Administrator Usage Projection refresh interval. */
export const ADMIN_USAGE_REFRESH_INTERVAL_MS = 30_000;

type Props = {
  adminApi: RpcStub<AdminApi>;
};

type UsageCapabilityState = {
  api: RpcStub<AdminUsageApi>;
};

function formatInteger(value: bigint): string {
  return new Intl.NumberFormat(getLocale()).format(value);
}

const HEALTH_LABELS: Record<AdminUsageProjectionState, () => string> = {
  healthy: messages.admin_usage_health_healthy,
  lagging: messages.admin_usage_health_lagging,
  rebuilding: messages.admin_usage_health_rebuilding,
  failed: messages.admin_usage_health_failed,
  unavailable: messages.admin_usage_health_unavailable,
};

/** Exact, independently-failing administrator overview for deployment Metered Use. */
export default function AdminUsageOverview({adminApi}: Props) {
  const [usage, setUsage] = useState<UsageCapabilityState | null>(null);
  const [view, setView] = useState<AdminUsageOverviewView | null>(null);
  const [error, setError] = useState(false);
  const [capabilityRetry, setCapabilityRetry] = useState(0);
  const requestSequence = useRef(0);
  const mounted = useRef(true);

  const refresh = useCallback(async (api: RpcStub<AdminUsageApi>) => {
    const sequence = ++requestSequence.current;
    try {
      const next = await api.getOverview();
      if (!mounted.current || sequence !== requestSequence.current) return;
      setView(next);
      setError(false);
    } catch {
      if (!mounted.current || sequence !== requestSequence.current) return;
      setError(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let stub: RpcStub<AdminUsageApi> | null = null;
    let interval: ReturnType<typeof setInterval> | undefined;
    void (async () => {
      try {
        const api = await adminApi.getUsageApi();
        if (disposed) {
          api[Symbol.dispose]();
          return;
        }
        stub = api;
        setUsage({api});
        await refresh(api);
        if (!disposed) {
          interval = setInterval(() => void refresh(api), ADMIN_USAGE_REFRESH_INTERVAL_MS);
        }
      } catch {
        if (!disposed) setError(true);
      }
    })();
    return () => {
      disposed = true;
      mounted.current = false;
      requestSequence.current += 1;
      if (interval !== undefined) clearInterval(interval);
      stub?.[Symbol.dispose]();
    };
  }, [adminApi, capabilityRetry, refresh]);

  if (view === null && !error) {
    return <p role="status" className="text-sm text-kumo-subtle">{messages.admin_usage_loading()}</p>;
  }
  if (view === null) {
    return (
      <div role="alert" className="rounded-xl border border-kumo-line bg-kumo-elevated p-6">
        <p className="text-sm text-kumo-danger">{messages.admin_usage_load_error()}</p>
        <Button className="mt-3" size="sm" variant="secondary" onClick={() => {
          if (usage) void refresh(usage.api);
          else setCapabilityRetry(value => value + 1);
        }}>
          {messages.admin_usage_retry()}
        </Button>
      </div>
    );
  }

  const health = view.health;
  if (view.metrics === null) {
    const isUnavailable = health.state === "unavailable";
    const isFailed = health.state === "failed";
    return (
      <section aria-labelledby="admin-usage-heading" className="space-y-4">
        <UsageHeading />
        <div role={isFailed || isUnavailable ? "alert" : "status"}
          className="rounded-xl border border-kumo-line bg-kumo-elevated p-6">
          <p className={`font-medium ${isFailed || isUnavailable
            ? "text-kumo-danger" : "text-kumo-default"}`}>
            {HEALTH_LABELS[health.state]()}
          </p>
          <p className="mt-1 text-sm text-kumo-subtle">
            {isUnavailable
              ? messages.admin_usage_load_error() : messages.admin_usage_metrics_pending()}
          </p>
          {!isUnavailable && (
            <p className="mt-2 text-sm text-kumo-subtle">
              {messages.admin_usage_rebuild_progress({
                count: formatInteger(health.rebuildUsersProcessed),
              })}
            </p>
          )}
        </div>
      </section>
    );
  }

  const metrics = view.metrics;
  const tokenTotal = metrics.cacheHitInputTokens + metrics.cacheMissInputTokens +
    metrics.cacheWriteInputTokens + metrics.outputTokens;
  return (
    <section aria-labelledby="admin-usage-heading" className="space-y-4">
      <UsageHeading />
      {(metrics.unpricedModelUses > 0n || metrics.unpricedApiOperations > 0n) && (
        <div role="alert" className="rounded-xl border border-kumo-warning bg-kumo-tint p-4">
          <p className="font-medium text-kumo-default">{messages.admin_usage_unpriced()}</p>
          <p className="mt-1 text-sm text-kumo-subtle">
            {messages.admin_usage_unpriced_warning({
              models: formatInteger(metrics.unpricedModelUses),
              operations: formatInteger(metrics.unpricedApiOperations),
            })}
          </p>
        </div>
      )}
      {error && usage && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-kumo-line bg-kumo-elevated p-4">
          <p className="text-sm text-kumo-danger">{messages.admin_usage_refresh_error()}</p>
          <Button size="sm" variant="secondary" onClick={() => void refresh(usage.api)}>
            {messages.admin_usage_retry()}
          </Button>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard label={messages.admin_usage_provider_cost()}
          value={`$${formatUsdRateSubunits(metrics.providerCostUsdSubunits)}`} />
        <MetricCard label={messages.admin_usage_charged_credits()}
          value={formatUsageCreditSubunits(metrics.chargedUsageCreditSubunits)} />
        <MetricCard label={messages.admin_usage_model_tokens()} value={formatInteger(tokenTotal)}>
          <MetricDetail label={messages.admin_usage_cache_hit()}
            value={formatInteger(metrics.cacheHitInputTokens)} />
          <MetricDetail label={messages.admin_usage_cache_miss()}
            value={formatInteger(metrics.cacheMissInputTokens)} />
          <MetricDetail label={messages.admin_usage_cache_write()}
            value={formatInteger(metrics.cacheWriteInputTokens)} />
          <MetricDetail label={messages.admin_usage_output()}
            value={formatInteger(metrics.outputTokens)} />
          <MetricDetail label={messages.admin_usage_reasoning()}
            value={formatInteger(metrics.reasoningTokens)} />
        </MetricCard>
        <MetricCard label={messages.admin_usage_api_operations()}
          value={formatInteger(metrics.billableApiOperations)} />
        <MetricCard label={messages.admin_usage_active_users()}
          value={`${formatInteger(metrics.activeUsers)} / ${formatInteger(view.registeredUsers)}`} />
        <MetricCard label={messages.admin_usage_unpriced()}
          value={`${formatInteger(metrics.unpricedModelUses)} / ${formatInteger(metrics.unpricedApiOperations)}`} />
      </div>
      {usage && typeof usage.api.openReport === "function" && (
        <AdminUsageReportBrowser api={usage.api} />
      )}
      <div role={health.state === "failed" ? "alert" : "status"}
        className="flex flex-wrap items-center justify-between gap-2 text-xs text-kumo-subtle">
        <span>{messages.admin_usage_projection()}: {HEALTH_LABELS[health.state]()}</span>
        {health.pendingEventCount > 0n && (
          <span>{messages.admin_usage_pending_events({
            count: formatInteger(health.pendingEventCount),
          })}</span>
        )}
        {health.deliveryPendingEventCount > 0n && (
          <span>{messages.admin_usage_delivery_pending_events({
            count: formatInteger(health.deliveryPendingEventCount),
          })}</span>
        )}
        {health.sequenceGapCount > 0n && (
          <span>{messages.admin_usage_sequence_gaps({
            count: formatInteger(health.sequenceGapCount),
          })}</span>
        )}
        {health.oldestPendingAt !== null && (
          <span>{messages.admin_usage_oldest_pending({
            time: new Date(health.oldestPendingAt).toLocaleString(getLocale()),
          })}</span>
        )}
        <span>{messages.admin_usage_as_of({
          time: new Date(view.asOf).toLocaleString(getLocale()),
        })}</span>
      </div>
    </section>
  );
}

function UsageHeading() {
  return (
    <div>
      <h2 id="admin-usage-heading" className="text-lg font-semibold text-kumo-strong">
        {messages.admin_usage_title()}
      </h2>
      <p className="mt-1 text-sm text-kumo-subtle">{messages.admin_usage_description()}</p>
    </div>
  );
}

function MetricCard({label, value, children}: {
  label: string;
  value: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-elevated p-4">
      <p className="text-xs font-medium text-kumo-subtle">{label}</p>
      <p className="mt-2 break-all text-xl font-semibold text-kumo-strong">{value}</p>
      {children && <dl className="mt-3 space-y-1">{children}</dl>}
    </div>
  );
}

function MetricDetail({label, value}: {label: string; value: string}) {
  return (
    <div className="flex justify-between gap-3 text-xs text-kumo-subtle">
      <dt>{label}</dt><dd>{value}</dd>
    </div>
  );
}
