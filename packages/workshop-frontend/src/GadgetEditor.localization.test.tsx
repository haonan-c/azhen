// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo,
  AuthenticatedApi,
  GadgetClient,
  GadgetMetadata,
  Overseer,
  WorkpieceSummary,
  WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  navigate: vi.fn<(options: unknown) => void>(),
  workspaceOpen: null as unknown,
  authenticatedApi: {
    whoami: async () => ({ type: 'user' as const, id: 'owner@example.com', name: 'Owner' }),
  },
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to: _to, ...props }: ComponentProps<'a'> & { to: string }) => (
    <a {...props}>{children}</a>
  ),
  useNavigate: () => testState.navigate,
  useParams: () => ({ id: 'campaign' }),
  useSearch: () => ({ chat: 5, w: 1 }),
}))
vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>()
  return {
    ...actual,
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})
vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: testState.authenticatedApi as RpcStub<AuthenticatedApi>,
  }),
}))
vi.mock('./useWorkspaceOpen', () => ({ useWorkspaceOpen: () => testState.workspaceOpen }))
vi.mock('./useActions', () => ({ useActions: () => ({ actionsById: new Map() }) }))
vi.mock('./components/UserMenu', () => ({ default: () => null }))
vi.mock('./components/SiteLogo', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('./ObserverConfigModal', () => ({ default: () => null }))
vi.mock('./GadgetUI', () => ({ default: () => <div>用户生成的应用内容</div> }))
vi.mock('./GadgetUseView', () => ({ default: () => null }))
vi.mock('./Connections', () => ({ default: () => <div>connections</div> }))
vi.mock('./Activity', () => ({ default: () => <div>activity</div> }))
vi.mock('./ActivityNotifications', () => ({ default: () => null }))
vi.mock('./WorkpiecePicker', () => ({
  default: () => null,
  WORKPIECE_RAIL_COLLAPSED_WIDTH: 48,
  WORKPIECE_RAIL_EXPANDED_WIDTH: 220,
}))
vi.mock('./ChatInterface', () => ({
  default: ({ onChatCountChange, onHasAnyCodeChange }: {
    onChatCountChange: (count: number) => void
    onHasAnyCodeChange: (hasCode: boolean) => void
  }) => {
    useEffect(() => {
      onChatCountChange(1)
      onHasAnyCodeChange(true)
    }, [onChatCountChange, onHasAnyCodeChange])
    return <div>chat</div>
  },
}))
vi.mock('./GadgetCodeInterface', () => ({ default: () => <div>code</div> }))
vi.mock('./ShareModal', () => ({ default: () => null }))
vi.mock('./components/GadgetPresence', () => ({ GadgetPresence: () => null }))
vi.mock('./BlueprintModal', () => ({ default: () => null }))
vi.mock('./TopBarNotice', () => ({ default: () => null }))
vi.mock('./components/DeleteConfirmationDialog', () => ({ default: () => null }))
vi.mock('./components/WorkspaceOpenErrorPage', () => ({ default: () => null }))
vi.mock('./GadgetExportMenu', () => ({ default: () => null }))
vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopInput: (props: ComponentProps<'input'>) => <input {...props} />,
}))

import GadgetEditor from './GadgetEditor'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WORKPIECE = {
  id: 1,
  type: 'gadget',
  title: 'Campaign result',
  output: { id: 'document', noun: 'Doc', plural: 'Docs', icon: 'fileText' },
  filesRoot: 'app-1',
} as WorkpieceSummary

function disposable() {
  return { [Symbol.dispose]: () => {} } as RpcStub<{}>
}

function workspaceOpenResult() {
  const gadget = { [Symbol.dispose]: () => {} } as unknown as RpcStub<GadgetClient>
  const overseer = {
    subscribeToWorkpieces: async (subscriber: RpcStub<WorkpiecesSubscriber>) => {
      await subscriber.entry(WORKPIECE)
      await subscriber.ready()
      return disposable()
    },
    getGadget: () => gadget,
    listHooks: async () => [],
    subscribeToConsoleLogs: async () => disposable(),
  } as unknown as RpcStub<Overseer>
  const owner: AiChatAuthorInfo = {
    type: 'user',
    id: 'ada@example.com',
    name: 'Ada Lovelace',
  }
  return {
    overseer: { stub: overseer },
    metadata: {
      id: 'campaign',
      title: 'Campaign workspace',
      owner,
      defaultGadgetId: 1,
    } as GadgetMetadata,
    error: null,
    connectionLost: false,
    observerConfig: null,
    retry: vi.fn<() => void>(),
    cancelObserverConfig: vi.fn<() => void>(),
    updateTitle: vi.fn<(title: string) => void>(),
  }
}

describe('GadgetEditor localization', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    localStorage.clear()
    window.history.replaceState({}, '', '/')
    testState.navigate.mockClear()
    root = undefined
    container = undefined
  })

  it('localizes the main editor and full-screen controls while preserving names', async () => {
    window.history.replaceState({}, '', '/zh/workspace/campaign?chat=5&w=1#result')
    testState.workspaceOpen = workspaceOpenResult()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(<GadgetEditor />))

    await vi.waitFor(() => expect(container?.querySelector('[aria-label="进入全屏"]')).not.toBeNull())
    expect(container.textContent).toContain('Campaign workspace')
    expect(container.textContent).toContain('由 Ada Lovelace 创建')
    expect(container.textContent).toContain('文档')
    expect(container.textContent).not.toContain('Doc')
    expect(container.querySelector('[aria-label="首页"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="重命名工作空间"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="共享工作空间"]')).not.toBeNull()

    await act(async () => {
      container?.querySelector<HTMLButtonElement>('[aria-label="进入全屏"]')?.click()
    })

    expect(container.querySelector('[role="dialog"][aria-label="应用全屏"]')).not.toBeNull()
    expect(container.textContent).toContain('按 Esc 退出全屏')
    expect(container.textContent).not.toContain('Press Esc to exit full screen')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })
})
