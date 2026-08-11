import {
  OBSERVER_BINDING_FAILURE_CODES,
  type ObserverBindingFailure,
  type ObserverBindingFailureCode,
  type OpenGadgetObserverFailure,
} from '@gadgets/workshop-shared/api'
import { m as messages } from './paraglide/messages.js'

type PresentableObserverFailure =
  | ObserverBindingFailure
  | Extract<OpenGadgetObserverFailure, { reason: string }>
  | Extract<OpenGadgetObserverFailure, { reasonCode: ObserverBindingFailureCode }>

const WORKSHOP_REASON_MESSAGES: Record<ObserverBindingFailureCode, () => string> = {
  [OBSERVER_BINDING_FAILURE_CODES.accountDisconnected]:
    messages.observer_account_disconnected_reason,
}

export function presentObserverFailureReason(failure: PresentableObserverFailure): string {
  return failure.reasonCode
    ? WORKSHOP_REASON_MESSAGES[failure.reasonCode]()
    : failure.reason
}
