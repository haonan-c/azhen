// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi,
  BoundHookInfo,
  GadgetBindingInfo,
  GadgetClient,
  Overseer,
} from '@gadgets/workshop-shared/api'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children, open }: { children: ReactNode; open: boolean }) => open ? <>{children}</> : null,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: ComponentProps<'button'>) => ReactNode }) => <>{render({})}</>,
    },
  )
  return {
    Dialog,
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

vi.mock('./GatekeeperModal', () => ({ default: () => null }))
vi.mock('./components/GatekeeperIcon', () => ({ GatekeeperIcon: () => <span data-testid="connection-icon" /> }))
vi.mock('./components/HookToggle', () => ({ HookToggle: () => <button type="button">钩子开关</button> }))
vi.mock('./useVendorBranding', () => ({ useVendorBranding: () => new Map() }))
vi.mock('./errorReporting', () => ({ reportIssue: vi.fn<(site: string, error: unknown) => void>() }))
vi.mock('./components/EmptyState', () => ({ EmptyState: () => null }))
vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, tone: _tone, ...props }: ComponentProps<'button'> & { tone?: string }) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopIconButton: ({
    children,
    danger: _danger,
    ...props
  }: ComponentProps<'button'> & { danger?: boolean }) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopInput: (props: ComponentProps<'input'>) => <input {...props} />,
}))
vi.mock('./components/BlueprintBindingCard', () => ({
  BlueprintBindingCard: () => <div>连接设置表单</div>,
  loadBindingCardData: async () => ({
    bindingName: 'DOCS',
    resourceTitle: 'Q3 planning',
    creationSpec: {
      type: 'gatekeeper',
      vendorId: 'google',
      resourceUrl: 'https://docs.google.com/document/d/q3',
      typeUrlPattern: 'https://docs.google.com/document/d/*',
    },
    annotation: { title: 'Q3 planning', description: '', suggestValue: false },
  }),
}))

import Connections from './Connections'

const BINDING: GadgetBindingInfo = {
  name: 'DOCS',
  target: 12,
  resourceTitle: 'Q3 planning',
  vendorId: 'google',
}

const HOOK: BoundHookInfo = {
  id: 7,
  gatekeeperId: 12,
  gadgetId: 1,
  resourceTitle: 'GitHub repository',
  description: { title: 'Webhook ready', description: 'Creator-authored hook details' },
  enabled: true,
}

describe('Connections localization', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.history.replaceState({}, '', '/')
    root = undefined
    container = undefined
  })

  it('localizes connection, hook, and template controls while preserving names', async () => {
    window.history.replaceState({}, '', '/zh/workspace/campaign')
    const gadget = {
      getId: async () => 1,
      getTitle: async () => 'Campaign app',
      listBindings: async () => [BINDING],
      renameBinding: async () => {},
      unbind: async () => {},
      setBlueprintAnnotation: async () => {},
    } as unknown as RpcStub<GadgetClient>
    const overseer = {
      listHooks: async () => [HOOK],
    } as unknown as RpcStub<Overseer>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <Connections
        overseer={overseer}
        gadget={gadget}
        authenticatedApi={{} as RpcStub<AuthenticatedApi>}
      />,
    ))

    await vi.waitFor(() => expect(container?.textContent).toContain('Q3 planning'))
    expect(container.textContent).toContain('连接')
    expect(container.textContent).toContain('此应用可以使用的外部资源。')
    expect(container.textContent).toContain('钩子')
    expect(container.textContent).toContain('Webhook ready')
    expect(container.textContent).toContain('Creator-authored hook details')
    expect(container.textContent).not.toContain('Connections')
    expect(container.textContent).not.toContain('Callbacks that let')
    expect(container.querySelector('[aria-label="编辑代码中的名称"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="编辑模板设置"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="删除连接"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="删除钩子"]')).not.toBeNull()

    await act(async () => {
      container?.querySelector<HTMLButtonElement>('[aria-label="编辑代码中的名称"]')?.click()
    })
    expect(container.querySelector('input[aria-label="绑定名称"]')).not.toBeNull()
    expect(container.textContent).toContain('保存')
    expect(container.textContent).toContain('取消')

    await act(async () => {
      container?.querySelector<HTMLInputElement>('input[aria-label="绑定名称"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await act(async () => {
      container?.querySelector<HTMLButtonElement>('[aria-label="编辑模板设置"]')?.click()
    })
    await vi.waitFor(() => expect(container?.textContent).toContain('模板设置'))
    expect(container.textContent).toContain('此连接在模板中的显示方式。')
    expect(container.textContent).toContain('连接设置表单')
  })

  it('lets the owner replace an unavailable model binding', async () => {
    window.history.replaceState({}, '', '/zh/workspace/campaign')
    const replaceUnavailableModelBinding = vi.fn<(name: string, modelId: string) => Promise<void>>()
      .mockResolvedValue()
    const unavailable: GadgetBindingInfo = {
      name: 'LLM',
      target: 21,
      resourceTitle: '旧模型',
      model: { type: 'aiModel', modelId: 'revoked-model', available: false },
    }
    const gadget = {
      getId: async () => 1,
      getTitle: async () => 'Campaign app',
      listBindings: async () => [unavailable],
      replaceUnavailableModelBinding,
    } as unknown as RpcStub<GadgetClient>
    const overseer = {
      getMetadata: async () => ({ id: 'workspace', title: 'Campaign', role: 'build' as const }),
      listHooks: async () => [],
      listModels: async () => [{ type: 'agent' as const, id: 'replacement-model', name: '新模型' }],
    } as unknown as RpcStub<Overseer>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <Connections
        overseer={overseer}
        gadget={gadget}
        authenticatedApi={{} as RpcStub<AuthenticatedApi>}
      />,
    ))

    await vi.waitFor(() => expect(container?.textContent).toContain('旧模型'))
    expect(container.textContent).toContain('不可用')
    const replaceButton = [...container.querySelectorAll('button')]
      .find(button => button.textContent?.includes('更换模型'))
    expect(replaceButton).toBeDefined()

    await act(async () => replaceButton!.click())
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="替代模型"]')!
    await act(async () => {
      select.value = 'replacement-model'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const confirm = [...container.querySelectorAll('button')]
      .find(button => button.textContent === '更换')
    await act(async () => confirm!.click())

    expect(replaceUnavailableModelBinding).toHaveBeenCalledWith('LLM', 'replacement-model')
  })
})
