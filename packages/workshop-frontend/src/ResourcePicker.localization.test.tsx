// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api'

const RESOURCE_PATTERN = 'https://github.com/:owner/:repo'

const testState = vi.hoisted(() => ({
  authenticatedApi: null as unknown as RpcStub<AuthenticatedApi>,
}))

testState.authenticatedApi = {
  listGatekeeperVendors: async () => [{
    id: 'github',
    description: {
      displayName: 'GitHub Vendor Original',
      tagline: 'Vendor-owned tagline',
    },
    supportedResources: [{
      title: 'GitHub Repository Original',
      description: 'Vendor-owned resource description',
      urlPattern: RESOURCE_PATTERN,
      grantable: true,
    }],
  }],
  subscribeConnectedAccounts: async (subscriber: ConnectedAccountsSubscriber) => {
    const vendor = {
      displayName: 'GitHub Vendor Original',
      url: 'https://vendor.example',
    }
    const resources = [{
      title: 'GitHub Repository Original',
      description: 'Vendor-owned resource description',
      urlPattern: RESOURCE_PATTERN,
      grantable: true,
    }]
    subscriber.add(1, {
      displayName: 'Seller Account Original',
      uniqueName: 'seller@example.com',
      avatar: { url: 'https://vendor.example/seller.png' },
      grantedResourceUrlPatterns: [RESOURCE_PATTERN],
    }, vendor, resources, true, 'github')
    subscriber.add(2, {
      displayName: 'Expired Account Original',
      avatar: { url: 'https://vendor.example/expired.png' },
      grantedResourceUrlPatterns: [RESOURCE_PATTERN],
    }, vendor, resources, false, 'github')
    subscriber.add(3, {
      displayName: 'Limited Account Original',
      avatar: { url: 'https://vendor.example/limited.png' },
      grantedResourceUrlPatterns: [],
    }, vendor, resources, true, 'github')
    subscriber.ready()
    return { [Symbol.dispose]() {} }
  },
} as unknown as RpcStub<AuthenticatedApi>

vi.mock('@cloudflare/kumo', () => ({
  Tooltip: ({ children, content }: { children: ReactNode; content: string }) => (
    <div title={content}>{children}</div>
  ),
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

vi.mock('./components/GatekeeperIcon', () => ({
  GatekeeperIcon: () => <span data-testid="gatekeeper-icon" />,
}))

import ResourcePicker from './ResourcePicker'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('ResourcePicker localization', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.history.replaceState({}, '', '/')
    root = undefined
    container = undefined
  })

  it('localizes picker states while preserving connector-provided text', async () => {
    window.history.replaceState({}, '', '/zh/workspace/campaign')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ResourcePicker
        authenticatedApi={testState.authenticatedApi}
        searchText=""
        onSelectAccount={() => {}}
      />,
    ))

    await vi.waitFor(() => expect(container?.textContent).toContain('seller@example.com'))
    expect(container.textContent).toContain('GitHub Repository Original')
    expect(container.textContent).toContain('Vendor-owned resource description')
    expect(container.textContent).toContain('seller@example.com')
    expect(container.textContent).toContain('Expired Account Original')
    expect(container.textContent).toContain('凭据已过期，点击重新验证')
    expect(container.textContent).toContain('Limited Account Original')
    expect(container.textContent).toContain('授予访问权限')
    expect(container.textContent).toContain('连接新账号')
    expect(container.textContent).not.toContain('Expired — click to re-authenticate')
    expect(container.textContent).not.toContain('Connect new account')
  })
})
