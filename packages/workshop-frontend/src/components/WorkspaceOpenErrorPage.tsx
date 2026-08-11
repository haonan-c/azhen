import { Lock, MagnifyingGlass, WarningCircle } from '@phosphor-icons/react'
import { useEffect, useId, useRef } from 'react'
import {
  getOpenGadgetErrorCode,
  OPEN_GADGET_ERROR_CODES,
  type OpenGadgetObserverFailure,
} from '@gadgets/workshop-shared/api'
import { WorkshopButton } from './WorkshopControls'
import { m as messages } from '../paraglide/messages.js'
import { presentObserverFailureReason } from '../observer-failure-presentation'

export type WorkspaceOpenFailureKind =
  | 'access-denied'
  | 'not-found'
  | 'observer-accounts-required'
  | 'observer-verification-failed'
  | 'unexpected'

const CONTENT = {
  'access-denied': {
    title: messages.workspace_open_access_denied_title,
    message: messages.workspace_open_access_denied_message,
    Icon: Lock,
    retryable: true,
  },
  'not-found': {
    title: messages.workspace_open_not_found_title,
    message: messages.workspace_open_not_found_message,
    Icon: MagnifyingGlass,
    retryable: false,
  },
  'observer-accounts-required': {
    title: messages.workspace_open_observer_accounts_required_title,
    message: messages.workspace_open_observer_accounts_required,
    Icon: WarningCircle,
    retryable: true,
  },
  'observer-verification-failed': {
    title: messages.workspace_open_observer_verification_failed_title,
    message: messages.workspace_open_observer_verification_failed_message,
    Icon: WarningCircle,
    retryable: true,
  },
  unexpected: {
    title: messages.workspace_open_unexpected_title,
    message: messages.workspace_open_unexpected_message,
    Icon: WarningCircle,
    retryable: true,
  },
} as const

export function classifyWorkspaceOpenFailure(error: unknown): WorkspaceOpenFailureKind {
  switch (getOpenGadgetErrorCode(error)) {
    case OPEN_GADGET_ERROR_CODES.workspaceAccessDenied:
      return 'access-denied'
    case OPEN_GADGET_ERROR_CODES.workspaceNotFound:
      return 'not-found'
    case OPEN_GADGET_ERROR_CODES.observerAccountsRequired:
      return 'observer-accounts-required'
    case OPEN_GADGET_ERROR_CODES.observerVerificationFailed:
      return 'observer-verification-failed'
    default:
      return 'unexpected'
  }
}

type Props = {
  kind: WorkspaceOpenFailureKind
  details?: OpenGadgetObserverFailure[]
  onRetry: () => void
  onGoToWorkspaces: () => void
}

export default function WorkspaceOpenErrorPage({ kind, details, onRetry, onGoToWorkspaces }: Props) {
  const { title: titleMessage, message: messageText, Icon, retryable } = CONTENT[kind]
  const title = titleMessage()
  const message = messageText()
  const titleId = useId()
  const descriptionId = useId()
  const detailId = useId()
  const titleRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  return (
    <div className="flex min-h-screen items-center justify-center bg-kumo-base px-6 py-12">
      <section
        aria-atomic="true"
        aria-describedby={details?.length ? `${descriptionId} ${detailId}` : descriptionId}
        aria-labelledby={titleId}
        aria-live="polite"
        className="themed-compact-shadow w-full max-w-md rounded-2xl border border-kumo-line bg-kumo-base px-6 py-8 text-center"
      >
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-kumo-line bg-kumo-tint text-kumo-subtle">
          <Icon aria-hidden="true" size={20} weight="bold" />
        </div>
        <h1
          id={titleId}
          ref={titleRef}
          tabIndex={-1}
          className="mt-5 text-[20px] leading-7 font-semibold tracking-[-0.35px] text-kumo-default outline-none"
        >
          {title}
        </h1>
        <p
          id={descriptionId}
          className="mt-2 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle"
        >
          {message}
        </p>
        {details && details.length > 0 && (
          <ul
            id={detailId}
            className="mt-4 max-h-40 list-disc space-y-2 overflow-auto rounded-lg border border-kumo-line bg-kumo-elevated py-3 pl-8 pr-3 text-left text-[12px] leading-[18px] text-kumo-subtle"
          >
            {details.map((failure, index) => {
              const reason = presentObserverFailureReason(failure)
              return (
                <li key={index}>
                  {failure.resourceTitle || messages.observer_service()}
                  {failure.accountLabel ? ` (${failure.accountLabel})` : ''}
                  {reason ? ` — ${reason}` : ''}
                </li>
              )
            })}
          </ul>
        )}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <WorkshopButton
            tone={retryable ? 'secondary' : 'primary'}
            className="!h-9"
            onClick={onGoToWorkspaces}
          >
            {messages.workspace_open_go_to_workspaces()}
          </WorkshopButton>
          {retryable && (
            <WorkshopButton tone="primary" onClick={onRetry}>
              {messages.workspace_open_retry()}
            </WorkshopButton>
          )}
        </div>
      </section>
    </div>
  )
}
