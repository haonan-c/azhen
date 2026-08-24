import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { RpcStub, RpcTarget } from 'capnweb'
import type {
  UsageCreditBalance,
  UsageCreditBalanceSubscriber,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from './AuthContext'

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
  // The callable authenticatedApi stub stays wrapped, so React never invokes it as a state setter.
  const [snapshot, setSnapshot] = useState<{
    api: typeof authenticatedApi
    balance: UsageCreditBalance | null
    loading: boolean
    stale: boolean
  } | null>(null)
  const current = snapshot?.api === authenticatedApi ? snapshot : null

  useEffect(() => {
    let cancelled = false
    let resolvedSubscription: RpcStub<{}> | null = null
    let subscriberDisposed = false
    const subscriber = new RpcStub(new BalanceSubscriber((balance) => {
      if (cancelled) return
      setSnapshot(previous => {
        const previousBalance = previous?.api === authenticatedApi ? previous.balance : null
        if (previousBalance !== null && balance.revision <= previousBalance.revision) return previous
        return {api: authenticatedApi, balance, loading: false, stale: false}
      })
    }))
    const disposeSubscriber = () => {
      if (subscriberDisposed) return
      subscriberDisposed = true
      subscriber[Symbol.dispose]()
    }

    setSnapshot({api: authenticatedApi, balance: null, loading: true, stale: false})
    const pendingSubscription = authenticatedApi.subscribeUsageCreditBalance(subscriber)
    pendingSubscription.then(subscription => {
      if (cancelled) {
        subscription[Symbol.dispose]()
        return
      }
      resolvedSubscription = subscription
    }).catch(() => {
      disposeSubscriber()
      if (!cancelled) {
        setSnapshot(previous => ({
          api: authenticatedApi,
          balance: previous?.api === authenticatedApi ? previous.balance : null,
          loading: false,
          stale: true,
        }))
      }
    })

    return () => {
      cancelled = true
      if (resolvedSubscription === null) pendingSubscription[Symbol.dispose]()
      else resolvedSubscription[Symbol.dispose]()
      disposeSubscriber()
    }
  }, [authenticatedApi])

  const value = useMemo<UsageCreditState>(() => ({
    balance: current?.balance ?? null,
    loading: current?.loading ?? true,
    stale: current?.stale ?? false,
    async acknowledgeActivationNotice(noticeId: string) {
      const balance = await authenticatedApi.acknowledgeUsageActivationNotice(noticeId)
      setSnapshot(previous => {
        const previousBalance = previous?.api === authenticatedApi ? previous.balance : null
        if (previousBalance !== null && balance.revision < previousBalance.revision) return previous
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
