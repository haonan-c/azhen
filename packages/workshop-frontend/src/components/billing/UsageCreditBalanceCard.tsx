import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  PublishedApiRate,
  PublishedApiRatePage,
  UserCreditLedgerEntry,
  UserCreditLedgerPage,
  UserCreditReservation,
  UserCreditReservationPage,
  UserUsageRecord,
  UserUsageRecordPage,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { UsageCreditProvider, useOptionalUsageCredit } from '../../UsageCreditContext'
import { m as messages } from '../../paraglide/messages.js'
import { getLocale } from '../../paraglide/runtime.js'
import { formatUsageCreditSubunits } from './formatUsageCredits'

const PAGE_SIZE = 25
const BUTTON = 'rounded-md border border-kumo-line px-3 py-1.5 text-xs font-medium text-kumo-default hover:bg-kumo-tint disabled:opacity-50'

type PageState<T> = {
  items: T[]
  nextCursor: string | null
  loading: boolean
  error: boolean
  truncated: boolean
}

function emptyPage<T>(): PageState<T> {
  return { items: [], nextCursor: null, loading: true, error: false, truncated: false }
}

type AuthenticatedApiStub = ReturnType<typeof useAuthenticatedApi>['authenticatedApi']
type PageRequest = { cursor?: string; limit: number }
type LoadedPage<T> = { items: T[]; nextCursor: string | null; truncated?: boolean }
type PageLoader<T> = (api: AuthenticatedApiStub, request: PageRequest) => Promise<LoadedPage<T>>

async function loadUsageRecordPage(
  api: AuthenticatedApiStub,
  request: PageRequest,
): Promise<LoadedPage<UserUsageRecord>> {
  const page: UserUsageRecordPage = await api.listOwnUsageRecords(request)
  return {items: page.records, nextCursor: page.nextCursor}
}

async function loadReservationPage(
  api: AuthenticatedApiStub,
  request: PageRequest,
): Promise<LoadedPage<UserCreditReservation>> {
  const page: UserCreditReservationPage = await api.listOwnCreditReservations(request)
  return {items: page.reservations, nextCursor: page.nextCursor}
}

async function loadLedgerPage(
  api: AuthenticatedApiStub,
  request: PageRequest,
): Promise<LoadedPage<UserCreditLedgerEntry>> {
  const page: UserCreditLedgerPage = await api.listOwnCreditLedger(request)
  return {items: page.entries, nextCursor: page.nextCursor}
}

async function loadRatePage(
  api: AuthenticatedApiStub,
  request: PageRequest,
): Promise<LoadedPage<PublishedApiRate>> {
  const page: PublishedApiRatePage = await api.listPublishedApiRates(request)
  return {items: page.rates, nextCursor: page.nextCursor, truncated: page.truncated}
}

function useApiPage<T>(api: AuthenticatedApiStub, loadPage: PageLoader<T>) {
  const activeApi = useRef<AuthenticatedApiStub | null>(api)
  activeApi.current = api
  const [owned, setOwned] = useState<{
    api: AuthenticatedApiStub
    state: PageState<T>
  }>(() => ({api, state: emptyPage()}))
  const state = owned.api === api ? owned.state : emptyPage<T>()

  const load = useCallback(async (cursor?: string) => {
    setOwned(previous => {
      const previousState = previous.api === api ? previous.state : emptyPage<T>()
      return {api, state: {...previousState, loading: true, error: false}}
    })
    try {
      const page = await loadPage(api, {cursor, limit: PAGE_SIZE})
      if (activeApi.current !== api) return
      setOwned(previous => {
        if (previous.api !== api) return previous
        return {
          api,
          state: {
            items: cursor === undefined
              ? page.items
              : [...previous.state.items, ...page.items],
            nextCursor: page.nextCursor,
            loading: false,
            error: false,
            truncated: previous.state.truncated || page.truncated === true,
          },
        }
      })
    } catch {
      if (activeApi.current !== api) return
      setOwned(previous => previous.api === api
        ? {api, state: {...previous.state, loading: false, error: true}}
        : previous)
    }
  }, [api, loadPage])

  useEffect(() => {
    void load()
    return () => {
      if (activeApi.current === api) activeApi.current = null
    }
  }, [api, load])

  return [state, load] as const
}

function formatCount(value: bigint): string {
  return new Intl.NumberFormat(getLocale()).format(value)
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(getLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function sourceLabel(source: UserUsageRecord['source']): string {
  switch (source) {
    case 'agent': return messages.usage_credit_source_agent()
    case 'gadget': return messages.usage_credit_source_gadget()
    case 'direct-user': return messages.usage_credit_source_direct_user()
    case 'system-assistance': return messages.usage_credit_source_system()
    case 'hook': return messages.usage_credit_source_hook()
    case 'scheduled': return messages.usage_credit_source_scheduled()
  }
}

function outcomeLabel(outcome: UserUsageRecord['outcome']): string {
  switch (outcome) {
    case 'settled': return messages.usage_credit_outcome_settled()
    case 'failed-before-execution': return messages.usage_credit_outcome_failed_before_execution()
    case 'usage-unknown': return messages.usage_credit_outcome_unknown()
    case 'reconciliation-required': return messages.usage_credit_outcome_reconciliation()
  }
}

function reservationStateLabel(state: UserCreditReservation['state']): string {
  switch (state) {
    case 'active': return messages.usage_credit_reservation_active()
    case 'started': return messages.usage_credit_reservation_started()
    case 'unknown-held': return messages.usage_credit_reservation_unknown()
    case 'reconciliation-required': return messages.usage_credit_reservation_reconciliation()
    case 'settled': return messages.usage_credit_reservation_settled()
    case 'released': return messages.usage_credit_reservation_released()
  }
}

function ledgerKindLabel(kind: UserCreditLedgerEntry['kind']): string {
  switch (kind) {
    case 'initial-grant': return messages.usage_credit_ledger_initial_grant()
    case 'usage-charge': return messages.usage_credit_ledger_usage_charge()
    case 'admin-grant': return messages.usage_credit_ledger_admin_grant()
    case 'admin-deduction': return messages.usage_credit_ledger_admin_deduction()
    case 'admin-reconciliation': return messages.usage_credit_ledger_admin_reconciliation()
    case 'credit-reversal': return messages.usage_credit_ledger_reversal()
  }
}

function chargeLabel(record: Pick<UserUsageRecord, 'pricing' | 'chargeSubunits'>): string {
  if (record.pricing === 'unpriced') return messages.usage_credit_unpriced()
  if (record.chargeSubunits === null) return messages.usage_credit_charge_pending()
  return messages.usage_credit_charge({ amount: formatUsageCreditSubunits(record.chargeSubunits) })
}

function PageStatus({ state, empty, retry, more }: {
  state: PageState<unknown>
  empty: string
  retry: () => void
  more: () => void
}) {
  if (state.loading && state.items.length === 0) {
    return <p role="status" className="text-sm text-kumo-subtle">{messages.usage_credit_loading_section()}</p>
  }
  if (state.error && state.items.length === 0) {
    return (
      <div role="alert" className="flex items-center gap-3 text-sm text-kumo-danger">
        <span>{messages.usage_credit_section_error()}</span>
        <button type="button" className={BUTTON} onClick={retry}>{messages.common_retry()}</button>
      </div>
    )
  }
  if (state.items.length === 0) return <p className="text-sm text-kumo-subtle">{empty}</p>
  if (state.error) {
    return (
      <div role="alert" className="mt-3 flex items-center gap-3 text-sm text-kumo-danger">
        <span>{messages.usage_credit_more_error()}</span>
        <button type="button" className={BUTTON} onClick={more}>{messages.common_retry()}</button>
      </div>
    )
  }
  if (state.nextCursor === null) return null
  return (
    <button
      type="button"
      className={`${BUTTON} mt-3`}
      onClick={more}
      disabled={state.loading}
      aria-busy={state.loading}
    >
      {state.loading ? messages.usage_credit_loading_more() : messages.usage_credit_load_more()}
    </button>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-kumo-line bg-kumo-base p-5">
      <h3 className="mb-3 text-sm font-semibold text-kumo-default">{title}</h3>
      {children}
    </section>
  )
}

function LedgerRelation({
  relation,
  label,
  loaded,
}: {
  relation: NonNullable<UserCreditLedgerEntry['reversalOfLedgerEntry']>
  label: string
  loaded: boolean
}) {
  if (loaded) {
    return <a className="mt-1 block text-xs text-kumo-link hover:underline" href={`#ledger-${relation.id}`}>{label}</a>
  }
  return (
    <details className="mt-1 text-xs text-kumo-subtle">
      <summary className="cursor-pointer text-kumo-link hover:underline">{label}</summary>
      <p className="mt-1 pl-3">
        {ledgerKindLabel(relation.kind)} · {formatUsageCreditSubunits(relation.deltaSubunits)} ·{' '}
        <time dateTime={relation.createdAt}>{formatTime(relation.createdAt)}</time>
      </p>
    </details>
  )
}

function UsageCreditContent() {
  const { authenticatedApi } = useAuthenticatedApi()
  const usage = useOptionalUsageCredit()!
  const [usageRecords, loadUsageRecords] = useApiPage(authenticatedApi, loadUsageRecordPage)
  const [reservations, loadReservations] = useApiPage(authenticatedApi, loadReservationPage)
  const [ledger, loadLedger] = useApiPage(authenticatedApi, loadLedgerPage)
  const [rates, loadRates] = useApiPage(authenticatedApi, loadRatePage)
  const [acknowledging, setAcknowledging] = useState(false)
  const [ackError, setAckError] = useState(false)
  const acknowledgementApi = useRef<AuthenticatedApiStub | null>(authenticatedApi)
  acknowledgementApi.current = authenticatedApi

  useEffect(() => {
    setAcknowledging(false)
    setAckError(false)
    return () => {
      if (acknowledgementApi.current === authenticatedApi) acknowledgementApi.current = null
    }
  }, [authenticatedApi])

  const balance = usage.balance
  const modelRecords = usageRecords.items.filter(record => record.kind === 'model')
  const apiRecords = usageRecords.items.filter(record => record.kind === 'gatekeeper')
  let executedApiCount = 0n
  let failedApiCount = 0n
  let unknownApiCount = 0n
  for (const record of apiRecords) {
    if (record.outcome === 'settled') executedApiCount += 1n
    else if (record.outcome === 'failed-before-execution') failedApiCount += 1n
    else unknownApiCount += 1n
  }
  const sourceCounts = new Map<UserUsageRecord['source'], bigint>()
  for (const record of usageRecords.items) {
    sourceCounts.set(record.source, (sourceCounts.get(record.source) ?? 0n) + 1n)
  }

  async function acknowledgeNotice() {
    if (balance?.activationNotice === null || balance?.activationNotice === undefined) return
    const ownerApi = authenticatedApi
    setAcknowledging(true)
    setAckError(false)
    try {
      await usage.acknowledgeActivationNotice(balance.activationNotice.id)
    } catch {
      if (acknowledgementApi.current !== ownerApi) return
      setAckError(true)
    } finally {
      if (acknowledgementApi.current === ownerApi) setAcknowledging(false)
    }
  }

  return (
    <section id="usage" className="flex scroll-mt-4 flex-col gap-3">
      <div className="px-1">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
          {messages.usage_credit_heading()}
        </h2>
        <p className="mt-1 text-sm text-kumo-subtle">{messages.usage_credit_description()}</p>
      </div>

      {balance?.activationNotice && (
        <div className="rounded-xl border border-kumo-brand/30 bg-kumo-brand/5 p-4" role="status">
          <p className="text-sm text-kumo-default">{messages.usage_credit_activation_notice({ amount: formatUsageCreditSubunits(balance.activationNotice.grantedSubunits) })}</p>
          <button type="button" className={`${BUTTON} mt-3`} onClick={() => void acknowledgeNotice()} disabled={acknowledging}>
            {messages.common_dismiss()}
          </button>
          {ackError && <p role="alert" className="mt-2 text-sm text-kumo-danger">{messages.usage_credit_ack_error()}</p>}
        </div>
      )}

      <Section title={messages.usage_credit_balance_heading()}>
        {usage.loading && balance === null ? (
          <p role="status" className="text-sm text-kumo-subtle">{messages.usage_credit_loading()}</p>
        ) : balance === null ? (
          <p role="alert" className="text-sm text-kumo-danger">{messages.usage_credit_load_error()}</p>
        ) : (
          <div aria-live="polite" className="grid gap-3 text-sm text-kumo-default sm:grid-cols-3">
            <p>{messages.usage_credit_available({ amount: formatUsageCreditSubunits(balance.availableSubunits) })}</p>
            <p>{messages.usage_credit_reserved({ amount: formatUsageCreditSubunits(balance.reservedSubunits) })}</p>
            <p>{messages.usage_credit_low_threshold({ amount: formatUsageCreditSubunits(balance.lowBalanceThresholdSubunits) })}</p>
          </div>
        )}
        {usage.stale && <p role="alert" className="mt-3 text-sm text-kumo-warning">{messages.usage_credit_balance_stale()}</p>}
      </Section>

      <Section title={messages.usage_credit_sources_heading()}>
        {usageRecords.items.length > 0 && (
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(['agent', 'gadget', 'direct-user', 'system-assistance', 'hook', 'scheduled'] as const).map(source => (
              <div key={source} className="rounded-lg bg-kumo-tint px-3 py-2">
                <dt className="text-xs text-kumo-subtle">{sourceLabel(source)}</dt>
                <dd className="mt-1 text-sm font-medium text-kumo-default">{formatCount(sourceCounts.get(source) ?? 0n)}</dd>
              </div>
            ))}
          </dl>
        )}
        {usageRecords.items.length > 0 && (
          <p className="mt-2 text-xs text-kumo-subtle">{messages.usage_credit_sources_loaded_note()}</p>
        )}
        <PageStatus state={usageRecords} empty={messages.usage_credit_usage_empty()} retry={() => void loadUsageRecords()} more={() => void loadUsageRecords(usageRecords.nextCursor ?? undefined)} />
      </Section>

      <Section title={messages.usage_credit_model_heading()}>
        {modelRecords.length > 0 && (
          <ul className="divide-y divide-kumo-line">
            {modelRecords.map(record => (
              <li key={record.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-medium text-kumo-default">{record.deploymentModelId}</span>
                  <time className="text-xs text-kumo-subtle" dateTime={record.createdAt}>{formatTime(record.createdAt)}</time>
                </div>
                <p className="mt-1 text-xs text-kumo-subtle">{sourceLabel(record.source)} · {outcomeLabel(record.outcome)} · {chargeLabel(record)}</p>
                {record.usage !== null
                  ? <p className="mt-1 text-xs text-kumo-subtle">{messages.usage_credit_tokens({ cacheHit: formatCount(record.usage.cacheHitInputTokens), cacheMiss: formatCount(record.usage.cacheMissInputTokens), output: formatCount(record.usage.outputTokens), reasoning: formatCount(record.usage.reasoningTokens) })}</p>
                  : <p className="mt-1 text-xs text-kumo-subtle">{record.usageStatus === 'invalid-report' ? messages.usage_credit_tokens_invalid() : messages.usage_credit_tokens_not_reported()}</p>}
              </li>
            ))}
          </ul>
        )}
        {!usageRecords.loading && !usageRecords.error && modelRecords.length === 0 && <p className="text-sm text-kumo-subtle">{messages.usage_credit_model_empty()}</p>}
        {usageRecords.error && usageRecords.items.length === 0 && <p role="alert" className="text-sm text-kumo-danger">{messages.usage_credit_section_error()}</p>}
      </Section>

      <Section title={messages.usage_credit_api_heading()}>
        {apiRecords.length > 0 && (
          <>
            <dl className="mb-3 grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-kumo-tint px-3 py-2">
                <dt className="text-xs text-kumo-subtle">{messages.usage_credit_api_executed_loaded()}</dt>
                {' '}
                <dd className="mt-1 text-sm font-medium text-kumo-default">{formatCount(executedApiCount)}</dd>
              </div>
              <div className="rounded-lg bg-kumo-tint px-3 py-2">
                <dt className="text-xs text-kumo-subtle">{messages.usage_credit_api_failed_loaded()}</dt>
                {' '}
                <dd className="mt-1 text-sm font-medium text-kumo-default">{formatCount(failedApiCount)}</dd>
              </div>
              <div className="rounded-lg bg-kumo-tint px-3 py-2">
                <dt className="text-xs text-kumo-subtle">{messages.usage_credit_api_unknown_loaded()}</dt>
                {' '}
                <dd className="mt-1 text-sm font-medium text-kumo-default">{formatCount(unknownApiCount)}</dd>
              </div>
            </dl>
            <ul className="divide-y divide-kumo-line">
              {apiRecords.map(record => (
                <li key={record.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="font-medium text-kumo-default">{record.vendorId} · {record.billingMethodKey}</span>
                    <time className="text-xs text-kumo-subtle" dateTime={record.createdAt}>{formatTime(record.createdAt)}</time>
                  </div>
                  <p className="mt-1 text-xs text-kumo-subtle">{sourceLabel(record.source)} · {outcomeLabel(record.outcome)} · {chargeLabel(record)}</p>
                </li>
              ))}
            </ul>
          </>
        )}
        {!usageRecords.loading && !usageRecords.error && apiRecords.length === 0 && <p className="text-sm text-kumo-subtle">{messages.usage_credit_api_empty()}</p>}
        {usageRecords.error && usageRecords.items.length === 0 && <p role="alert" className="text-sm text-kumo-danger">{messages.usage_credit_section_error()}</p>}
      </Section>

      <Section title={messages.usage_credit_reservations_heading()}>
        {reservations.items.length > 0 && <ul className="divide-y divide-kumo-line">{reservations.items.map(reservation => (
          <li key={reservation.id} className="flex flex-wrap justify-between gap-2 py-3 text-sm first:pt-0 last:pb-0">
            <span className="text-kumo-default">{messages.usage_credit_reservation({ state: reservationStateLabel(reservation.state), amount: formatUsageCreditSubunits(reservation.amountSubunits) })}</span>
            <time className="text-xs text-kumo-subtle" dateTime={reservation.createdAt}>{formatTime(reservation.createdAt)}</time>
          </li>
        ))}</ul>}
        <PageStatus state={reservations} empty={messages.usage_credit_reservations_empty()} retry={() => void loadReservations()} more={() => void loadReservations(reservations.nextCursor ?? undefined)} />
      </Section>

      <Section title={messages.usage_credit_ledger_heading()}>
        {ledger.items.length > 0 && <ul className="divide-y divide-kumo-line">{ledger.items.map(entry => (
          <li id={`ledger-${entry.id}`} key={entry.id} className="py-3 text-sm first:pt-0 last:pb-0">
            <div className="flex flex-wrap justify-between gap-2">
              <span className="text-kumo-default">{ledgerKindLabel(entry.kind)} · {formatUsageCreditSubunits(entry.deltaSubunits)}</span>
              <time className="text-xs text-kumo-subtle" dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time>
            </div>
            {entry.reversalOfLedgerEntry !== null && <LedgerRelation
              relation={entry.reversalOfLedgerEntry}
              label={messages.usage_credit_reversal_of({id: entry.reversalOfLedgerEntry.id})}
              loaded={ledger.items.some(candidate => candidate.id === entry.reversalOfLedgerEntry?.id)}
            />}
            {entry.reversedByLedgerEntry !== null && <LedgerRelation
              relation={entry.reversedByLedgerEntry}
              label={messages.usage_credit_reversed_by({id: entry.reversedByLedgerEntry.id})}
              loaded={ledger.items.some(candidate => candidate.id === entry.reversedByLedgerEntry?.id)}
            />}
          </li>
        ))}</ul>}
        <PageStatus state={ledger} empty={messages.usage_credit_ledger_empty()} retry={() => void loadLedger()} more={() => void loadLedger(ledger.nextCursor ?? undefined)} />
      </Section>

      <Section title={messages.usage_credit_rates_heading()}>
        {rates.items.length > 0 && (
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{messages.usage_credit_rates_caption()}</caption>
            <thead className="text-xs text-kumo-subtle"><tr><th scope="col" className="pb-2">{messages.usage_credit_rate_method()}</th><th scope="col" className="pb-2">{messages.usage_credit_rate()}</th></tr></thead>
            <tbody className="divide-y divide-kumo-line">{rates.items.map(rate => (
              <tr key={`${rate.vendorId}\0${rate.billingMethodKey}`}>
                <td className="py-2 text-kumo-default">{rate.vendorId} · {rate.billingMethodKey}</td>
                <td className={`py-2 ${rate.pricing === 'unpriced' ? 'font-medium text-kumo-warning' : 'text-kumo-default'}`}>
                  {rate.pricing === 'unpriced' ? messages.usage_credit_unpriced() : messages.usage_credit_rate_amount({ amount: formatUsageCreditSubunits(rate.amountSubunits!) })}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
        <PageStatus state={rates} empty={messages.usage_credit_rates_empty()} retry={() => void loadRates()} more={() => void loadRates(rates.nextCursor ?? undefined)} />
        {rates.truncated && <p role="status" className="mt-3 text-xs text-kumo-warning">{messages.usage_credit_rates_truncated()}</p>}
      </Section>
    </section>
  )
}

/** Shows the authenticated User's complete authoritative Usage Credit view. */
export default function UsageCreditBalanceCard() {
  const usage = useOptionalUsageCredit()
  if (usage === null) return <UsageCreditProvider><UsageCreditContent /></UsageCreditProvider>
  return <UsageCreditContent />
}
