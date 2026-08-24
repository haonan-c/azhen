// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UsageCreditBalance, UsageCreditBalanceSubscriber } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'

const testState = vi.hoisted(() => ({ api: null as unknown }))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.api }),
}))

import { UsageCreditProvider, useOptionalUsageCredit } from './UsageCreditContext'

function balance(revision: bigint, availableSubunits = revision): UsageCreditBalance {
  return {
    availableSubunits,
    reservedSubunits: 0n,
    revision,
    lowBalance: false,
    lowBalanceThresholdSubunits: 10n,
    activationNotice: null,
  }
}

function deferredRpc<T>() {
  let resolve!: (value: T) => void
  const dispose = vi.fn<() => void>()
  const promise = Object.assign(new Promise<T>(next => { resolve = next }), { [Symbol.dispose]: dispose })
  return { promise, resolve, dispose }
}

function makeApi(pending = deferredRpc<{ [Symbol.dispose](): void }>()) {
  let subscriber: RpcStub<UsageCreditBalanceSubscriber> | null = null
  const api = Object.assign(vi.fn<() => void>(), {
    subscribeUsageCreditBalance: vi.fn<(
      next: RpcStub<UsageCreditBalanceSubscriber>,
    ) => typeof pending.promise>((next) => {
      subscriber = next
      return pending.promise
    }),
    acknowledgeUsageActivationNotice: vi.fn<(
      noticeId: string,
    ) => Promise<UsageCreditBalance>>(),
  })
  return { api, pending, getSubscriber: () => subscriber }
}

function Probe() {
  const usage = useOptionalUsageCredit()!
  return <div>{usage.loading ? 'loading' : usage.stale ? 'stale' : String(usage.balance?.availableSubunits)}</div>
}

function AcknowledgeProbe() {
  const usage = useOptionalUsageCredit()!
  return (
    <div>
      <span>{usage.loading ? 'loading' : usage.stale ? 'stale' : String(usage.balance?.availableSubunits)}</span>
      <button type="button" onClick={() => void usage.acknowledgeActivationNotice('notice-safe')}>Acknowledge</button>
    </div>
  )
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('UsageCreditProvider subscription lifecycle', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    vi.clearAllMocks()
  })

  async function render() {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<UsageCreditProvider><Probe /></UsageCreditProvider>))
  }

  it('accepts only increasing revisions and releases the resolved subscription on unmount', async () => {
    const current = makeApi()
    const subscriptionDispose = vi.fn<() => void>()
    testState.api = current.api
    await render()

    await act(async () => current.getSubscriber()!.update(balance(2n, 20n)))
    expect(container?.textContent).toBe('20')
    await act(async () => current.getSubscriber()!.update(balance(1n, 10n)))
    expect(container?.textContent).toBe('20')
    await act(async () => current.getSubscriber()!.update(balance(3n, 30n)))
    expect(container?.textContent).toBe('30')

    await act(async () => current.pending.resolve({ [Symbol.dispose]: subscriptionDispose }))
    act(() => root!.unmount())
    expect(subscriptionDispose).toHaveBeenCalledOnce()
    root = undefined
  })

  it('releases a pending old subscription and a late result when the authenticated API changes', async () => {
    const oldApi = makeApi()
    const nextApi = makeApi()
    const lateDispose = vi.fn<() => void>()
    const nextDispose = vi.fn<() => void>()
    testState.api = oldApi.api
    await render()
    await act(async () => oldApi.getSubscriber()!.update(balance(4n, 40n)))

    testState.api = nextApi.api
    await act(async () => root!.render(<UsageCreditProvider><Probe /></UsageCreditProvider>))
    expect(container?.textContent).toBe('loading')
    expect(oldApi.pending.dispose).toHaveBeenCalledOnce()

    await act(async () => oldApi.pending.resolve({ [Symbol.dispose]: lateDispose }))
    expect(lateDispose).toHaveBeenCalledOnce()
    expect(container?.textContent).toBe('loading')

    await act(async () => nextApi.getSubscriber()!.update(balance(5n, 50n)))
    await act(async () => nextApi.pending.resolve({ [Symbol.dispose]: nextDispose }))
    expect(container?.textContent).toBe('50')
    act(() => root!.unmount())
    expect(nextDispose).toHaveBeenCalledOnce()
    root = undefined
  })

  it('marks an initial subscription failure stale without exposing its error', async () => {
    const rejection = Object.assign(
      Promise.reject(new Error('SENSITIVE SUBSCRIPTION DETAIL')),
      { [Symbol.dispose]: vi.fn<() => void>() },
    )
    testState.api = Object.assign(vi.fn<() => void>(), {
      subscribeUsageCreditBalance: vi.fn<() => typeof rejection>(() => rejection),
      acknowledgeUsageActivationNotice: vi.fn<(
        noticeId: string,
      ) => Promise<UsageCreditBalance>>(),
    })
    await render()
    await vi.waitFor(() => expect(container?.textContent).toBe('stale'))
    expect(container?.textContent).not.toContain('SENSITIVE SUBSCRIPTION DETAIL')
  })

  it('rebuilds the full subscription after a transient initial failure', async () => {
    vi.useFakeTimers()
    const firstFailure = Object.assign(
      Promise.reject(new Error('TRANSIENT SUBSCRIPTION FAILURE')),
      { [Symbol.dispose]: vi.fn<() => void>() },
    )
    const recovered = deferredRpc<{ [Symbol.dispose](): void }>()
    let recoveredSubscriber: RpcStub<UsageCreditBalanceSubscriber> | null = null
    let attempt = 0
    const api = Object.assign(vi.fn<() => void>(), {
      subscribeUsageCreditBalance: vi.fn<(
        subscriber: RpcStub<UsageCreditBalanceSubscriber>,
      ) => typeof firstFailure | typeof recovered.promise>((subscriber) => {
        attempt += 1
        if (attempt > 1) {
          recoveredSubscriber = subscriber
          return recovered.promise
        }
        return firstFailure
      }),
      acknowledgeUsageActivationNotice: vi.fn<(
        noticeId: string,
      ) => Promise<UsageCreditBalance>>(),
    })
    testState.api = api

    try {
      await render()
      await act(async () => {})
      expect(container?.textContent).toBe('stale')

      await act(async () => vi.advanceTimersByTime(1_000))
      expect(api.subscribeUsageCreditBalance).toHaveBeenCalledTimes(2)
      await act(async () => recoveredSubscriber!.update(balance(8n, 80n)))
      expect(container?.textContent).toBe('80')
      expect(firstFailure[Symbol.dispose]).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a late activation acknowledgement from the previous authenticated API', async () => {
    const oldApi = makeApi()
    const nextApi = makeApi()
    const lateAcknowledgement = deferredRpc<UsageCreditBalance>()
    oldApi.api.acknowledgeUsageActivationNotice.mockReturnValue(lateAcknowledgement.promise)
    testState.api = oldApi.api
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <UsageCreditProvider><AcknowledgeProbe /></UsageCreditProvider>,
    ))
    await act(async () => oldApi.getSubscriber()!.update(balance(4n, 40n)))

    const button = container.querySelector('button')!
    await act(async () => button.click())
    testState.api = nextApi.api
    await act(async () => root!.render(
      <UsageCreditProvider><AcknowledgeProbe /></UsageCreditProvider>,
    ))
    await act(async () => nextApi.getSubscriber()!.update(balance(5n, 50n)))
    expect(container.textContent).toContain('50')

    await act(async () => lateAcknowledgement.resolve(balance(99n, 990n)))
    expect(container.textContent).toContain('50')
    expect(container.textContent).not.toContain('990')
  })
})
