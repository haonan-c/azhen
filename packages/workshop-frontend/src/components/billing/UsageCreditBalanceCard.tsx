import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  PublishedApiRate,
  UserCreditLedgerEntry,
  UserCreditReservation,
  UserUsageRecord,
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
}

function emptyPage<T>(): PageState<T> {
  return { items: [], nextCursor: null, loading: true, error: false }
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

function UsageCreditContent() {
  const { authenticatedApi } = useAuthenticatedApi()
  const usage = useOptionalUsageCredit()!
  const [usageRecords, setUsageRecords] = useState<PageState<UserUsageRecord>>(emptyPage)
  const [reservations, setReservations] = useState<PageState<UserCreditReservation>>(emptyPage)
  const [ledger, setLedger] = useState<PageState<UserCreditLedgerEntry>>(emptyPage)
  const [rates, setRates] = useState<PageState<PublishedApiRate>>(emptyPage)
  const [acknowledging, setAcknowledging] = useState(false)
  const [ackError, setAckError] = useState(false)
  const activeApi = useRef<typeof authenticatedApi | null>(authenticatedApi)

  const loadUsageRecords = useCallback(async (cursor?: string) => {
    setUsageRecords(previous => ({ ...previous, loading: true, error: false }))
    try {
      const page = await authenticatedApi.listOwnUsageRecords({ cursor, limit: PAGE_SIZE })
      if (activeApi.current !== authenticatedApi) return
      setUsageRecords(previous => ({
        items: cursor === undefined ? page.records : [...previous.items, ...page.records],
        nextCursor: page.nextCursor,
        loading: false,
        error: false,
      }))
    } catch {
      if (activeApi.current !== authenticatedApi) return
      setUsageRecords(previous => ({ ...previous, loading: false, error: true }))
    }
  }, [authenticatedApi])

  const loadReservations = useCallback(async (cursor?: string) => {
    setReservations(previous => ({ ...previous, loading: true, error: false }))
    try {
      const page = await authenticatedApi.listOwnCreditReservations({ cursor, limit: PAGE_SIZE })
      if (activeApi.current !== authenticatedApi) return
      setReservations(previous => ({
        items: cursor === undefined ? page.reservations : [...previous.items, ...page.reservations],
        nextCursor: page.nextCursor,
        loading: false,
        error: false,
      }))
    } catch {
      if (activeApi.current !== authenticatedApi) return
      setReservations(previous => ({ ...previous, loading: false, error: true }))
    }
  }, [authenticatedApi])

  const loadLedger = useCallback(async (cursor?: string) => {
    setLedger(previous => ({ ...previous, loading: true, error: false }))
    try {
      const page = await authenticatedApi.listOwnCreditLedger({ cursor, limit: PAGE_SIZE })
      if (activeApi.current !== authenticatedApi) return
      setLedger(previous => ({
        items: cursor === undefined ? page.entries : [...previous.items, ...page.entries],
        nextCursor: page.nextCursor,
        loading: false,
        error: false,
      }))
    } catch {
      if (activeApi.current !== authenticatedApi) return
      setLedger(previous => ({ ...previous, loading: false, error: true }))
    }
  }, [authenticatedApi])

  const loadRates = useCallback(async (cursor?: string) => {
    setRates(previous => ({ ...previous, loading: true, error: false }))
    try {
      const page = await authenticatedApi.listPublishedApiRates({ cursor, limit: PAGE_SIZE })
      if (activeApi.current !== authenticatedApi) return
      setRates(previous => ({
        items: cursor === undefined ? page.rates : [...previous.items, ...page.rates],
        nextCursor: page.nextCursor,
        loading: false,
        error: false,
      }))
    } catch {
      if (activeApi.current !== authenticatedApi) return
      setRates(previous => ({ ...previous, loading: false, error: true }))
    }
  }, [authenticatedApi])

  useEffect(() => {
    activeApi.current = authenticatedApi
    setUsageRecords(emptyPage())
    setReservations(emptyPage())
    setLedger(emptyPage())
    setRates(emptyPage())
    void loadUsageRecords()
    void loadReservations()
    void loadLedger()
    void loadRates()
    return () => {
      if (activeApi.current === authenticatedApi) activeApi.current = null
    }
  }, [authenticatedApi, loadLedger, loadRates, loadReservations, loadUsageRecords])

  const balance = usage.balance
  const modelRecords = usageRecords.items.filter(record => record.kind === 'model')
  const apiRecords = usageRecords.items.filter(record => record.kind === 'gatekeeper')
  const sourceCounts = new Map<UserUsageRecord['source'], bigint>()
  for (const record of usageRecords.items) {
    sourceCounts.set(record.source, (sourceCounts.get(record.source) ?? 0n) + 1n)
  }

  async function acknowledgeNotice() {
    if (balance?.activationNotice === null || balance?.activationNotice === undefined) return
    setAcknowledging(true)
    setAckError(false)
    try {
      await usage.acknowledgeActivationNotice(balance.activationNotice.id)
    } catch {
      setAckError(true)
    } finally {
      setAcknowledging(false)
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
            {entry.reversalOfLedgerEntryId !== null && <a className="mt-1 block text-xs text-kumo-link hover:underline" href={`#ledger-${entry.reversalOfLedgerEntryId}`}>{messages.usage_credit_reversal_of({ id: entry.reversalOfLedgerEntryId })}</a>}
            {entry.reversedByLedgerEntryId !== null && <a className="mt-1 block text-xs text-kumo-link hover:underline" href={`#ledger-${entry.reversedByLedgerEntryId}`}>{messages.usage_credit_reversed_by({ id: entry.reversedByLedgerEntryId })}</a>}
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
