// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  addToast: vi.fn<(toast: unknown) => void>(),
  getAdminApi: vi.fn<() => Promise<unknown>>(),
  documentTitle: vi.fn<(title: string) => void>(),
  isAdmin: true,
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: testState.addToast }),
}))
vi.mock('./AuthContext', () => {
  const auth = {
    authenticatedApi: {
      getAdminApi: testState.getAdminApi,
    },
    get isAdmin() { return testState.isAdmin },
  }
  return { useAuthenticatedApi: () => auth }
})
vi.mock('./useDocumentTitle', () => ({
  useDocumentTitle: (title: string) => testState.documentTitle(title),
}))
vi.mock('./components/format/AdminFormatsPanel', () => ({ default: () => <div /> }))

import AdminPage from './AdminPage'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Element.prototype.scrollIntoView = vi.fn<() => void>()

function adminApi() {
  return {
    getSettings: async () => ({
      signupsEnabled: true,
      siteName: 'ADMIN SITE NAME 原样',
      siteLogo: undefined,
      resourceVendors: [],
      instanceInstructions: 'ADMIN INSTRUCTIONS 原样',
      announcement: 'ADMIN ANNOUNCEMENT 原样',
      banner: { text: 'ADMIN BANNER 原样', color: 'info' },
      accentColor: '',
      formats: [],
    }),
    getDeploymentModelCatalog: async () => ({
      models: [], defaultModelId: null, quickModelId: null,
    }),
    getAiGatewayInfo: async () => ({ enabled: false as const }),
    addDeploymentModel: async () => {},
    updateDeploymentModel: async () => {},
    setDeploymentDefaultModel: async () => {},
    setDeploymentQuickModel: async () => {},
    revokeDeploymentModel: async () => {},
    [Symbol.dispose]: vi.fn<() => void>(),
  }
}

describe('administrator localization', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.history.replaceState({}, '', '/')
    vi.clearAllMocks()
    testState.isAdmin = true
    root = undefined
    container = undefined
  })

  async function render(path: string) {
    window.history.replaceState({}, '', path)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<AdminPage />))
  }

  it.each([
    {
      path: '/admin',
      heading: 'Admin',
      description: 'Deployment-wide settings. Changes apply to all users on their next connection.',
      general: 'General',
      models: 'Models',
      siteName: 'Site name',
    },
    {
      path: '/zh/admin',
      heading: '管理员',
      description: '部署级设置。更改会在所有用户下次连接时生效。',
      general: '常规',
      models: '模型',
      siteName: '站点名称',
    },
  ])('localizes administrator settings at $path without changing configured values', async ({
    path,
    heading,
    description,
    general,
    models,
    siteName,
  }) => {
    testState.getAdminApi.mockResolvedValue(adminApi())
    await render(path)

    await vi.waitFor(() => expect(container?.textContent).toContain('ADMIN INSTRUCTIONS 原样'))
    expect(container?.querySelector('h1')?.textContent).toBe(heading)
    expect(container?.textContent).toContain(description)
    expect(container?.textContent).toContain(general)
    expect(container?.textContent).toContain(models)
    expect(container?.textContent).toContain(siteName)
    expect(container?.textContent).toContain('ADMIN INSTRUCTIONS 原样')
    expect(container?.querySelector<HTMLInputElement>(`input[aria-label="${siteName}"]`)?.value)
      .toBe('ADMIN SITE NAME 原样')
    expect(testState.documentTitle).toHaveBeenCalledWith(heading)
  })

  it('localizes the Chinese load error and recovery action', async () => {
    testState.getAdminApi.mockRejectedValue(new Error('ADMIN-DIAGNOSTIC-原样'))
    await render('/zh/admin')

    await vi.waitFor(() => expect(container?.textContent).toContain('加载管理员设置时出现问题。'))
    expect(container?.textContent).toContain('重试')
    expect(container?.textContent).toContain('ADMIN-DIAGNOSTIC-原样')
  })

  it('does not mint the administrator capability for a normal user', async () => {
    window.history.replaceState({}, '', '/zh/admin')
    testState.isAdmin = false
    await render('/zh/admin')

    expect(container?.textContent).toContain('你无权访问此页面。')
    expect(testState.getAdminApi).not.toHaveBeenCalled()
    expect(container?.textContent).not.toContain('模型配置')
  })

  it('lets an administrator manage Default and Quick Models', async () => {
    const setDeploymentDefaultModel = vi.fn<(id: string) => Promise<void>>().mockResolvedValue()
    const setDeploymentQuickModel = vi.fn<(id: string | null) => Promise<void>>()
      .mockResolvedValue()
    const revokeDeploymentModel = vi.fn<(id: string) => Promise<void>>().mockResolvedValue()
    const api = {
      ...adminApi(),
      getDeploymentModelCatalog: vi.fn<() => Promise<{
        models: Array<{ type: 'agent'; id: string; name: string }>
        defaultModelId: string | null
        quickModelId: string | null
      }>>()
        .mockResolvedValueOnce({
          models: [
            { type: 'agent', id: 'model-1', name: '生产模型' },
            { type: 'agent', id: 'model-2', name: '快速模型' },
          ],
          defaultModelId: 'model-1',
          quickModelId: null,
        })
        .mockResolvedValue({
          models: [
            { type: 'agent', id: 'model-1', name: '生产模型' },
            { type: 'agent', id: 'model-2', name: '快速模型' },
          ],
          defaultModelId: 'model-1',
          quickModelId: null,
        }),
      setDeploymentDefaultModel,
      setDeploymentQuickModel,
      revokeDeploymentModel,
    }
    testState.getAdminApi.mockResolvedValue(api)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await render('/zh/admin')

    await vi.waitFor(() => expect(container?.textContent).toContain('ADMIN INSTRUCTIONS 原样'))
    const modelsTab = [...container!.querySelectorAll('button')]
      .find(button => button.textContent === '模型')
    await act(async () => modelsTab!.click())
    await vi.waitFor(() => expect(container?.textContent).toContain('生产模型'))
    expect(container?.textContent).toContain('轮换配置')
    expect(container?.textContent).toContain('默认')
    expect(container?.textContent).toContain('快速')

    const modelRows = [...container!.querySelectorAll('div')]
      .filter(row => row.className.includes('rounded-lg') && row.className.includes('border'))
    const defaultRow = modelRows.find(row => row.textContent?.includes('生产模型'))!
    const quickRow = modelRows.find(row => row.textContent?.includes('快速模型'))!
    expect(defaultRow.querySelector<HTMLButtonElement>('button:last-child')?.disabled).toBe(true)

    const setDefault = [...quickRow.querySelectorAll('button')]
      .find(button => button.textContent === '设为默认')
    await act(async () => setDefault!.click())
    expect(setDeploymentDefaultModel).toHaveBeenCalledWith('model-2')

    const setQuick = [...quickRow.querySelectorAll('button')]
      .find(button => button.textContent === '设为快速模型')
    await act(async () => setQuick!.click())
    expect(setDeploymentQuickModel).toHaveBeenCalledWith('model-2')
  })
})
