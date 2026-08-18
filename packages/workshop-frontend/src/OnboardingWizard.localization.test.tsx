// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => {
  const api = {
    completeOnboarding: vi.fn<() => Promise<void>>(),
    connectAccount: vi.fn<(vendorId: string) => Promise<{ url: string }>>(),
    getAiConfig: vi.fn<() => Promise<{ enabled: boolean; enabledProviders: string[] }>>(),
    listGatekeeperVendors: vi.fn<() => Promise<never[]>>(),
    listModels: vi.fn<() => Promise<Array<{ type: 'agent'; id: string; name: string }>>>(),
    setAvatar: vi.fn<(data: Uint8Array) => Promise<void>>(),
    setOwnDisplayName: vi.fn<(name: string) => Promise<void>>(),
    setPreferredModel: vi.fn<(id: string | null) => Promise<void>>(),
    subscribeConnectedAccounts: vi.fn<() => Promise<{ [Symbol.dispose](): void }>>(),
  }
  return {
    addToast: vi.fn<(toast: unknown) => void>(),
    api,
    avatarBlobUrl: vi.fn<() => string>(() => 'blob:avatar'),
    compressAvatar: vi.fn<(file: File) => Promise<Uint8Array>>(),
    isAdmin: false,
    onComplete: vi.fn<() => void>(),
  }
})

vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => ({ add: testState.addToast }),
}))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: testState.api,
    currentUser: { type: 'user', id: 'user-1', name: '店主 原名' },
    isAdmin: testState.isAdmin,
  }),
}))

vi.mock('./ThemeContext', () => ({
  useTheme: () => ({ resolvedThemeMode: 'light' }),
}))

vi.mock('./ServerConfigContext', () => ({
  useServerConfig: () => null,
  useSiteName: () => 'Northstar 原名',
}))

vi.mock('./AddModelModal', () => ({ default: () => null }))

vi.mock('./avatarUtils', () => ({
  avatarBlobUrl: () => testState.avatarBlobUrl(),
  compressAvatar: (file: File) => testState.compressAvatar(file),
}))

import OnboardingWizard from './OnboardingWizard'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('localized first-run onboarding', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    document.title = ''
    window.history.replaceState({}, '', '/')
    vi.clearAllMocks()
    testState.isAdmin = false
    root = undefined
    container = undefined
  })

  function configureApi(completeOnboarding: () => Promise<void>) {
    testState.api.completeOnboarding.mockImplementation(completeOnboarding)
    testState.api.getAiConfig.mockResolvedValue({ enabled: false, enabledProviders: [] })
    testState.api.listGatekeeperVendors.mockResolvedValue([])
    testState.api.listModels.mockResolvedValue([])
    testState.api.setPreferredModel.mockResolvedValue(undefined)
    testState.api.subscribeConnectedAccounts.mockReturnValue(Object.assign(
      Promise.resolve({ [Symbol.dispose]: vi.fn<() => void>() }),
      { [Symbol.dispose]: vi.fn<() => void>() },
    ))
  }

  async function render(path: string) {
    window.history.replaceState({}, '', path)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <OnboardingWizard onComplete={testState.onComplete} />,
    ))
    await vi.waitFor(() => expect(
      container?.querySelector<HTMLInputElement>('#onboarding-display-name')?.value,
    ).toBe('店主 原名'))
  }

  it.each([
    {
      path: '/',
      title: "Let's set you up",
      profile: 'Create your profile',
      next: 'Next',
      model: 'Choose your model',
      modelShowcase: 'Switch between the Deployment Models your administrator provides in each conversation.',
      personalModelSetup: 'Plug in personal API tokens',
      showcase: "You're all set",
      finish: "Let's build",
      finishing: 'Setting up...',
      documentTitle: 'Setup - Northstar 原名',
      currentStep: 'Step 1 of 2, current step',
      isAdmin: false,
    },
    {
      path: '/zh',
      title: '完成初始设置',
      profile: '创建个人资料',
      next: '下一步',
      model: '选择模型',
      modelShowcase: '在每次对话中切换管理员提供的部署模型。',
      personalModelSetup: '添加任意服务商的个人 API 令牌',
      showcase: '设置完成',
      finish: '开始使用',
      finishing: '正在完成设置…',
      documentTitle: '初始设置 - Northstar 原名',
      currentStep: '第 1 步，共 2 步，当前步骤',
      isAdmin: true,
    },
  ])('completes the onboarding journey at $path', async (expected) => {
    let resolveCompletion!: () => void
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve })
    configureApi(() => completion)
    testState.isAdmin = expected.isAdmin
    await render(expected.path)

    expect(container?.textContent).toContain(expected.title)
    expect(container?.textContent).toContain(expected.profile)
    expect(container?.querySelector<HTMLInputElement>('#onboarding-display-name')?.value)
      .toBe('店主 原名')
    expect(container?.querySelector(`[aria-label="${expected.currentStep}"]`)).not.toBeNull()
    expect(document.title).toBe(expected.documentTitle)

    const next = () => [...container!.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === expected.next)!
    await act(async () => next().click())
    expect(container?.textContent).toContain(expected.showcase)
    expect(container?.textContent).toContain('Northstar 原名')
    expect([...container!.querySelectorAll('h2')]
      .some(heading => heading.textContent === expected.model)).toBe(false)
    expect(container?.textContent).toContain(expected.modelShowcase)
    expect(container?.textContent).not.toContain(expected.personalModelSetup)

    const finish = [...container!.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === expected.finish)!
    await act(async () => finish.click())
    expect(container?.textContent).toContain(expected.finishing)

    await act(async () => resolveCompletion())
    expect(testState.api.listModels).not.toHaveBeenCalled()
    expect(testState.api.setPreferredModel).not.toHaveBeenCalled()
    expect(testState.api.completeOnboarding).toHaveBeenCalledOnce()
    expect(testState.onComplete).toHaveBeenCalledOnce()
  })

  it('localizes image validation without changing the selected filename', async () => {
    configureApi(async () => {})
    await render('/zh')
    const input = container!.querySelector<HTMLInputElement>('input[type="file"]')!
    const file = new File(['not an image'], '原始文件.txt', { type: 'text/plain' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })

    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))

    expect(testState.addToast).toHaveBeenCalledWith({
      title: '请选择图片文件',
      variant: 'error',
    })
    expect(file.name).toBe('原始文件.txt')
  })

  it('exposes a localized avatar processing status', async () => {
    let resolveAvatar!: (data: Uint8Array) => void
    testState.compressAvatar.mockReturnValue(new Promise((resolve) => { resolveAvatar = resolve }))
    configureApi(async () => {})
    await render('/zh')
    const input = container!.querySelector<HTMLInputElement>('input[type="file"]')!
    const file = new File(['image'], '头像原名.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })

    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))

    expect(container?.querySelector('[role="status"][aria-label="正在处理头像…"]'))
      .not.toBeNull()
    expect(file.name).toBe('头像原名.png')

    await act(async () => resolveAvatar(new Uint8Array([1])))
  })
})
