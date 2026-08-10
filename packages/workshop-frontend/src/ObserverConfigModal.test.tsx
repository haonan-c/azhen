// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi,
  ConnectedAccountsSubscriber,
  ObserverBindingNeed,
} from '@gadgets/workshop-shared/api'
import type { AccountDescription, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
    },
  )
  const Select = Object.assign(
    ({ children, placeholder }: { children: ReactNode; placeholder?: string }) => (
      <div data-testid="account-select" data-placeholder={placeholder}>{children}</div>
    ),
    { Option: ({ children }: { children: ReactNode }) => <div>{children}</div> },
  )
  return {
    Dialog,
    Loader: () => <span>Loading</span>,
    Select,
    Text: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

vi.mock('./components/Avatar', () => ({ default: () => <span data-testid="avatar" /> }))

import ObserverConfigModal from './ObserverConfigModal'

const VENDOR = {
  displayName: 'Google',
  color: '#4285f4',
} as VendorDescription

const NEED: ObserverBindingNeed = {
  gatekeeperId: 12,
  vendorId: 'google',
  resourceTitle: 'Q3 planning',
  resourceUrl: 'https://docs.google.com/document/d/quarterly',
}

function account(id: number, uniqueName: string) {
  return {
    id,
    description: { displayName: uniqueName, uniqueName } as AccountDescription,
  }
}

function fakeApi(accountEntries: ReturnType<typeof account>[]): RpcStub<AuthenticatedApi> {
  return {
    subscribeConnectedAccounts: async (subscriber: ConnectedAccountsSubscriber) => {
      for (const entry of accountEntries) {
        subscriber.add(entry.id, entry.description, VENDOR, [], true, 'google')
      }
      subscriber.ready()
      return { [Symbol.dispose]() {} }
    },
    listGatekeeperVendors: async () => [{ id: 'google', description: VENDOR }],
    listAddableGatekeepers: async () => [],
  } as unknown as RpcStub<AuthenticatedApi>
}

describe('ObserverConfigModal account selection', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.history.replaceState({}, '', '/')
    root = undefined
    container = undefined
  })

  async function render(accountEntries: ReturnType<typeof account>[]) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <ObserverConfigModal
          needs={[NEED]}
          authenticatedApi={fakeApi(accountEntries)}
          onConfirm={() => {}}
          onCancel={() => {}}
        />,
      )
      await Promise.resolve()
    })
    return container
  }

  it('shows a single matching account directly instead of putting it in a dropdown', async () => {
    const rendered = await render([account(1, 'dan@cloudflare.com')])

    expect(rendered.textContent).toContain('dan@cloudflare.com')
    expect(rendered.querySelector('[data-testid="account-select"]')).toBeNull()
  })

  it('keeps the account dropdown when multiple accounts match', async () => {
    const rendered = await render([
      account(1, 'dan@cloudflare.com'),
      account(2, 'dan.personal@gmail.com'),
    ])

    expect(rendered.querySelectorAll('[data-testid="account-select"]')).toHaveLength(1)
  })

  it('localizes shared-workspace verification while preserving resource, vendor, and account names', async () => {
    window.history.replaceState({}, '', '/zh/workspace/campaign')
    const rendered = await render([
      account(1, 'dan@cloudflare.com'),
      account(2, 'dan.personal@gmail.com'),
    ])

    expect(rendered.textContent).toContain('验证你的访问权限')
    expect(rendered.textContent).toContain('打开此工作空间前，请确认你自己的账户可以访问该工作空间使用的连接数据。')
    expect(rendered.textContent).toContain('Q3 planning')
    expect(rendered.textContent).toContain('dan@cloudflare.com')
    expect(rendered.textContent).toContain('dan.personal@gmail.com')
    expect(rendered.querySelector('[data-placeholder="选择 Google 账户…"]')).not.toBeNull()
    expect(rendered.textContent).toContain('取消')
    expect(rendered.textContent).toContain('验证并打开')
    expect(rendered.textContent).not.toContain('Verify your access')
    expect(rendered.textContent).not.toContain('Choose a Google account')
  })
})
