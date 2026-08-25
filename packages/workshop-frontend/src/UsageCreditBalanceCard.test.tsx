// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useLayoutEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  USAGE_CREDIT_SUBUNITS_PER_CREDIT,
  type PublishedApiRatePage,
  type UsageCreditBalance,
  type UsageCreditBalanceSubscriber,
  type UserCreditLedgerPage,
  type UserCreditReservationPage,
  type UserUsageRecordPage,
} from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'

const testState = vi.hoisted(() => {
  const scale = 1_000_000_000_000_000_000n
  const initialBalance = (): UsageCreditBalance => ({
    availableSubunits: 987n * scale + scale / 2n,
    reservedSubunits: 12n * scale + scale / 2n,
    revision: 1n,
    lowBalance: false,
    lowBalanceThresholdSubunits: 100n * scale,
    activationNotice: null,
  })
  const state = {
    balance: initialBalance(),
    subscriber: null as RpcStub<UsageCreditBalanceSubscriber> | null,
    subscriptionDispose: vi.fn<() => void>(),
    acknowledge: vi.fn<(noticeId: string) => Promise<UsageCreditBalance>>(),
    records: vi.fn<(_request?: unknown) => Promise<UserUsageRecordPage>>(
      async () => ({ records: [], nextCursor: null }),
    ),
    reservations: vi.fn<(_request?: unknown) => Promise<UserCreditReservationPage>>(
      async () => ({ reservations: [], nextCursor: null }),
    ),
    ledger: vi.fn<(_request?: unknown) => Promise<UserCreditLedgerPage>>(
      async () => ({ entries: [], nextCursor: null }),
    ),
    rates: vi.fn<(_request?: unknown) => Promise<PublishedApiRatePage>>(
      async () => ({ rates: [], nextCursor: null, truncated: false }),
    ),
  }
  function rpcPromise<T>(value: T) {
    return Object.assign(Promise.resolve(value), { [Symbol.dispose]: vi.fn<() => void>() })
  }
  const authenticatedApi = Object.assign(vi.fn<() => void>(), {
    subscribeUsageCreditBalance: vi.fn<(
      subscriber: RpcStub<UsageCreditBalanceSubscriber>,
    ) => ReturnType<typeof rpcPromise<{ [Symbol.dispose](): void }>>>((subscriber) => {
      state.subscriber = subscriber
      void subscriber.update(state.balance)
      return rpcPromise({ [Symbol.dispose]: state.subscriptionDispose })
    }),
    acknowledgeUsageActivationNotice: state.acknowledge,
    listOwnUsageRecords: state.records,
    listOwnCreditReservations: state.reservations,
    listOwnCreditLedger: state.ledger,
    listPublishedApiRates: state.rates,
  })
  return Object.assign(state, { authenticatedApi, currentApi: authenticatedApi, initialBalance })
})

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.currentApi }),
}))

import UsageCreditBalanceCard from './components/billing/UsageCreditBalanceCard'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('complete User Usage Credit view', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.history.replaceState({}, '', '/')
    testState.balance = testState.initialBalance()
    testState.subscriber = null
    testState.records.mockResolvedValue({ records: [], nextCursor: null })
    testState.reservations.mockResolvedValue({ reservations: [], nextCursor: null })
    testState.ledger.mockResolvedValue({ entries: [], nextCursor: null })
    testState.rates.mockResolvedValue({ rates: [], nextCursor: null, truncated: false })
    testState.acknowledge.mockReset()
    testState.currentApi = testState.authenticatedApi
    vi.clearAllMocks()
    root = undefined
    container = undefined
  })

  async function render(node: ReactNode, path = '/profile') {
    window.history.replaceState({}, '', path)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(node))
  }

  it.each([
    ['/profile', 'Usage credits', 'Available: 987.5', 'Reserved: 12.5', 'Model use', 'API operations'],
    ['/zh/profile', '使用额度', '可用：987.5', '预留：12.5', '模型用量', 'API 操作'],
  ])('localizes the exact complete view at %s', async (path, heading, available, reserved, model, api) => {
    await render(<UsageCreditBalanceCard />, path)

    await vi.waitFor(() => expect(container?.textContent).toContain(available))
    expect(container?.querySelector('#usage')).not.toBeNull()
    expect(container?.textContent).toContain(heading)
    expect(container?.textContent).toContain(reserved)
    expect(container?.textContent).toContain(model)
    expect(container?.textContent).toContain(api)
    expect(container?.textContent).toContain(path.startsWith('/zh') ? '尚无计量模型用量' : 'No metered model use')
  })

  it('shows exact live model/API/source/ledger/rate data and keeps priced-zero distinct from Unpriced', async () => {
    testState.records.mockResolvedValue({
      records: [{
        kind: 'model' as const,
        id: 'model-1',
        source: 'agent' as const,
        workspaceId: 'workspace-safe',
        deploymentModelId: 'deepseek-safe',
        pricing: 'priced' as const,
        outcome: 'settled' as const,
        usageStatus: 'reported' as const,
        usage: {
          cacheHitInputTokens: 9_007_199_254_740_993n,
          cacheMissInputTokens: 2n,
          outputTokens: 3n,
          reasoningTokens: 1n,
        },
        chargeSubunits: 1n,
        createdAt: '2026-08-24T12:00:00.000Z',
      }, {
        kind: 'gatekeeper' as const,
        id: 'api-1',
        source: 'gadget' as const,
        workspaceId: 'workspace-safe',
        vendorId: 'github',
        billingMethodKey: 'issues.list',
        pricing: 'unpriced' as const,
        outcome: 'settled' as const,
        chargeSubunits: 0n,
        createdAt: '2026-08-24T12:01:00.000Z',
      }],
      nextCursor: null,
    })
    testState.ledger.mockResolvedValue({
      entries: [{
        id: 'reversal-safe',
        kind: 'credit-reversal' as const,
        deltaSubunits: USAGE_CREDIT_SUBUNITS_PER_CREDIT,
        reversalOfLedgerEntry: {
          id: 'charge-safe',
          kind: 'usage-charge' as const,
          deltaSubunits: -USAGE_CREDIT_SUBUNITS_PER_CREDIT,
          createdAt: '2026-08-24T12:01:00.000Z',
        },
        reversedByLedgerEntry: null,
        createdAt: '2026-08-24T12:02:00.000Z',
      }, {
        id: 'charge-safe',
        kind: 'usage-charge' as const,
        deltaSubunits: -USAGE_CREDIT_SUBUNITS_PER_CREDIT,
        reversalOfLedgerEntry: null,
        reversedByLedgerEntry: {
          id: 'reversal-safe',
          kind: 'credit-reversal' as const,
          deltaSubunits: USAGE_CREDIT_SUBUNITS_PER_CREDIT,
          createdAt: '2026-08-24T12:02:00.000Z',
        },
        createdAt: '2026-08-24T12:01:00.000Z',
      }],
      nextCursor: null,
    })
    testState.rates.mockResolvedValue({
      rates: [{ vendorId: 'github', billingMethodKey: 'issues.list', pricing: 'unpriced' as const, amountSubunits: null },
        { vendorId: 'github', billingMethodKey: 'issues.create', pricing: 'priced' as const, amountSubunits: 0n }],
      nextCursor: null,
      truncated: false,
    })

    await render(<UsageCreditBalanceCard />)

    await vi.waitFor(() => expect(container?.textContent).toContain('deepseek-safe'))
    expect(container?.textContent).toContain('Agent conversations')
    expect(container?.textContent).toContain('App runs')
    expect(container?.textContent).toContain('9,007,199,254,740,993')
    expect(container?.textContent).toContain('Charge: 0.000000000000000001')
    expect(container?.textContent).toContain('github · issues.list')
    expect(container?.textContent).toContain('Unpriced')
    expect(container?.textContent).toContain('github · issues.create')
    expect(container?.textContent).toContain('0 credits / operation')
    expect(container?.querySelector('a[href="#ledger-charge-safe"]')).not.toBeNull()
    expect(container?.textContent).not.toContain('provider cost')
    expect(container?.textContent).not.toContain('multiplier')
    expect(container?.textContent).not.toContain('admin reason')
    expect(container?.textContent).not.toContain('Cloudflare account')
  })

  it('updates the balance from an ordered push without reloading the page', async () => {
    await render(<UsageCreditBalanceCard />)
    await vi.waitFor(() => expect(container?.textContent).toContain('Available: 987.5'))

    await act(async () => {
      await testState.subscriber!.update({
        ...testState.balance,
        availableSubunits: 7n,
        reservedSubunits: 5n,
        revision: 2n,
        lowBalance: true,
      })
    })

    expect(container?.textContent).toContain('Available: 0.000000000000000007')
    expect(container?.textContent).toContain('Reserved: 0.000000000000000005')
  })

  it('keeps a legacy activation notice visible when acknowledgement fails', async () => {
    testState.balance = {
      ...testState.balance,
      activationNotice: {
        id: 'notice-safe',
        grantedSubunits: 1_234n * USAGE_CREDIT_SUBUNITS_PER_CREDIT,
        activatedAt: '2026-08-24T12:00:00.000Z',
      },
    }
    testState.acknowledge.mockRejectedValue(new Error('SENSITIVE BACKEND DETAIL'))
    await render(<UsageCreditBalanceCard />)
    await vi.waitFor(() => expect(container?.textContent).toContain('actual initial grant was 1,234'))

    const dismiss = [...container!.querySelectorAll('button')].find(button => button.textContent === 'Dismiss')!
    await act(async () => dismiss.click())

    expect(testState.acknowledge).toHaveBeenCalledWith('notice-safe')
    expect(container?.textContent).toContain('actual initial grant was 1,234')
    expect(container?.textContent).toContain('Could not dismiss this notice')
    expect(container?.textContent).not.toContain('SENSITIVE BACKEND DETAIL')
  })

  it('uses bounded cursors and preserves loaded rows when the next page fails', async () => {
    testState.rates
      .mockResolvedValueOnce({
        rates: [{ vendorId: 'github', billingMethodKey: 'issues.list', pricing: 'priced' as const, amountSubunits: 1n }],
        nextCursor: 'safe-cursor',
        truncated: true,
      })
      .mockRejectedValueOnce(new Error('SENSITIVE CURSOR ERROR'))
    await render(<UsageCreditBalanceCard />)
    await vi.waitFor(() => expect(container?.textContent).toContain('github · issues.list'))

    const more = [...container!.querySelectorAll('button')].find(button => button.textContent === 'Load more')!
    await act(async () => more.click())

    expect(testState.rates).toHaveBeenLastCalledWith({ cursor: 'safe-cursor', limit: 25 })
    expect(container?.textContent).toContain('github · issues.list')
    expect(container?.textContent).toContain('Could not load the next page')
    expect(container?.textContent).toContain('safe inventory limit was reached')
    expect(container?.textContent).not.toContain('SENSITIVE CURSOR ERROR')
  })

  it('never renders the previous User financial pages while the authenticated API switches', async () => {
    testState.records.mockResolvedValue({
      records: [{
        kind: 'gatekeeper' as const,
        id: 'old-user-record',
        source: 'direct-user' as const,
        vendorId: 'old-user-private-vendor',
        billingMethodKey: 'old-user-private-method',
        pricing: 'unpriced' as const,
        outcome: 'settled' as const,
        chargeSubunits: 0n,
        createdAt: '2026-08-24T12:00:00.000Z',
      }],
      nextCursor: null,
    })
    let resolveNextRecords!: (page: UserUsageRecordPage) => void
    const nextRecords = new Promise<UserUsageRecordPage>(resolve => { resolveNextRecords = resolve })
    const nextApi = Object.assign(vi.fn<() => void>(), {
      subscribeUsageCreditBalance: testState.authenticatedApi.subscribeUsageCreditBalance,
      acknowledgeUsageActivationNotice: testState.authenticatedApi.acknowledgeUsageActivationNotice,
      listOwnUsageRecords: vi.fn<(_request?: unknown) => Promise<UserUsageRecordPage>>(
        () => nextRecords,
      ),
      listOwnCreditReservations: testState.authenticatedApi.listOwnCreditReservations,
      listOwnCreditLedger: testState.authenticatedApi.listOwnCreditLedger,
      listPublishedApiRates: testState.authenticatedApi.listPublishedApiRates,
    })
    let switching = false
    let exposedOldUserDuringCommit = false
    function ApiSwitchCanary() {
      useLayoutEffect(() => {
        if (switching && container?.textContent?.includes('old-user-private-vendor')) {
          exposedOldUserDuringCommit = true
        }
      })
      return <UsageCreditBalanceCard />
    }

    await render(<ApiSwitchCanary />)
    await vi.waitFor(() => expect(container?.textContent).toContain('old-user-private-vendor'))
    switching = true
    testState.currentApi = nextApi
    await act(async () => root!.render(<ApiSwitchCanary />))

    expect(exposedOldUserDuringCommit).toBe(false)
    expect(container?.textContent).not.toContain('old-user-private-vendor')
    await act(async () => resolveNextRecords({records: [], nextCursor: null}))
  })

  it('shows loaded API operation outcome counts without mixing model records', async () => {
    const base = {
      kind: 'gatekeeper' as const,
      source: 'agent' as const,
      vendorId: 'github',
      billingMethodKey: 'issues.list',
      pricing: 'unpriced' as const,
      chargeSubunits: 0n,
      createdAt: '2026-08-24T12:00:00.000Z',
    }
    testState.records.mockResolvedValue({
      records: [
        {...base, id: 'executed', outcome: 'settled' as const},
        {...base, id: 'failed', outcome: 'failed-before-execution' as const},
        {...base, id: 'unknown', outcome: 'usage-unknown' as const},
        {
          kind: 'model' as const,
          id: 'model-not-api',
          source: 'agent' as const,
          workspaceId: 'workspace-safe',
          deploymentModelId: 'model-safe',
          pricing: 'unpriced' as const,
          outcome: 'reconciliation-required' as const,
          usageStatus: 'invalid-report' as const,
          usage: null,
          chargeSubunits: 0n,
          createdAt: '2026-08-24T12:00:00.000Z',
        },
      ],
      nextCursor: null,
    })

    await render(<UsageCreditBalanceCard />)
    await vi.waitFor(() => expect(container?.textContent).toContain('Executed / accepted (loaded): 1'))
    expect(container?.textContent).toContain('Failed before execution (loaded): 1')
    expect(container?.textContent).toContain('Unknown / needs reconciliation (loaded): 1')
  })

  it('shows a safe linked Ledger summary when the related entry is on another page', async () => {
    testState.ledger.mockResolvedValue({
      entries: [{
        id: 'reversal-visible',
        kind: 'credit-reversal' as const,
        deltaSubunits: USAGE_CREDIT_SUBUNITS_PER_CREDIT,
        reversalOfLedgerEntry: {
          id: 'charge-on-previous-page',
          kind: 'usage-charge' as const,
          deltaSubunits: -USAGE_CREDIT_SUBUNITS_PER_CREDIT,
          createdAt: '2026-08-20T12:00:00.000Z',
        },
        reversedByLedgerEntry: null,
        createdAt: '2026-08-24T12:02:00.000Z',
      }],
      nextCursor: 'next-ledger-page',
    })

    await render(<UsageCreditBalanceCard />)
    await vi.waitFor(() => expect(container?.textContent).toContain('charge-on-previous-page'))
    const relation = container?.querySelector('details')
    expect(relation?.textContent).toContain('Usage charge')
    expect(relation?.textContent).toContain('-1')
    expect(relation?.textContent).not.toContain('admin')
  })
})
