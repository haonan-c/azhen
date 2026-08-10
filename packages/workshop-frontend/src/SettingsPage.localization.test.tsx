// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  addToast: vi.fn<(toast: unknown) => void>(),
  whoami: vi.fn<() => Promise<{ id: string; name: string }>>(),
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: testState.addToast }),
}))
vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: {
      whoami: testState.whoami,
      hasPasswordLogin: async () => false,
    },
  }),
}))
vi.mock('./ServerConfigContext', () => ({
  useCloudflareLimitsEnabled: () => false,
}))
vi.mock('./useAvatar', () => ({
  useAvatar: () => null,
  invalidateAvatarCache: () => {},
}))
vi.mock('./useDocumentTitle', () => ({ useDocumentTitle: () => {} }))

import SettingsPage from './SettingsPage'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Profile localization', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.history.replaceState({}, '', '/')
    vi.clearAllMocks()
    root = undefined
    container = undefined
  })

  async function render(path: string) {
    window.history.replaceState({}, '', path)
    testState.whoami.mockResolvedValue({ id: 'USER-ID-原样', name: 'USER NAME 原样' })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<SettingsPage />))
    await vi.waitFor(() => expect(container?.textContent).toContain('USER NAME 原样'))
  }

  it.each([
    {
      path: '/profile',
      heading: 'Profile',
      description: 'Manage your account details, avatar, and security.',
      account: 'Account',
      displayName: 'Display name',
      editLabel: 'Edit display name',
      copyLabel: 'Copy user ID',
    },
    {
      path: '/zh/profile',
      heading: '个人资料',
      description: '管理你的账户信息、头像和安全设置。',
      account: '账户',
      displayName: '显示名称',
      editLabel: '编辑显示名称',
      copyLabel: '复制用户 ID',
    },
  ])('localizes account controls at $path without changing account data', async ({
    path,
    heading,
    description,
    account,
    displayName,
    editLabel,
    copyLabel,
  }) => {
    await render(path)

    expect(container?.querySelector('h1')?.textContent).toBe(heading)
    expect(container?.textContent).toContain(description)
    expect(container?.textContent).toContain(account)
    expect(container?.textContent).toContain(displayName)
    expect(container?.querySelector(`[aria-label="${editLabel}"]`)).not.toBeNull()
    expect(container?.querySelector(`[aria-label="${copyLabel}"]`)).not.toBeNull()
    expect(container?.textContent).toContain('USER NAME 原样')
    expect(container?.textContent).toContain('USER-ID-原样')
  })

  it('uses a localized error title and keeps an unknown profile diagnostic', async () => {
    window.history.replaceState({}, '', '/zh/profile')
    testState.whoami.mockRejectedValue(new Error('PROFILE-DIAGNOSTIC-原样'))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<SettingsPage />))

    await vi.waitFor(() => expect(testState.addToast).toHaveBeenCalledWith({
      title: '无法加载用户信息',
      description: 'PROFILE-DIAGNOSTIC-原样',
      variant: 'error',
    }))
  })
})
