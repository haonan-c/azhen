// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  isAdmin: false,
  navigate: vi.fn<(options: unknown) => void>(),
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useNavigate: () => testState.navigate,
}))

vi.mock('@cloudflare/kumo', () => {
  const DropdownMenu = Object.assign(
    ({ children }: { children: ReactNode }) => <>{children}</>,
    {
      Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Group: ({ children }: { children: ReactNode }) => <>{children}</>,
      Item: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
      Label: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      RadioGroup: ({ children }: { children: ReactNode }) => <>{children}</>,
      RadioItem: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
      RadioItemIndicator: () => null,
      Separator: () => <hr />,
      Trigger: ({ render }: { render: ReactNode }) => <>{render}</>,
    },
  )
  return { DropdownMenu }
})

vi.mock('../AuthContext', () => {
  const auth = {
    get isAdmin() { return testState.isAdmin },
    authenticatedApi: {},
    currentUser: { type: 'user' as const, id: 'user-1', name: '用户 原名' },
    logout: vi.fn<() => void>(),
  }
  return {
    useAuthenticatedApi: () => auth,
    useOptionalAuthenticatedApi: () => auth,
  }
})

vi.mock('../useAvatar', () => ({ useAvatar: () => null }))
vi.mock('../useGatekeeperApps', () => ({ useGatekeeperApps: () => [] }))
vi.mock('../ServerConfigContext', () => ({
  useServerConfig: () => null,
  useSiteName: () => '站点 原名',
}))
vi.mock('../TopBarNotice', () => ({ default: () => null }))

import Header from './Header'
import UserMenu from './UserMenu'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('model management navigation visibility', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.history.replaceState({}, '', '/')
    testState.isAdmin = false
    vi.clearAllMocks()
    root = undefined
    container = undefined
  })

  async function renderMenu() {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<UserMenu />))
  }

  it('does not offer model or administrator management to a normal user', async () => {
    window.history.replaceState({}, '', '/zh')
    await renderMenu()

    expect(container?.textContent).not.toContain('模型服务商')
    expect(container?.textContent).not.toContain('管理')
  })

  it('offers only the deployment administration area to an administrator', async () => {
    window.history.replaceState({}, '', '/zh')
    testState.isAdmin = true
    await renderMenu()

    expect(container?.textContent).not.toContain('模型服务商')
    expect(container?.textContent).toContain('管理')
  })

  it('does not offer model management in a normal user mobile menu', async () => {
    window.history.replaceState({}, '', '/zh')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Header />))

    const openMenu = container.querySelector<HTMLButtonElement>('[aria-label="打开菜单"]')!
    await act(async () => openMenu.click())

    expect(container.textContent).not.toContain('模型服务商')
    expect(container.textContent).not.toContain('管理')
  })
})
