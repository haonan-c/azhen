import { useCallback, useEffect, useState } from 'react'
import { CloudflareUsageInfo, CloudflareAccountOption } from '@gadgets/workshop-shared/api'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import { Lightning, CloudCheck, Warning } from '@phosphor-icons/react'
import CloudflareLogo from '../auth/CloudflareLogo'
import { useAuthenticatedApi } from '../../AuthContext'
import { useCloudflareLimitsEnabled } from '../../ServerConfigContext'
import { buildAddCreditsUrl } from './creditsUrl'
import ResetCountdown from './ResetCountdown'
import { formatResetTime, formatUsdBalance } from './formatBilling'
import { m as messages } from '../../paraglide/messages.js'
import { formatLocaleNumber } from '../../utils/formatNumber'

// Shows the user's free-tier usage and Cloudflare connection / credit status on the profile page.
// Renders nothing unless the Cloudflare limits flow is enabled server-side.
export default function UsageSettings() {
  const limitsEnabled = useCloudflareLimitsEnabled()
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [usage, setUsage] = useState<CloudflareUsageInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  // Account-selection state (only used when the user has multiple Cloudflare accounts).
  const [accounts, setAccounts] = useState<CloudflareAccountOption[] | null>(null)
  const [selecting, setSelecting] = useState<string | null>(null)

  const refresh = useCallback(() => {
    authenticatedApi.getCloudflareUsage()
      .then((u: CloudflareUsageInfo) => setUsage(u))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [authenticatedApi])

  useEffect(() => {
    if (!limitsEnabled) {
      setLoading(false)
      return
    }
    refresh()
    // Re-check when the tab regains focus (e.g. after connecting / topping up elsewhere).
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [limitsEnabled, refresh])

  // When the server says the user must pick an account, load the list of accounts to choose from.
  useEffect(() => {
    if (usage?.connected && usage.needsAccountSelection && accounts === null) {
      authenticatedApi.listCloudflareAccounts()
        .then((list: CloudflareAccountOption[]) => setAccounts(list))
        .catch(() => setAccounts([]))
    }
  }, [usage, accounts, authenticatedApi])

  // Hidden entirely when the feature is off, or while the unlimited (self-hosted) default applies.
  if (!limitsEnabled || (usage && usage.unlimited)) return null

  const connect = async () => {
    setBusy(true)
    try {
      // Connecting (or signing in with) Cloudflare is handled by the Cloudflare gatekeeper. Open its
      // OAuth popup; the connected-accounts subscription + focus refresh pick up the result.
      const { url } = await authenticatedApi.connectAccount('cloudflare')
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      toasts.add({
        title: messages.billing_connection_start_error(),
        description: err instanceof Error ? err.message : undefined,
        variant: 'error',
      })
    } finally {
      setBusy(false)
    }
  }

  const selectAccount = async (accountId: string) => {
    setSelecting(accountId)
    try {
      await authenticatedApi.selectCloudflareAccount(accountId)
      toasts.add({ title: messages.billing_account_selected(), variant: 'success' })
      setAccounts(null)
      refresh()
    } catch (err) {
      toasts.add({
        title: messages.billing_select_account_error(),
        description: err instanceof Error ? err.message : undefined,
        variant: 'error',
      })
    } finally {
      setSelecting(null)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="px-1 text-[12px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
        {messages.billing_usage_heading()}
      </h2>
      <div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
      {loading || !usage ? (
        <p role="status" className="text-sm text-kumo-subtle">
          {messages.billing_loading_usage()}
        </p>
      ) : (
        <div className="space-y-6">
          {/* Free daily allowance */}
          <div>
            <p className="text-xs font-medium text-kumo-subtle mb-1">
              {messages.billing_free_allowance()}
            </p>
            <p className="text-sm text-kumo-default">
              {usage.dailyLimit === 1
                ? messages.billing_requests_remaining_one({
                    remaining: formatLocaleNumber(usage.remaining),
                    limit: formatLocaleNumber(usage.dailyLimit),
                  })
                : messages.billing_requests_remaining_many({
                    remaining: formatLocaleNumber(usage.remaining),
                    limit: formatLocaleNumber(usage.dailyLimit),
                  })}
            </p>
            {usage.resetAt && (
              <p className="text-xs text-kumo-subtle mt-1">
                {messages.billing_resets_in({ time: formatResetTime(usage.resetAt) })}{' '}
                <ResetCountdown resetAt={usage.resetAt} onElapsed={refresh} />.
              </p>
            )}
          </div>

          {/* Cloudflare connection / credits */}
          <div>
            <p className="text-xs font-medium text-kumo-subtle mb-1">
              {messages.billing_account_label()}
            </p>
            {!usage.connected ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-kumo-subtle">
                  <CloudflareLogo size={16} />
                  <span>{messages.billing_not_connected()}</span>
                </div>
                <p className="text-sm text-kumo-subtle">
                  {messages.billing_connect_description()}
                </p>
                <div className="pt-1">
                  <Button variant="primary" size="sm" onClick={connect} loading={busy}>
                    <Lightning size={14} weight="bold" className="mr-1" />
                    {messages.billing_connect_cloudflare()}
                  </Button>
                </div>
              </div>
            ) : usage.needsAccountSelection ? (
              // Connected, but multiple accounts — force the user to choose which one to bill.
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-kumo-default">
                  <Warning size={18} weight="bold" className="text-kumo-warning" />
                  <span>{messages.billing_choose_account()}</span>
                </div>
                <p className="text-sm text-kumo-subtle">
                  {messages.billing_choose_account_description()}
                </p>
                {accounts === null ? (
                  <p role="status" className="text-sm text-kumo-subtle">
                    {messages.billing_loading_accounts()}
                  </p>
                ) : accounts.length === 0 ? (
                  <p className="text-sm text-kumo-subtle">
                    {messages.billing_no_accounts()}
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {accounts.map((a) => (
                      <Button
                        key={a.accountId}
                        variant="secondary"
                        size="sm"
                        className="justify-start"
                        onClick={() => selectAccount(a.accountId)}
                        loading={selecting === a.accountId}
                        disabled={selecting !== null}
                      >
                        {a.accountName}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-kumo-default">
                  <CloudCheck size={18} weight="bold" className="text-kumo-success" />
                  <span>
                    {messages.billing_connected()}
                    {usage.accountName && <> — {usage.accountName}</>}
                  </span>
                </div>
                <p className="text-sm text-kumo-default">
                  {messages.billing_account_balance({
                    balance: usage.balance !== null
                      ? formatUsdBalance(usage.balance)
                      : messages.billing_balance_unknown(),
                  })}
                </p>

                <div className="flex items-center gap-2 pt-1">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => window.open(buildAddCreditsUrl(usage.accountId), '_blank')}
                  >
                    <Lightning size={14} weight="bold" className="mr-1" />
                    {messages.billing_add_credits()}
                  </Button>
                </div>
              </div>
            )}
          </div>

          <p className="text-xs text-kumo-subtle border-t border-kumo-line pt-3">
            {messages.billing_learn_more()}{' '}
            <a
              href="https://developers.cloudflare.com/ai-gateway/features/unified-billing/"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              {messages.billing_unified_billing()}
            </a>
            .
          </p>
        </div>
      )}
      </div>
    </section>
  )
}
