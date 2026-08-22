import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { ActionState, Overseer } from '@gadgets/workshop-shared/api'
import { m as messages } from './paraglide/messages.js'

type ActionDecision = 'approve' | 'deny'

export function useResolveAction(
  overseer: RpcStub<Overseer>,
  setProcessing: Dispatch<SetStateAction<Set<number>>>,
  onResolved?: (actionId: number, state: Exclude<ActionState, 'pending' | 'applying'>) => void,
) {
  const toasts = useKumoToastManager()
  const onResolvedRef = useRef(onResolved)
  onResolvedRef.current = onResolved

  return useCallback(async (actionId: number, decision: ActionDecision) => {
    setProcessing(previous => new Set(previous).add(actionId))
    try {
      const state = decision === 'approve'
        ? await overseer.approveAction(actionId)
        : await overseer.rejectAction(actionId)
      onResolvedRef.current?.(actionId, state)
    } catch (error) {
      console.error(`Failed to ${decision} action:`, error)
      toasts.add({
        title: decision === 'approve'
          ? messages.approval_approve_error()
          : messages.approval_deny_error(),
        variant: 'error',
      })
    } finally {
      setProcessing(previous => {
        const next = new Set(previous)
        next.delete(actionId)
        return next
      })
    }
  }, [overseer, setProcessing, toasts])
}
