import { useCallback, useEffect, useState } from 'react'
import { CloudflareUsageInfo, CloudflareAccountOption } from '@gadgets/workshop-shared/api'
import { Dialog, Button, Loader, Radio, useKumoToastManager } from '@cloudflare/kumo'
import { Warning } from '@phosphor-icons/react'
import { useOptionalAuthenticatedApi } from '../../AuthContext'
import { useCloudflareLimitsEnabled } from '../../ServerConfigContext'
import { m as messages } from '../../paraglide/messages.js'

/**
 * Global, mandatory modal that forces the user to pick which Cloudflare account to bill whenever
 * they're connected but have access to more than one account. Auto-opens (and re-opens) as long as
 * the selection is pending, so it can't be missed after connecting. Mounted once in the app shell.
 */
export default function AccountSelectionModal() {
  const limitsEnabled = useCloudflareLimitsEnabled()
  const auth = useOptionalAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [needsSelection, setNeedsSelection] = useState(false)
  const [accounts, setAccounts] = useState<CloudflareAccountOption[] | null>(null)
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)

  const check = useCallback(() => {
    if (!auth) return
    auth.authenticatedApi.getCloudflareUsage()
      .then((u: CloudflareUsageInfo) => {
        setNeedsSelection(!!(u.connected && u.needsAccountSelection))
      })
      .catch(() => {})
  }, [auth])

  useEffect(() => {
    if (!limitsEnabled || !auth) return
    check()
    const onFocus = () => check()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [limitsEnabled, auth, check])

  // Load the account list once we know a selection is needed; default the choice to the first one.
  useEffect(() => {
    if (needsSelection && accounts === null && auth) {
      auth.authenticatedApi.listCloudflareAccounts()
        .then((list: CloudflareAccountOption[]) => {
          setAccounts(list)
          setChosen(list[0]?.accountId)
        })
        .catch(() => setAccounts([]))
    }
  }, [needsSelection, accounts, auth])

  if (!limitsEnabled || !auth || !needsSelection) return null

  const save = async () => {
    if (!chosen) return
    setSaving(true)
    try {
      await auth.authenticatedApi.selectCloudflareAccount(chosen)
      toasts.add({ title: messages.billing_account_selected(), variant: 'success' })
      setNeedsSelection(false)
      setAccounts(null)
    } catch (err) {
      toasts.add({
        title: messages.billing_select_account_error(),
        description: err instanceof Error ? err.message : undefined,
        variant: 'error',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    // role="alertdialog" + no close affordance: the choice is mandatory, so it isn't dismissible by
    // clicking outside.
    <Dialog.Root open role="alertdialog">
      <Dialog className="p-6 sm:w-[480px]" size="base">
        <Dialog.Title className="text-lg font-semibold mb-2 flex items-center gap-2">
          <Warning size={22} weight="bold" className="text-kumo-warning" />
          {messages.billing_select_account_title()}
        </Dialog.Title>

        <div className="space-y-4">
          <p className="text-sm text-kumo-subtle">
            {messages.billing_select_account_description()}
          </p>

          {accounts === null ? (
            <div className="flex justify-center py-6">
              <Loader size="base" aria-label={messages.billing_loading_accounts()} />
            </div>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-kumo-subtle">{messages.billing_no_accounts()}</p>
          ) : (
            <Radio.Group
              appearance="card"
              value={chosen}
              onValueChange={setChosen}
              disabled={saving}
            >
              <Radio.Legend className="sr-only">{messages.billing_account_label()}</Radio.Legend>
              {accounts.map((a) => (
                <Radio.Item key={a.accountId} value={a.accountId} label={a.accountName} />
              ))}
            </Radio.Group>
          )}

          <div className="flex justify-end gap-2 pt-1">
            {accounts !== null && accounts.length === 0 ? (
              // Degenerate case: the connection reported multiple accounts but the list came back
              // empty (transient API failure, or access changed). Don't trap the user in an
              // un-actionable modal — let them retry or dismiss (it re-checks on focus).
              <>
                <Button variant="ghost" onClick={() => setNeedsSelection(false)}>
                  {messages.common_dismiss()}
                </Button>
                <Button variant="secondary" onClick={() => setAccounts(null)}>
                  {messages.common_retry()}
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                onClick={save}
                loading={saving}
                disabled={!chosen || saving}
              >
                {messages.common_save()}
              </Button>
            )}
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
