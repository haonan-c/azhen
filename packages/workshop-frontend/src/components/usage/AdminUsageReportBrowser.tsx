import {Button} from "@cloudflare/kumo";
import type {
  AdminUsageApi,
  AdminUsageRecordDetail,
  AdminUsageReportFilter,
  AdminUsageReportOutcome,
  AdminUsageReportOverview,
  AdminUsageReportPage,
  AdminUsageReportRow,
  UsageSource,
} from "@gadgets/workshop-shared/api";
import type {RpcStub} from "capnweb";
import {useCallback, useEffect, useRef, useState} from "react";
import {makeExportFilename, saveStreamToFile} from "../../fileTransfers.js";
import {m as messages} from "../../paraglide/messages.js";
import {getLocale} from "../../paraglide/runtime.js";
import {
  formatUsageCreditSubunits,
  formatUsdRateSubunits,
} from "../billing/formatUsageCredits.js";

type Props = {api: RpcStub<AdminUsageApi>};
type ReportState = {api: RpcStub<import("@gadgets/workshop-shared/api").AdminUsageReport>};

type FilterForm = {
  startDate: string;
  endDate: string;
  users: string;
  gadgets: string;
  models: string;
  gatekeepers: string;
  methods: string;
  externalAccounts: string;
  source: "" | UsageSource;
  outcome: "" | AdminUsageReportOutcome;
  pricing: "" | "priced" | "unpriced";
  kind: "" | "model" | "gatekeeper" | "attempt";
};

const EMPTY_FILTER: FilterForm = {
  startDate: "",
  endDate: "",
  users: "",
  gadgets: "",
  models: "",
  gatekeepers: "",
  methods: "",
  externalAccounts: "",
  source: "",
  outcome: "",
  pricing: "",
  kind: "",
};

const SOURCES: UsageSource[] = [
  "agent", "gadget", "direct-user", "system-assistance", "hook", "scheduled",
];
const OUTCOMES: AdminUsageReportOutcome[] = [
  "settled", "failed-before-execution", "usage-unknown", "reconciliation-required",
  "reconciled-settled", "reconciled-released",
];

function formatReportInteger(value: bigint): string {
  return new Intl.NumberFormat(getLocale()).format(value);
}

function commaSeparatedValues(value: string): string[] {
  return value.split(",").map(item => item.trim()).filter(Boolean);
}

/** Filtered, paginated, authoritative administrator Usage reporting surface. */
export default function AdminUsageReportBrowser({api}: Props) {
  const [form, setForm] = useState<FilterForm>(EMPTY_FILTER);
  const [filter, setFilter] = useState<AdminUsageReportFilter>({});
  const [report, setReport] = useState<ReportState | null>(null);
  const [overview, setOverview] = useState<AdminUsageReportOverview | null>(null);
  const [page, setPage] = useState<AdminUsageReportPage | null>(null);
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [error, setError] = useState(false);
  const [detail, setDetail] = useState<AdminUsageRecordDetail | null>(null);
  const [detailRow, setDetailRow] = useState<AdminUsageReportRow | null>(null);
  const [detailError, setDetailError] = useState(false);
  const [exportState, setExportState] = useState<"idle" | "exporting" | "failed">("idle");
  const exportAbort = useRef<AbortController | null>(null);
  const requestRevision = useRef(0);
  const detailRevision = useRef(0);
  const pageRevision = useRef(0);

  useEffect(() => {
    const revision = ++requestRevision.current;
    let disposed = false;
    let stub: RpcStub<import("@gadgets/workshop-shared/api").AdminUsageReport> | null = null;
    setReport(null);
    setOverview(null);
    setPage(null);
    setCursorStack([undefined]);
    setCursorIndex(0);
    setError(false);
    exportAbort.current?.abort();
    exportAbort.current = null;
    setExportState("idle");
    detailRevision.current += 1;
    pageRevision.current += 1;
    setDetail(null);
    setDetailRow(null);
    setDetailError(false);
    void (async () => {
      try {
        const opened = await api.openReport(filter);
        if (disposed || revision !== requestRevision.current) {
          opened[Symbol.dispose]();
          return;
        }
        stub = opened;
        setReport({api: opened});
        const [nextOverview, nextPage] = await Promise.all([
          opened.getOverview(),
          opened.listRows({limit: 50}),
        ]);
        if (disposed || revision !== requestRevision.current) return;
        setOverview(nextOverview);
        setPage(nextPage);
      } catch {
        if (!disposed && revision === requestRevision.current) {
          stub?.[Symbol.dispose]();
          stub = null;
          setReport(null);
          setOverview(null);
          setPage(null);
          setError(true);
        }
      }
    })();
    return () => {
      disposed = true;
      requestRevision.current += 1;
      exportAbort.current?.abort();
      stub?.[Symbol.dispose]();
    };
  }, [api, filter]);

  const loadPage = useCallback(async (index: number, cursor: string | undefined) => {
    if (!report) return;
    const reportRevision = requestRevision.current;
    const revision = ++pageRevision.current;
    try {
      const next = await report.api.listRows({...(cursor ? {cursor} : {}), limit: 50});
      if (reportRevision !== requestRevision.current || revision !== pageRevision.current) return;
      setPage(next);
      setCursorIndex(index);
      setError(false);
    } catch {
      if (reportRevision === requestRevision.current && revision === pageRevision.current) {
        setError(true);
      }
    }
  }, [report]);

  const applyFilter = () => {
    try {
      setFilter(reportFilterFromForm(form));
      setError(false);
    } catch {
      setError(true);
    }
  };
  const exportReport = async () => {
    if (!report || exportState === "exporting") return;
    const revision = requestRevision.current;
    const controller = new AbortController();
    exportAbort.current = controller;
    setExportState("exporting");
    let streamCreated = false;
    const cancelServerExport = async () => {
      await report.api.cancelCsvExports().catch(() => undefined);
    };
    const cancelServerExportOnAbort = () => {
      void cancelServerExport();
    };
    controller.signal.addEventListener("abort", cancelServerExportOnAbort, {once: true});
    try {
      await saveStreamToFile(
        async () => {
          const stream = await report.api.exportCsv();
          streamCreated = true;
          return stream;
        },
        makeExportFilename(`usage-${new Date().toISOString().slice(0, 10)}`, ".csv"),
        controller.signal,
      );
      if (revision === requestRevision.current) setExportState("idle");
    } catch (caught) {
      const aborted = caught instanceof DOMException && caught.name === "AbortError";
      if (!aborted && streamCreated) await cancelServerExport();
      if (revision !== requestRevision.current) return;
      if (aborted) setExportState("idle");
      else setExportState("failed");
    } finally {
      controller.signal.removeEventListener("abort", cancelServerExportOnAbort);
      if (exportAbort.current === controller) exportAbort.current = null;
    }
  };

  const readDetail = async (row: AdminUsageReportRow, clear = true) => {
    if (row.rowKind !== "detail") return false;
    const reportRevision = requestRevision.current;
    const revision = ++detailRevision.current;
    if (clear) setDetail(null);
    setDetailRow(row);
    setDetailError(false);
    try {
      const next = await api.getRecordDetail({
        registeredUserRef: row.registeredUserRef,
        safeRecordRef: row.safeRecordRef,
      });
      if (reportRevision === requestRevision.current && revision === detailRevision.current) {
        setDetail(next);
        return true;
      }
      return false;
    } catch {
      if (reportRevision === requestRevision.current && revision === detailRevision.current) {
        setDetail(null);
        setDetailError(true);
      }
      return false;
    }
  };

  return (
    <section aria-labelledby="admin-usage-report-heading" className="space-y-4">
      <div>
        <h3 id="admin-usage-report-heading" className="text-base font-semibold text-kumo-strong">
          {messages.admin_usage_report_title()}
        </h3>
        <p className="mt-1 text-sm text-kumo-subtle">
          {messages.admin_usage_report_description()}
        </p>
      </div>
      <FilterGrid form={form} setForm={setForm} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={applyFilter}>{messages.admin_usage_apply_filters()}</Button>
        <Button size="sm" variant="secondary" onClick={() => {
          setForm(EMPTY_FILTER);
          setFilter({});
        }}>{messages.admin_usage_clear_filters()}</Button>
        <Button size="sm" variant="secondary" disabled={!report || exportState === "exporting"}
          onClick={() => void exportReport()}>{messages.admin_usage_export_csv()}</Button>
        {exportState === "exporting" && <Button size="sm" variant="secondary"
          onClick={() => exportAbort.current?.abort()}>{messages.admin_usage_cancel_export()}</Button>}
        {exportState === "exporting" && <span role="status" className="text-sm text-kumo-subtle">
          {messages.admin_usage_exporting()}
        </span>}
        {exportState === "failed" && <span role="alert" className="text-sm text-kumo-danger">
          {messages.admin_usage_export_error()}
        </span>}
      </div>
      {error && <p role="alert" className="text-sm text-kumo-danger">
        {messages.admin_usage_report_load_error()}
      </p>}
      {!error && (!overview || !page) && <p role="status" className="text-sm text-kumo-subtle">
        {messages.admin_usage_report_loading()}
      </p>}
      {overview && <ReportSummary overview={overview} />}
      {page && <ReportTable page={page} onDetail={readDetail} />}
      {page && <div className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={cursorIndex === 0} onClick={() => {
          const index = cursorIndex - 1;
          void loadPage(index, cursorStack[index]);
        }}>{messages.admin_usage_previous_page()}</Button>
        <Button size="sm" variant="secondary" disabled={page.nextCursor === null} onClick={() => {
          if (!page.nextCursor) return;
          const index = cursorIndex + 1;
          const nextStack = [...cursorStack.slice(0, index), page.nextCursor];
          setCursorStack(nextStack);
          void loadPage(index, page.nextCursor);
        }}>{messages.admin_usage_next_page()}</Button>
      </div>}
      {(detail || detailError) && <DetailPanel detail={detail} error={detailError}
        api={api}
        registeredUserRef={detailRow?.registeredUserRef ?? null}
        onRefresh={detailRow?.rowKind === "detail"
          ? () => readDetail(detailRow, false) : async () => false}
        onClose={() => {
          detailRevision.current += 1;
          setDetail(null);
          setDetailRow(null);
          setDetailError(false);
        }} />}
    </section>
  );
}

function FilterGrid({form, setForm}: {
  form: FilterForm;
  setForm: (value: FilterForm) => void;
}) {
  const input = (key: keyof FilterForm, label: string, type = "text") => (
    <label className="space-y-1 text-xs text-kumo-subtle">
      <span>{label}</span>
      <input type={type} value={form[key]} onChange={event => setForm({
        ...form,
        [key]: event.target.value,
      })} className="w-full rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-sm text-kumo-default" />
    </label>
  );
  return <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
    {input("startDate", messages.admin_usage_filter_start_date(), "date")}
    {input("endDate", messages.admin_usage_filter_end_date(), "date")}
    {input("users", messages.admin_usage_filter_users())}
    {input("gadgets", messages.admin_usage_filter_gadgets())}
    {input("models", messages.admin_usage_filter_models())}
    {input("gatekeepers", messages.admin_usage_filter_gatekeepers())}
    {input("methods", messages.admin_usage_filter_methods())}
    {input("externalAccounts", messages.admin_usage_filter_external_accounts())}
    <Select label={messages.admin_usage_filter_source()} value={form.source}
      onChange={source => setForm({...form, source: source as FilterForm["source"]})}
      options={SOURCES.map(value => [value, sourceLabel(value)])} />
    <Select label={messages.admin_usage_filter_outcome()} value={form.outcome}
      onChange={outcome => setForm({...form, outcome: outcome as FilterForm["outcome"]})}
      options={OUTCOMES.map(value => [value, outcomeLabel(value)])} />
    <Select label={messages.admin_usage_filter_pricing()} value={form.pricing}
      onChange={pricing => setForm({...form, pricing: pricing as FilterForm["pricing"]})}
      options={[["priced", messages.admin_usage_priced()], ["unpriced", messages.admin_usage_unpriced()]]} />
    <Select label={messages.admin_usage_filter_kind()} value={form.kind}
      onChange={kind => setForm({...form, kind: kind as FilterForm["kind"]})}
      options={[
        ["model", messages.admin_usage_kind_model()],
        ["gatekeeper", messages.admin_usage_kind_gatekeeper()],
        ["attempt", messages.admin_usage_kind_attempt()],
      ]} />
  </div>;
}

function Select({label, value, options, onChange}: {
  label: string;
  value: string;
  options: string[][];
  onChange: (value: string) => void;
}) {
  return <label className="space-y-1 text-xs text-kumo-subtle"><span>{label}</span>
    <select value={value} onChange={event => onChange(event.target.value)}
      className="w-full rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-sm text-kumo-default">
      <option value="">{messages.admin_usage_filter_any()}</option>
      {options.map(([option, text]) => <option key={option} value={option}>{text}</option>)}
    </select>
  </label>;
}

function ReportSummary({overview}: {overview: AdminUsageReportOverview}) {
  return <div role="status" className="rounded-lg border border-kumo-line p-3 text-xs text-kumo-subtle">
    <p>{messages.admin_usage_report_rows_summary({
      users: formatReportInteger(overview.metrics.activeUsers),
      uses: formatReportInteger(overview.metrics.meteredUseCount),
      operations: formatReportInteger(overview.metrics.billableApiOperations),
      failures: formatReportInteger(overview.metrics.preExecutionFailures),
      unknown: formatReportInteger(overview.metrics.unknownOperations),
    })}</p>
    <dl className="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-2 lg:grid-cols-4">
      <dt>{messages.admin_usage_provider_cost()}</dt>
      <dd>${formatUsdRateSubunits(overview.metrics.providerCostUsdSubunits)}</dd>
      <dt>{messages.admin_usage_charged_credits()}</dt>
      <dd>{formatUsageCreditSubunits(overview.metrics.chargedUsageCreditSubunits)}</dd>
      <dt>{messages.admin_usage_model_tokens()}</dt>
      <dd>{[
        overview.metrics.cacheHitInputTokens,
        overview.metrics.cacheMissInputTokens,
        overview.metrics.cacheWriteInputTokens,
        overview.metrics.outputTokens,
        overview.metrics.reasoningTokens,
      ].map(formatReportInteger).join(" / ")}</dd>
      <dt>{messages.admin_usage_unpriced()}</dt>
      <dd>{formatReportInteger(overview.metrics.unpricedModelUses)} / {
        formatReportInteger(overview.metrics.unpricedApiOperations)}</dd>
    </dl>
    <span>{overview.snapshot.reportTimeZone}</span>
    <span className="ml-3">g{overview.snapshot.projectionGeneration.toString()} / w{
      overview.snapshot.ingestionWatermark.toString()}</span>
  </div>;
}

function ReportTable({page, onDetail}: {
  page: AdminUsageReportPage;
  onDetail: (row: AdminUsageReportRow) => void;
}) {
  if (page.rows.length === 0) return <p className="text-sm text-kumo-subtle">
    {messages.admin_usage_report_empty()}
  </p>;
  return <div className="overflow-x-auto rounded-lg border border-kumo-line"><table className="min-w-full text-left text-xs">
    <thead><tr className="border-b border-kumo-line text-kumo-subtle">
      <th className="p-2">{messages.admin_usage_column_time()}</th>
      <th className="p-2">{messages.admin_usage_column_user()}</th>
      <th className="p-2">{messages.admin_usage_column_kind()}</th>
      <th className="p-2">{messages.admin_usage_column_source()}</th>
      <th className="p-2">{messages.admin_usage_column_outcome()}</th>
      <th className="p-2">{messages.admin_usage_column_pricing_status()}</th>
      <th className="p-2">{messages.admin_usage_column_target()}</th>
      <th className="p-2">{messages.admin_usage_column_provider_cost()}</th>
      <th className="p-2">{messages.admin_usage_column_charge()}</th>
      <th className="p-2">{messages.admin_usage_column_tokens()}</th>
      <th className="p-2">{messages.admin_usage_column_unpriced_counts()}</th>
      <th className="p-2">{messages.admin_usage_column_metered_uses()}</th>
      <th className="p-2">{messages.admin_usage_column_billable_operations()}</th>
      <th className="p-2">{messages.admin_usage_column_pre_execution_failures()}</th>
      <th className="p-2">{messages.admin_usage_column_unknown_operations()}</th>
      <th className="p-2">{messages.admin_usage_column_detail()}</th>
    </tr></thead>
    <tbody>{page.rows.map(row => <tr key={row.rowId} className="border-b border-kumo-line last:border-0">
      <td className="whitespace-nowrap p-2">{row.rowKind === "detail"
        ? row.reportLocalTimestamp : row.reportLocalBucketStart}</td>
      <td className="p-2 font-mono">{row.registeredUserRef}</td>
      <td className="p-2">{row.rowKind === "aggregate"
        ? `${messages.admin_usage_row_aggregate()} · ${meteredKindLabel(row.meteredKind)}`
        : meteredKindLabel(row.meteredKind)}</td>
      <td className="p-2">{sourceLabel(row.source)}</td>
      <td className="p-2">{outcomeLabel(row.outcome)}</td>
      <td className="p-2">{row.pricingStatus === "priced"
        ? messages.admin_usage_priced() : messages.admin_usage_unpriced()}</td>
      <td className="p-2">{row.deploymentModelId ?? [row.gatekeeperId, row.stableMethodKey]
        .filter(Boolean).join(" / ")}</td>
      <td className="p-2">${formatUsdRateSubunits(row.metrics.providerCostUsdSubunits)}</td>
      <td className="p-2">{formatUsageCreditSubunits(row.metrics.chargedUsageCreditSubunits)}</td>
      <td className="p-2">{[
        row.metrics.cacheHitInputTokens,
        row.metrics.cacheMissInputTokens,
        row.metrics.cacheWriteInputTokens,
        row.metrics.outputTokens,
        row.metrics.reasoningTokens,
      ].map(formatReportInteger).join(" / ")}</td>
      <td className="p-2">{formatReportInteger(row.metrics.unpricedModelUses)} / {
        formatReportInteger(row.metrics.unpricedApiOperations)}</td>
      <td className="p-2">{formatReportInteger(row.metrics.meteredUseCount)}</td>
      <td className="p-2">{formatReportInteger(row.metrics.billableApiOperations)}</td>
      <td className="p-2">{formatReportInteger(row.metrics.preExecutionFailures)}</td>
      <td className="p-2">{formatReportInteger(row.metrics.unknownOperations)}</td>
      <td className="p-2">{row.rowKind === "detail" && <Button size="sm" variant="secondary"
        onClick={() => void onDetail(row)}>{messages.admin_usage_view_detail()}</Button>}</td>
    </tr>)}</tbody>
  </table></div>;
}

function DetailPanel({detail, error, api, registeredUserRef, onRefresh, onClose}: {
  detail: AdminUsageRecordDetail | null;
  error: boolean;
  api: RpcStub<AdminUsageApi>;
  registeredUserRef: string | null;
  onRefresh: () => Promise<boolean>;
  onClose: () => void;
}) {
  return <aside role={error ? "alert" : "dialog"} aria-label={messages.admin_usage_detail_title()}
    className="rounded-lg border border-kumo-line bg-kumo-elevated p-4">
    <div className="flex justify-between gap-3"><h4 className="font-semibold text-kumo-strong">
      {messages.admin_usage_detail_title()}</h4><Button size="sm" variant="secondary" onClick={onClose}>
      {messages.admin_usage_detail_close()}</Button></div>
    {error && <p className="mt-2 text-sm text-kumo-danger">{messages.admin_usage_detail_error()}</p>}
    {detail && <><dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
      <dt>{messages.admin_usage_column_kind()}</dt><dd>{detail.record.kind}</dd>
      <dt>{messages.admin_usage_column_source()}</dt><dd>{sourceLabel(detail.record.source)}</dd>
      <dt>{messages.admin_usage_column_outcome()}</dt><dd>{outcomeLabel(detail.record.outcome)}</dd>
      <dt>{messages.admin_usage_detail_created()}</dt><dd>{detail.record.createdAt}</dd>
      <dt>{messages.admin_usage_detail_workspace()}</dt><dd>{
        detail.record.kind === "gatekeeper-reconciliation"
          ? "—" : detail.record.workspaceId ?? "—"
      }</dd>
      <dt>{messages.admin_usage_detail_conversation()}</dt><dd>{
        detail.record.kind === "gatekeeper-reconciliation" ? "—" : detail.record.chatId ?? "—"
      }</dd>
      <dt>{messages.admin_usage_filter_gadgets()}</dt><dd>{detail.record.gadgetId ?? "—"}</dd>
      <dt>{messages.admin_usage_column_target()}</dt><dd>{detail.record.kind === "model"
        ? detail.record.deploymentModelId
        : `${detail.record.vendorId} / ${detail.record.billingMethodKey}`}</dd>
      <dt>{messages.admin_usage_filter_external_accounts()}</dt><dd>{detail.record.kind !== "model"
        ? detail.record.externalAccountId : "—"}</dd>
      <dt>{messages.admin_usage_detail_pricing()}</dt><dd>{detail.chargeSnapshot.pricing}</dd>
      <dt>{messages.admin_usage_detail_rate_version()}</dt>
      <dd>{detail.chargeSnapshot.usageRateVersion.toString()}</dd>
      <dt>{messages.admin_usage_detail_snapshot_issued()}</dt>
      <dd>{detail.chargeSnapshot.issuedAt}</dd>
      <dt>{messages.admin_usage_column_charge()}</dt>
      <dd>{detail.record.chargeSubunits?.toString() ?? "—"}</dd>
      {detail.record.kind === "model" && <>
        <dt>{messages.admin_usage_detail_model_token_status()}</dt>
        <dd>{detail.record.usageStatus}</dd>
        <dt>{messages.admin_usage_detail_model_token_categories()}</dt><dd>{detail.record.usage
          ? [
            detail.record.usage.cacheHitInputTokens,
            detail.record.usage.cacheMissInputTokens,
            detail.record.usage.outputTokens,
            detail.record.usage.reasoningTokens,
          ].map(value => value.toString()).join(" / ") : "—"}</dd>
      </>}
      {detail.chargeSnapshot.kind === "model" && <>
        <dt>{messages.admin_usage_detail_catalog_provider_model()}</dt>
        <dd>{detail.chargeSnapshot.catalogVersion} · {
          detail.chargeSnapshot.provider} / {detail.chargeSnapshot.model}</dd>
        {detail.chargeSnapshot.pricing === "priced" ? <>
          <dt>{messages.admin_usage_detail_provider_rate_tier()}</dt>
          <dd>{detail.chargeSnapshot.providerModelVersion} · {
            detail.chargeSnapshot.rateTier}</dd>
          <dt>{messages.admin_usage_detail_token_rates()}</dt><dd>{[
            detail.chargeSnapshot.tokenRates.cacheHitUsdSubunitsPerMillion,
            detail.chargeSnapshot.tokenRates.cacheMissUsdSubunitsPerMillion,
            detail.chargeSnapshot.tokenRates.outputUsdSubunitsPerMillion,
          ].map(value => value.toString()).join(" / ")}</dd>
          <dt>{messages.admin_usage_detail_deployment_multiplier()}</dt>
          <dd>{formatExactRatio(detail.chargeSnapshot.multiplier)}</dd>
          <dt>{messages.admin_usage_detail_credit_conversion()}</dt><dd>{formatExactRatio(
            detail.chargeSnapshot.creditConversion)}</dd>
        </> : <><dt>{messages.admin_usage_detail_configuration_gap()}</dt>
          <dd>{messages.admin_usage_detail_configuration_gap_present()}</dd></>}
      </>}
      {detail.chargeSnapshot.kind === "gatekeeper" && <>
        <dt>{messages.admin_usage_detail_gatekeeper_rate_target()}</dt>
        <dd>{detail.chargeSnapshot.vendorId} / {
          detail.chargeSnapshot.billingMethodKey}</dd>
        <dt>{messages.admin_usage_detail_gatekeeper_rate_charge()}</dt>
        <dd>{detail.chargeSnapshot.chargeSubunits.toString()}</dd>
        {detail.chargeSnapshot.pricing === "unpriced" && <>
          <dt>{messages.admin_usage_detail_configuration_gap()}</dt>
          <dd>{messages.admin_usage_detail_configuration_gap_present()}</dd>
        </>}
      </>}
      <dt>{messages.admin_usage_detail_reservation()}</dt><dd>{detail.reservation?.state ?? "—"}</dd>
      <dt>{messages.admin_usage_detail_reservation_amount()}</dt>
      <dd>{detail.reservation?.amountSubunits.toString() ?? "—"}</dd>
      <dt>{messages.admin_usage_detail_reservation_created()}</dt>
      <dd>{detail.reservation?.createdAt ?? "—"}</dd>
      <dt>{messages.admin_usage_detail_reservation_settled()}</dt>
      <dd>{detail.reservation?.settledAt ?? "—"}</dd>
      <dt>{messages.admin_usage_detail_reservation_released()}</dt>
      <dd>{detail.reservation?.releasedAt ?? "—"}</dd>
      <dt>{messages.admin_usage_detail_reconciliation()}</dt>
      <dd>{detail.reconciliation
        ? `${detail.reconciliation.decision} · ${detail.reconciliation.actorUserId} · ` +
          `${detail.reconciliation.reason} · ${detail.reconciliation.createdAt}`
        : "—"}</dd>
    </dl>
    <h5 className="mt-4 text-sm font-semibold text-kumo-strong">
      {messages.admin_usage_detail_ledger()}</h5>
    {detail.ledgerEntries.length === 0 ? <p className="mt-1 text-sm text-kumo-subtle">—</p>
      : <ul className="mt-1 space-y-1 text-xs text-kumo-subtle">
        {detail.ledgerEntries.map(entry => <li key={entry.id}>
          {entry.kind} · {entry.deltaSubunits.toString()} · {entry.createdAt} · {entry.id}
        </li>)}
      </ul>}
    {registeredUserRef && <AdminOperationPanel api={api} detail={detail}
      registeredUserRef={registeredUserRef} onRefresh={onRefresh} />}
    </>}
  </aside>;
}

function formatExactRatio(ratio: {numerator: bigint; denominator: bigint}): string {
  return `${ratio.numerator.toString()}/${ratio.denominator.toString()}`;
}

type AdminOperation =
  | "grant"
  | "deduct"
  | "reconcile"
  | "reverse"
  | "settle-unknown"
  | "release-unknown";

function AdminOperationPanel({api, detail, registeredUserRef, onRefresh}: {
  api: RpcStub<AdminUsageApi>;
  detail: AdminUsageRecordDetail;
  registeredUserRef: string;
  onRefresh: () => Promise<boolean>;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [ledgerRef, setLedgerRef] = useState(
    detail.ledgerEntries.find(entry => entry.kind === "usage-charge")?.id ?? "",
  );
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<"idle" | "succeeded" | "failed">("idle");
  const retryIdentity = useRef<{signature: string; operationId: string} | null>(null);
  const unknownAction = detail.record.kind === "gatekeeper" &&
    detail.record.outcome === "usage-unknown" && detail.reconciliation === null;
  const chargeReversed = detail.ledgerEntries.some(entry => entry.kind === "credit-reversal");

  const run = async (operation: AdminOperation) => {
    if (running) return;
    setRunning(true);
    setResult("idle");
    let authorityChangeRequested = false;
    try {
      const normalizedReason = reason.trim();
      if (normalizedReason.length < 1 || normalizedReason.length > 1_000) {
        throw new TypeError("A bounded reason is required.");
      }
      const signature = JSON.stringify([
        registeredUserRef,
        detail.record.id,
        operation,
        amount,
        ledgerRef,
        normalizedReason,
      ]);
      if (retryIdentity.current?.signature !== signature) {
        retryIdentity.current = {
          signature,
          operationId: `admin-report-${crypto.randomUUID()}`,
        };
      }
      const operationId = retryIdentity.current.operationId;
      if (operation === "grant" || operation === "deduct" || operation === "reconcile") {
        if (!/^-?[0-9]+$/.test(amount)) throw new TypeError("An exact integer amount is required.");
        const exact = BigInt(amount);
        if ((operation === "grant" || operation === "deduct") && exact <= 0n) {
          throw new TypeError("A positive amount is required.");
        }
        if (operation === "grant") {
          authorityChangeRequested = true;
          await api.grant({registeredUserRef, operationId, amountSubunits: exact,
            reason: normalizedReason});
        } else if (operation === "deduct") {
          authorityChangeRequested = true;
          await api.deduct({registeredUserRef, operationId, amountSubunits: exact,
            reason: normalizedReason});
        } else {
          authorityChangeRequested = true;
          await api.reconcileBalance({registeredUserRef, operationId,
            targetBalanceSubunits: exact, reason: normalizedReason});
        }
      } else if (operation === "reverse") {
        if (ledgerRef.length < 1 || ledgerRef.length > 500) {
          throw new TypeError("A bounded Ledger reference is required.");
        }
        authorityChangeRequested = true;
        await api.reverse({registeredUserRef, operationId,
          originalLedgerEntryId: ledgerRef, reason: normalizedReason});
      } else {
        if (!unknownAction) throw new TypeError("A valid unknown Usage detail is required.");
        authorityChangeRequested = true;
        await api.reconcileUnknownRecord({
          registeredUserRef,
          safeRecordRef: detail.record.id,
          operationId,
          decision: operation === "settle-unknown" ? "settle" : "release",
          reason: normalizedReason,
        });
      }
      setResult("succeeded");
    } catch {
      setResult("failed");
    } finally {
      try {
        if (authorityChangeRequested) {
          const refreshed = await onRefresh();
          if (!refreshed) setResult("failed");
        }
      } catch {
        setResult("failed");
      } finally {
        setRunning(false);
      }
    }
  };

  return <section className="mt-4 space-y-2 border-t border-kumo-line pt-4">
    <h5 className="text-sm font-semibold text-kumo-strong">
      {messages.admin_usage_operations_title()}</h5>
    <label className="block text-xs text-kumo-subtle">{
      messages.admin_usage_operations_amount()}
      <input aria-label={messages.admin_usage_operations_amount()} value={amount}
        onChange={event => setAmount(event.target.value)} inputMode="numeric"
        className="mt-1 w-full rounded-md border border-kumo-line bg-kumo-base px-2 py-1" />
    </label>
    <label className="block text-xs text-kumo-subtle">{
      messages.admin_usage_operations_reason()}
      <textarea aria-label={messages.admin_usage_operations_reason()} value={reason}
        onChange={event => setReason(event.target.value)} maxLength={1_000}
        className="mt-1 w-full rounded-md border border-kumo-line bg-kumo-base px-2 py-1" />
    </label>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={running} onClick={() => void run("grant")}>{
        messages.admin_usage_operations_grant()}</Button>
      <Button size="sm" disabled={running} onClick={() => void run("deduct")}>{
        messages.admin_usage_operations_deduct()}</Button>
      <Button size="sm" disabled={running} onClick={() => void run("reconcile")}>{
        messages.admin_usage_operations_reconcile()}</Button>
    </div>
    {!chargeReversed && detail.ledgerEntries.some(entry => entry.kind === "usage-charge") && <>
      <label className="block text-xs text-kumo-subtle">{
        messages.admin_usage_operations_ledger_ref()}
        <input aria-label={messages.admin_usage_operations_ledger_ref()} value={ledgerRef}
          onChange={event => setLedgerRef(event.target.value)} maxLength={500}
          className="mt-1 w-full rounded-md border border-kumo-line bg-kumo-base px-2 py-1" />
      </label>
      <Button size="sm" disabled={running} onClick={() => void run("reverse")}>{
        messages.admin_usage_operations_reverse()}</Button>
    </>}
    {unknownAction && <>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={running} onClick={() => void run("settle-unknown")}>{
          messages.admin_usage_operations_settle_unknown()}</Button>
        <Button size="sm" disabled={running} onClick={() => void run("release-unknown")}>{
          messages.admin_usage_operations_release_unknown()}</Button>
      </div>
    </>}
    {running && <p role="status">{messages.admin_usage_operations_running()}</p>}
    {result === "succeeded" && <p role="status">{messages.admin_usage_operations_succeeded()}</p>}
    {result === "failed" && <p role="alert">{messages.admin_usage_operations_failed()}</p>}
  </section>;
}

function reportFilterFromForm(form: FilterForm): AdminUsageReportFilter {
  const methods = commaSeparatedValues(form.methods).map(item => {
    const separator = item.indexOf("|");
    if (separator < 1 || separator === item.length - 1) {
      throw new TypeError("A method filter needs a Gatekeeper ID and a stable method key.");
    }
    return {gatekeeperId: item.slice(0, separator), stableMethodKey: item.slice(separator + 1)};
  });
  return Object.fromEntries(Object.entries({
    startDateInclusive: form.startDate || undefined,
    endDateExclusive: form.endDate || undefined,
    registeredUserRefs: commaSeparatedValues(form.users),
    gadgetIds: commaSeparatedValues(form.gadgets),
    deploymentModelIds: commaSeparatedValues(form.models),
    gatekeeperIds: commaSeparatedValues(form.gatekeepers),
    methods,
    externalAccountIds: commaSeparatedValues(form.externalAccounts),
    sources: form.source ? [form.source] : undefined,
    outcomes: form.outcome ? [form.outcome] : undefined,
    pricingStatuses: form.pricing ? [form.pricing] : undefined,
    meteredKinds: form.kind ? [form.kind] : undefined,
  }).filter(([, value]) => value !== undefined && (!Array.isArray(value) || value.length > 0))) as
    AdminUsageReportFilter;
}

function sourceLabel(source: UsageSource): string {
  return ({
    agent: messages.admin_usage_source_agent,
    gadget: messages.admin_usage_source_gadget,
    "direct-user": messages.admin_usage_source_direct_user,
    "system-assistance": messages.admin_usage_source_system_assistance,
    hook: messages.admin_usage_source_hook,
    scheduled: messages.admin_usage_source_scheduled,
  } satisfies Record<UsageSource, () => string>)[source]();
}

function outcomeLabel(outcome: AdminUsageReportOutcome): string {
  return ({
    settled: messages.admin_usage_outcome_settled,
    "failed-before-execution": messages.admin_usage_outcome_failed_before_execution,
    "usage-unknown": messages.admin_usage_outcome_usage_unknown,
    "reconciliation-required": messages.admin_usage_outcome_reconciliation_required,
    "reconciled-settled": messages.admin_usage_outcome_reconciled_settled,
    "reconciled-released": messages.admin_usage_outcome_reconciled_released,
  } satisfies Record<AdminUsageReportOutcome, () => string>)[outcome]();
}

function meteredKindLabel(kind: AdminUsageReportRow["meteredKind"]): string {
  return ({
    model: messages.admin_usage_kind_model,
    gatekeeper: messages.admin_usage_kind_gatekeeper,
    attempt: messages.admin_usage_kind_attempt,
  } satisfies Record<AdminUsageReportRow["meteredKind"], () => string>)[kind]();
}
