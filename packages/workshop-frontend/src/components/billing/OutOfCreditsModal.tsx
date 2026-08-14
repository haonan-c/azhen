import { useCallback, useEffect, useState } from 'react'
import { CloudflareUsageInfo, CloudflareAccountOption } from '@gadgets/workshop-shared/api'
import { Dialog, Button, Loader, useKumoToastManager } from '@cloudflare/kumo'
import { CloudWarning, Lightning } from '@phosphor-icons/react'
import { useOptionalAuthenticatedApi } from '../../AuthContext'
import { buildAddCreditsUrl } from './creditsUrl'
import ResetCountdown from './ResetCountdown'
import { formatResetTime, formatUsdBalance } from './formatBilling'
import { m as messages } from '../../paraglide/messages.js'
import { formatLocaleNumber } from '../../utils/formatNumber'

interface OutOfCreditsModalProps {
  open: boolean
  onClose: () => void
}

/**
 * Modal shown when a user has exhausted their free daily allowance. Guides them to connect their
 * Cloudflare account (if not connected), pick which account to bill (if they have several), or top
 * up credits in the Cloudflare dashboard (if connected but low balance).
 */
export default function OutOfCreditsModal({ open, onClose }: OutOfCreditsModalProps) {
  const auth = useOptionalAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [usage, setUsage] = useState<CloudflareUsageInfo | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [accounts, setAccounts] = useState<CloudflareAccountOption[] | null>(null)
  const [selecting, setSelecting] = useState<string | null>(null)

  const refresh = useCallback(() => {
    if (!auth) return
    auth.authenticatedApi.getCloudflareUsage()
      .then((u: CloudflareUsageInfo) => setUsage(u))
      .catch(() => {})
  }, [auth])

  useEffect(() => {
    if (!open || !auth) return
    setUsage(null)
    setAccounts(null)
    refresh()
    // Re-check when the tab regains focus, so returning from the "Connect Cloudflare" OAuth pop-up
    // updates the modal (connected state / balance / account list) without reopening it.
    const onFocus = () => {
      setAccounts(null)
      refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [open, auth, refresh])

  // Load the account list when the server says the user must pick one.
  useEffect(() => {
    if (!auth) return
    if (usage?.connected && usage.needsAccountSelection && accounts === null) {
      auth.authenticatedApi.listCloudflareAccounts()
        .then((list: CloudflareAccountOption[]) => setAccounts(list))
        .catch(() => setAccounts([]))
    }
  }, [auth, usage, accounts])

  const connect = async () => {
    if (!auth) return
    setConnecting(true)
    try {
      const { url } = await auth.authenticatedApi.connectAccount('cloudflare')
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      toasts.add({
        title: messages.billing_connection_start_error(),
        description: err instanceof Error ? err.message : undefined,
        variant: 'error',
      })
    } finally {
      setConnecting(false)
    }
  }

  const selectAccount = async (accountId: string) => {
    if (!auth) return
    setSelecting(accountId)
    try {
      await auth.authenticatedApi.selectCloudflareAccount(accountId)
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

  const connected = usage?.connected ?? false
  const needsSelection = connected && (usage?.needsAccountSelection ?? false)

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog className="p-6 sm:w-[560px]" size="base">
        <Dialog.Title className="text-lg font-semibold mb-2 flex items-center gap-2">
          <CloudWarning size={22} weight="bold" className="text-kumo-warning" />
          {messages.billing_limit_title()}
        </Dialog.Title>

        {usage === null ? (
          <div className="flex justify-center py-8">
            <Loader size="base" aria-label={messages.billing_loading_usage()} />
          </div>
        ) : (
          <div className="space-y-4">
            {!connected ? (
              <p className="text-sm text-kumo-subtle">
                {usage.dailyLimit === 1
                  ? messages.billing_limit_unconnected_one({
                      limit: formatLocaleNumber(usage.dailyLimit),
                    })
                  : messages.billing_limit_unconnected_many({
                      limit: formatLocaleNumber(usage.dailyLimit),
                    })}
                {usage.resetAt ? (
                  <>
                    {' '}
                    {usage.dailyLimit === 1
                      ? messages.billing_reset_wait_one({ time: formatResetTime(usage.resetAt) })
                      : messages.billing_reset_wait_many({ time: formatResetTime(usage.resetAt) })}{' '}
                    <ResetCountdown resetAt={usage.resetAt} onElapsed={refresh} />.
                  </>
                ) : '.'}
              </p>
            ) : needsSelection ? (
              <p className="text-sm text-kumo-subtle">
                {messages.billing_limit_select_description()}
              </p>
            ) : (
              <p className="text-sm text-kumo-subtle">
                {usage.balance !== null
                  ? messages.billing_limit_connected_balance({
                      balance: formatUsdBalance(usage.balance),
                    })
                  : messages.billing_limit_connected_unknown()}
                {usage.resetAt ? (
                  <>
                    {' '}
                    {usage.dailyLimit === 1
                      ? messages.billing_reset_wait_one({ time: formatResetTime(usage.resetAt) })
                      : messages.billing_reset_wait_many({ time: formatResetTime(usage.resetAt) })}{' '}
                    <ResetCountdown resetAt={usage.resetAt} onElapsed={refresh} />.
                  </>
                ) : '.'}
              </p>
            )}

            {needsSelection && (
              <div className="flex flex-col gap-2">
                {accounts === null ? (
                  <p role="status" className="text-sm text-kumo-subtle">
                    {messages.billing_loading_accounts()}
                  </p>
                ) : accounts.length === 0 ? (
                  <p className="text-sm text-kumo-subtle">{messages.billing_no_accounts()}</p>
                ) : (
                  accounts.map((a) => (
                    <Button
                      key={a.accountId}
                      variant="secondary"
                      className="justify-start"
                      onClick={() => selectAccount(a.accountId)}
                      loading={selecting === a.accountId}
                      disabled={selecting !== null}
                    >
                      {a.accountName}
                    </Button>
                  ))
                )}
              </div>
            )}

            <p className="text-sm text-kumo-subtle">
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

            <div className="flex items-center justify-end gap-2 pt-2">
              {!connected ? (
                <>
                  <Button variant="secondary" onClick={onClose}>
                    {messages.billing_maybe_later()}
                  </Button>
                  <Button variant="primary" onClick={connect} loading={connecting}>
                    <Lightning size={16} weight="bold" />
                    {messages.billing_connect_cloudflare()}
                  </Button>
                </>
              ) : needsSelection ? (
                <Button variant="secondary" onClick={onClose}>{messages.common_close()}</Button>
              ) : (
                <>
                  <Button variant="secondary" onClick={onClose}>{messages.common_close()}</Button>
                  <Button
                    variant="primary"
                    onClick={() => window.open(buildAddCreditsUrl(usage.accountId), '_blank')}
                  >
                    {messages.billing_add_credits_cloudflare()}
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  )
}
