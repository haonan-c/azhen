// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, ConnectedAccountsSubscriber, Overseer } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  authenticatedApi: null as unknown as RpcStub<AuthenticatedApi>,
}))

testState.authenticatedApi = {
  listModels: async () => [{ type: 'agent', id: 'model-original', name: 'Model Original' }],
  listGatekeeperVendors: async () => [{
    id: 'github',
    description: {
      displayName: 'GitHub Vendor Original',
      tagline: 'Vendor-owned tagline',
    },
    supportedResources: [{
      title: 'GitHub Repository Original',
      description: 'Vendor-owned resource description',
      urlPattern: 'https://github.com/:owner/:repo',
    }],
  }],
  subscribeConnectedAccounts: async (subscriber: ConnectedAccountsSubscriber) => {
    subscriber.ready()
    return { [Symbol.dispose]() {} }
  },
} as unknown as RpcStub<AuthenticatedApi>

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Root: ({ children, open }: { children: ReactNode; open: boolean }) => open ? <>{children}</> : null,
      Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: ComponentProps<'button'>) => ReactNode }) => <>{render({})}</>,
    },
  )
  const Select = Object.assign(
    ({ children, placeholder, 'aria-label': ariaLabel }: {
      children: ReactNode
      placeholder?: string
      'aria-label'?: string
    }) => <div aria-label={ariaLabel} data-placeholder={placeholder}>{children}</div>,
    { Option: ({ children }: { children: ReactNode }) => <div>{children}</div> },
  )
  return {
    Dialog,
    Select,
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))
vi.mock('./ServerConfigContext', () => ({ useSiteName: () => '阿珍测试站' }))
vi.mock('./ResourceConfiguratorHost', () => ({ default: () => null }))
vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, tone: _tone, ...props }:
    ComponentProps<'button'> & { tone?: string }) => <button {...props}>{children}</button>,
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
  WorkshopInput: (props: ComponentProps<'input'>) => <input {...props} />,
}))
vi.mock('./errorReporting', () => ({ reportIssue: () => {} }))

import GatekeeperModal from './GatekeeperModal'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('GatekeeperModal localization', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    document.body.textContent = ''
    window.history.replaceState({}, '', '/')
    root = undefined
    container = undefined
  })

  it('localizes connection discovery and AI model configuration', async () => {
    window.history.replaceState({}, '', '/zh/workspace/campaign')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <GatekeeperModal
        open
        onClose={() => {}}
        getOverseer={() => ({} as RpcStub<Overseer>)}
        onCreated={async () => {}}
      />,
    ))

    await vi.waitFor(() => expect(container?.textContent).toContain('GitHub Vendor Original'))
    expect(container.querySelector('h1')?.textContent).toBe('创建新连接')
    expect(container.textContent).toContain('选择此应用可以使用的内容。')
    expect(container.querySelector<HTMLInputElement>('input')?.placeholder)
      .toBe('搜索服务、应用和数据源…')
    expect(container.textContent).toContain('AI 模型')
    expect(container.textContent).toContain('Agent')
    expect(container.textContent).toContain('GitHub Vendor Original')
    expect(container.textContent).toContain('Vendor-owned resource description')

    const aiModelGroup = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('AI 模型'))!
    await act(async () => aiModelGroup.click())
    const aiModelRows = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .filter(button => button.textContent?.includes('AI 模型'))
    await act(async () => aiModelRows.at(-1)!.click())

    expect(container.querySelector('h1')?.textContent).toBe('AI 模型')
    expect(container.textContent).toContain('通过此连接使用所选模型。')
    expect(container.textContent).toContain('所有连接类型')
    expect(container.textContent).toContain('选择此连接可以使用的模型。')
    expect(container.querySelector('[aria-label="选择 AI 模型"]')).not.toBeNull()
    expect(container.textContent).toContain('Model Original')
    expect(container.textContent).toContain('返回')
    expect(container.textContent).toContain('创建连接')
    expect(container.textContent).not.toContain('Create New Connection')
    expect(container.textContent).not.toContain('Choose the model this connection can use.')
  })
})
