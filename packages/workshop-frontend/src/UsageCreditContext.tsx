import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { RpcStub, RpcTarget } from 'capnweb'
import type {
  UsageCreditBalance,
  UsageCreditBalanceSubscriber,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from './AuthContext'

const SUBSCRIPTION_RETRY_INITIAL_MS = 1_000
const SUBSCRIPTION_RETRY_MAX_MS = 30_000

type UsageCreditState = {
  balance: UsageCreditBalance | null
  loading: boolean
  stale: boolean
  acknowledgeActivationNotice(noticeId: string): Promise<void>
}

const UsageCreditContext = createContext<UsageCreditState | null>(null)

class BalanceSubscriber extends RpcTarget implements UsageCreditBalanceSubscriber {
  constructor(private updateBalance: (balance: UsageCreditBalance) => void) {
    super()
  }

  update(balance: UsageCreditBalance): void {
    this.updateBalance(balance)
  }
}

/** Maintains one live authoritative Usage Credit subscription for the authenticated shell. */
export function UsageCreditProvider({ children }: { children: React.ReactNode }) {
  const { authenticatedApi } = useAuthenticatedApi()
  const activeApi = useRef<typeof authenticatedApi | null>(authenticatedApi)
  activeApi.current = authenticatedApi
  // The callable authenticatedApi stub stays wrapped, so React never invokes it as a state setter.
  const [snapshot, setSnapshot] = useState<{
    api: typeof authenticatedApi
    balance: UsageCreditBalance | null
    loading: boolean
    stale: boolean
  } | null>(null)
  const current = snapshot?.api === authenticatedApi ? snapshot : null

  useEffect(() => {
    activeApi.current = authenticatedApi
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retryCount = 0
    let disposeAttempt = () => {}

    setSnapshot({api: authenticatedApi, balance: null, loading: true, stale: false})

    const startAttempt = () => {
      if (cancelled || activeApi.current !== authenticatedApi) return
      let attemptDisposed = false
      let pendingSubscription: ReturnType<typeof authenticatedApi.subscribeUsageCreditBalance> |
        null = null
      let resolvedSubscription: RpcStub<{}> | null = null
      const subscriber = new RpcStub(new BalanceSubscriber((balance) => {
        if (cancelled || attemptDisposed || activeApi.current !== authenticatedApi) return
        setSnapshot(previous => {
          if (previous?.api !== authenticatedApi) return previous
          if (previous.balance !== null && balance.revision <= previous.balance.revision) {
            return previous
          }
          return {api: authenticatedApi, balance, loading: false, stale: false}
        })
      }))
      const dispose = () => {
        if (attemptDisposed) return
        attemptDisposed = true
        if (resolvedSubscription === null) pendingSubscription?.[Symbol.dispose]()
        else resolvedSubscription[Symbol.dispose]()
        subscriber[Symbol.dispose]()
      }
      disposeAttempt = dispose

      const retry = () => {
        dispose()
        if (cancelled || activeApi.current !== authenticatedApi) return
        setSnapshot(previous => previous?.api === authenticatedApi
          ? {...previous, loading: false, stale: true}
          : previous)
        const delay = Math.min(
          SUBSCRIPTION_RETRY_INITIAL_MS * 2 ** retryCount,
          SUBSCRIPTION_RETRY_MAX_MS,
        )
        retryCount += 1
        retryTimer = setTimeout(() => {
          retryTimer = null
          startAttempt()
        }, delay)
      }

      try {
        pendingSubscription = authenticatedApi.subscribeUsageCreditBalance(subscriber)
      } catch {
        retry()
        return
      }
      pendingSubscription.then(subscription => {
        if (cancelled || attemptDisposed || activeApi.current !== authenticatedApi) {
          subscription[Symbol.dispose]()
          return
        }
        resolvedSubscription = subscription
      }).catch(retry)
    }
    startAttempt()

    return () => {
      cancelled = true
      if (retryTimer !== null) clearTimeout(retryTimer)
      disposeAttempt()
      if (activeApi.current === authenticatedApi) activeApi.current = null
    }
  }, [authenticatedApi])

  const value = useMemo<UsageCreditState>(() => ({
    balance: current?.balance ?? null,
    loading: current?.loading ?? true,
    stale: current?.stale ?? false,
    async acknowledgeActivationNotice(noticeId: string) {
      const balance = await authenticatedApi.acknowledgeUsageActivationNotice(noticeId)
      if (activeApi.current !== authenticatedApi) return
      setSnapshot(previous => {
        if (previous?.api !== authenticatedApi) return previous
        if (previous.balance !== null && balance.revision < previous.balance.revision) return previous
        return {api: authenticatedApi, balance, loading: false, stale: false}
      })
    },
  }), [authenticatedApi, current])

  return <UsageCreditContext.Provider value={value}>{children}</UsageCreditContext.Provider>
}

/** Read the live Usage Credit state when a provider is present. */
export function useOptionalUsageCredit(): UsageCreditState | null {
  return useContext(UsageCreditContext)
}
