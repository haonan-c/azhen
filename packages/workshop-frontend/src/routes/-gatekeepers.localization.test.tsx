// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  documentTitle: vi.fn<(title: string) => void>(),
  authenticatedApi: null as unknown as {
    listAddableGatekeepers: () => Promise<unknown[]>
    listGatekeeperVendors: () => Promise<unknown[]>
    subscribeConnectedAccounts: (subscriber: {
      add: (...args: unknown[]) => void
      ready: () => void
    }) => Promise<{ [Symbol.dispose](): void }>
  },
}))

testState.authenticatedApi = {
  listAddableGatekeepers: async () => [],
  listGatekeeperVendors: async () => [{
    id: 'github',
    description: {
      displayName: 'GitHub Vendor Original',
      tagline: 'Vendor-owned tagline',
      description: 'Vendor-owned description',
    },
    supportedResources: [{
      title: 'GitHub Repository Original',
      description: 'Vendor-owned resource description',
      urlPattern: 'https://github.com/:owner/:repo',
    }],
  }],
  subscribeConnectedAccounts: async (subscriber) => {
    subscriber.add(
      7,
      { displayName: 'Seller Account Original', uniqueName: 'seller@example.com' },
      {
        displayName: 'Google Vendor Original',
        tagline: 'Connected vendor tagline',
      },
      [],
      true,
      'google',
    )
    subscriber.ready()
    return { [Symbol.dispose]() {} }
  },
}

vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

vi.mock('../AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: testState.authenticatedApi,
  }),
}))

vi.mock('../ServerConfigContext', () => ({ useSiteName: () => '阿珍测试站' }))
vi.mock('../useDocumentTitle', () => ({
  useDocumentTitle: (title: string) => testState.documentTitle(title),
}))
vi.mock('../useGatekeeperApps', () => ({ refreshGatekeeperApps: () => {} }))
vi.mock('../components/EmptyState', () => ({
  EmptyState: ({ title, description }: { title: string; description: string }) => (
    <div><h2>{title}</h2><p>{description}</p></div>
  ),
}))
vi.mock('../components/ConnectConnectorModal', () => ({ default: () => null }))

// Exercise the route component produced by the production router transform.
// @ts-expect-error Vite resolves this TanStack Router virtual module during the test transform.
import { component as ConnectorsPage } from './gatekeepers?tsr-split=component'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Connectors page localization', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    localStorage.clear()
    window.history.replaceState({}, '', '/')
    vi.clearAllMocks()
    root = undefined
    container = undefined
  })

  it.each([
    {
      path: '/gatekeepers',
      heading: 'Gatekeepers',
      description: 'Add the apps and accounts your workspaces can use. Connect once, then wire them into anything you build.',
      search: 'Search gatekeepers…',
      connected: 'Connected',
      available: 'Available',
      otherLocaleText: '添加工作空间可以使用的应用和账号。',
    },
    {
      path: '/zh/gatekeepers',
      heading: '安全连接器',
      description: '添加工作空间可以使用的应用和账号。只需连接一次，即可用于你构建的任何内容。',
      search: '搜索安全连接器…',
      connected: '已连接',
      available: '可用',
      otherLocaleText: 'Add the apps and accounts',
    },
  ])('localizes discovery at $path while preserving vendor and account text', async ({
    path,
    heading,
    description,
    search,
    connected,
    available,
    otherLocaleText,
  }) => {
    window.history.replaceState({}, '', path)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<ConnectorsPage />))

    await vi.waitFor(() => expect(container?.textContent).toContain('Seller Account Original'))
    expect(container.querySelector('h1')?.textContent).toBe(heading)
    expect(container.textContent).toContain(description)
    expect(container.querySelector<HTMLInputElement>('input')?.placeholder).toBe(search)
    expect(container.textContent).toContain(connected)
    expect(container.textContent).toContain(available)
    expect(container.textContent).toContain('Google Vendor Original')
    expect(container.textContent).toContain('Seller Account Original')
    expect(container.textContent).toContain('GitHub Vendor Original')
    expect(container.textContent).toContain('Vendor-owned tagline')
    expect(testState.documentTitle).toHaveBeenCalledWith(heading)
    expect(container.textContent).not.toContain(otherLocaleText)
  })
})
