import { Warning } from '@phosphor-icons/react'
import { useOptionalUsageCredit } from '../../UsageCreditContext'
import { m as messages } from '../../paraglide/messages.js'

/** Shows the server-side low-balance decision throughout the authenticated application shell. */
export default function LowBalanceWarning() {
  const usage = useOptionalUsageCredit()
  if (!usage?.balance?.lowBalance) return null
  const href = window.location.pathname.startsWith('/zh') ? '/zh/profile#usage' : '/profile#usage'
  return (
    <div role="alert" className="rounded-md border border-kumo-warning/40 bg-kumo-warning/10">
      <a
        href={href}
        className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-xs text-kumo-default"
      >
        <Warning size={15} weight="fill" aria-hidden="true" />
        <span>{messages.usage_credit_low_balance_warning()}</span>
      </a>
    </div>
  )
}
