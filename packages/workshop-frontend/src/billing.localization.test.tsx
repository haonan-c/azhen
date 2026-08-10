// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudflareUsageInfo } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  addToast: vi.fn<(toast: unknown) => void>(),
  getUsage: vi.fn<() => Promise<CloudflareUsageInfo>>(),
  listAccounts: vi.fn<() => Promise<Array<{ accountId: string; accountName: string }>>>(async () => [
    { accountId: 'account-1', accountName: 'ACCOUNT NAME 原样' },
  ]),
}))

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children, open }: { children: ReactNode; open: boolean }) => open ? <>{children}</> : null,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    },
  )
  const Radio = {
    Group: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Legend: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Item: ({ label }: { label: ReactNode }) => <div>{label}</div>,
  }
  return {
    Button: ({ children, loading: _loading, ...props }: ComponentProps<'button'> & { loading?: boolean }) => (
      <button type="button" {...props}>{children}</button>
    ),
    Dialog,
    Loader: ({ 'aria-label': ariaLabel }: { 'aria-label'?: string }) => (
      <output aria-label={ariaLabel} />
    ),
    Radio,
    useKumoToastManager: () => ({ add: testState.addToast }),
  }
})
vi.mock('./AuthContext', () => {
  const authenticatedApi = {
    getCloudflareUsage: testState.getUsage,
    listCloudflareAccounts: testState.listAccounts,
    selectCloudflareAccount: async () => {},
    connectAccount: async () => ({ url: 'https://example.com/connect' }),
  }
  const auth = { authenticatedApi }
  return {
    useAuthenticatedApi: () => auth,
    useOptionalAuthenticatedApi: () => auth,
  }
})
vi.mock('./ServerConfigContext', () => ({
  useCloudflareLimitsEnabled: () => true,
}))

import AccountSelectionModal from './components/billing/AccountSelectionModal'
import OutOfCreditsModal from './components/billing/OutOfCreditsModal'
import ResetCountdown from './components/billing/ResetCountdown'
import UsageSettings from './components/billing/UsageSettings'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CONNECTED_USAGE: CloudflareUsageInfo = {
  cloudflareLimitsEnabled: true,
  unlimited: false,
  connected: true,
  needsAccountSelection: false,
  remaining: 1234,
  dailyUsed: 4444,
  dailyLimit: 5678,
  resetAt: undefined,
  balance: 1234.5,
  accountId: 'account-1',
  accountName: 'ACCOUNT NAME 原样',
}

describe('account and billing localization', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.history.replaceState({}, '', '/')
    vi.clearAllMocks()
    vi.useRealTimers()
    root = undefined
    container = undefined
  })

  async function render(node: ReactNode, path: string) {
    window.history.replaceState({}, '', path)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(node))
  }

  it('localizes the mandatory Chinese account-selection dialog and preserves account names', async () => {
    testState.getUsage.mockResolvedValue({
      ...CONNECTED_USAGE,
      needsAccountSelection: true,
    })
    await render(<AccountSelectionModal />, '/zh/profile')

    await vi.waitFor(() => expect(container?.textContent).toContain('ACCOUNT NAME 原样'))
    expect(container?.textContent).toContain('选择 Cloudflare 账户')
    expect(container?.textContent).toContain('你的 Cloudflare 连接可以访问多个账户。')
    expect(container?.textContent).toContain('保存')
    expect(container?.textContent).toContain('ACCOUNT NAME 原样')
  })

  it('gives the Chinese billing loader a localized live status name', async () => {
    testState.getUsage.mockReturnValue(new Promise(() => {}))
    await render(<OutOfCreditsModal open onClose={() => {}} />, '/zh/workspace/1')

    expect(container?.querySelector('output[aria-label="正在加载用量…"]')).not.toBeNull()
  })

  it.each([
    { path: '/profile', heading: 'Usage & billing', allowance: 'Free daily allowance', connected: 'Connected' },
    { path: '/zh/profile', heading: '用量与计费', allowance: '每日免费额度', connected: '已连接' },
  ])('formats quota and balance values with the active locale at $path', async ({
    path,
    heading,
    allowance,
    connected,
  }) => {
    testState.getUsage.mockResolvedValue(CONNECTED_USAGE)
    await render(<UsageSettings />, path)

    await vi.waitFor(() => expect(container?.textContent).toContain('ACCOUNT NAME 原样'))
    const locale = path.startsWith('/zh') ? 'zh' : 'en'
    expect(container?.textContent).toContain(heading)
    expect(container?.textContent).toContain(allowance)
    expect(container?.textContent).toContain(connected)
    expect(container?.textContent).toContain(new Intl.NumberFormat(locale).format(1234))
    expect(container?.textContent).toContain(new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(1234.5))
    expect(container?.textContent).toContain('ACCOUNT NAME 原样')
  })

  it('localizes the Chinese exhausted-quota recovery actions', async () => {
    testState.getUsage.mockResolvedValue({
      ...CONNECTED_USAGE,
      connected: false,
      remaining: 0,
      dailyLimit: 2000,
      balance: null,
      accountId: undefined,
      accountName: undefined,
    })
    await render(<OutOfCreditsModal open onClose={() => {}} />, '/zh/workspace/1')

    await vi.waitFor(() => expect(container?.textContent).toContain('已达到免费用量上限'))
    expect(container?.textContent).toContain('2,000')
    expect(container?.textContent).toContain('连接 Cloudflare')
    expect(container?.textContent).toContain('稍后再说')
    expect(container?.textContent).toContain('AI Gateway 统一计费')
  })

  it.each([
    { path: '/profile', countdown: '1h 2m 3s' },
    { path: '/zh/profile', countdown: '1时 2分 3秒' },
  ])('localizes the reset countdown at $path', async ({ path, countdown }) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-10T12:00:00Z'))
    await render(
      <ResetCountdown resetAt="2026-08-10T13:02:03Z" />,
      path,
    )

    expect(container?.textContent).toContain(countdown)
  })
})
