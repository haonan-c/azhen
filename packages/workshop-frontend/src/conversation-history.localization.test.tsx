// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RpcStub } from 'capnweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ActionsSubscriber,
  AiChatMessage,
  AiChatSubscriber,
  BlueprintOutput,
  Overseer,
} from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  addToast: vi.fn<(toast: unknown) => void>(),
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: testState.addToast }),
}))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: {
      getPreferredModel: async () => null,
      setPreferredModel: async () => {},
    },
    currentUser: { id: 'user-1', username: 'owner', name: 'Owner' },
  }),
}))

vi.mock('./useVendorBranding', () => ({
  useVendorBranding: () => new Map(),
}))

vi.mock('./GatekeeperModal', () => ({ default: () => null }))

vi.mock('./components/billing/OutOfCreditsModal', () => ({ default: () => null }))

vi.mock('./components/format/useOutputFormats', () => ({
  useOutputFormats: () => ({ formats: [], creating: null, create: vi.fn<() => void>() }),
}))

import ChatInterface from './ChatInterface'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver
HTMLElement.prototype.scrollTo = vi.fn<() => void>()

const stableNavigateToChat = () => {}
const stableConsumeConsoleLogs = () => ''
const stableDiscardConsoleLogs = () => {}
const stableOutputOfWorkpiece = () => undefined

const USER = { type: 'user', id: 'user-1', name: 'Owner' } as const
const AGENT = { type: 'agent', id: 'model-1', name: 'Agent Original Name' } as const
const AT = new Date('2026-08-10T12:34:00Z')
const DOCUMENT_OUTPUT: BlueprintOutput = {
  id: 'document', noun: 'Doc', plural: 'Docs', icon: 'fileText',
}
const CUSTOM_OUTPUT: BlueprintOutput = {
  id: 'custom-board', noun: 'Launch Board', plural: 'Launch Boards', icon: 'kanban',
}
const FUTURE_OUTPUT: BlueprintOutput = {
  id: 'future-format',
  noun: 'Future Item',
  plural: 'Future Items',
  icon: 'futureIcon' as BlueprintOutput['icon'],
}

const messages: AiChatMessage[] = [
  {
    chatId: 7,
    sequence: 0,
    timestamp: AT,
    author: USER,
    type: 'message',
    message: 'USER CONTENT VERBATIM',
    attachments: [{
      id: 'attachment-1',
      mimeType: 'application/pdf',
      name: 'ATTACHMENT NAME VERBATIM.pdf',
      size: 1234,
    }],
  },
  {
    chatId: 7,
    sequence: 1,
    timestamp: AT,
    author: AGENT,
    type: 'message',
    message: 'AGENT OUTPUT VERBATIM',
    reasoning: 'REASONING CONTENT VERBATIM',
    toolCalls: [{
      toolCallId: 'tool-1',
      toolName: 'executeCode',
      input: { code: 'const payload = "ORIGINAL INPUT";' },
      output: 'TOOL RESPONSE VERBATIM',
    }, {
      toolCallId: 'tool-2',
      toolName: 'readFile',
      input: { filename: 'RAW-FILE-A.txt' },
    }, {
      toolCallId: 'tool-3',
      toolName: 'readFile',
      input: { filename: 'RAW-FILE-B.txt' },
    }],
  },
  {
    chatId: 7,
    sequence: 2,
    timestamp: AT,
    author: AGENT,
    type: 'changes',
    createdGadgets: [
      { gadgetId: 11, title: 'RESULT TITLE VERBATIM', bindingName: 'document' },
      { gadgetId: 12, title: 'CUSTOM RESULT VERBATIM', bindingName: 'custom' },
      { gadgetId: 13, title: 'FUTURE RESULT VERBATIM', bindingName: 'future' },
    ],
  },
  {
    chatId: 7,
    sequence: 3,
    timestamp: AT,
    author: AGENT,
    type: 'action',
    actionId: 42,
    actionLog: {
      id: 42,
      gatekeeperId: 9,
      type: 'action',
      state: 'pending',
      createdAt: AT,
      resourceTitle: 'RESOURCE TITLE VERBATIM',
      description: {
        title: 'CONNECTOR ACTION TITLE VERBATIM',
        description: 'CONNECTOR ACTION BODY VERBATIM',
        implementsRevert: false,
        autoApprovable: true,
        actionKind: { tag: 'publish', label: 'CONNECTOR KIND VERBATIM' },
      },
    },
  },
  {
    chatId: 7,
    sequence: 4,
    timestamp: AT,
    author: AGENT,
    type: 'connectionRequest',
    requestId: 'request-1',
    vendorId: 'vendor-original',
    vendorName: 'VENDOR NAME VERBATIM',
    resourceTitle: 'CONNECTION SCOPE VERBATIM',
    reason: 'CONNECTION REASON VERBATIM',
    state: 'pending',
  },
  {
    chatId: 7,
    sequence: 5,
    timestamp: AT,
    author: AGENT,
    type: 'error',
    message: 'RAW DIAGNOSTIC VERBATIM',
  },
  {
    chatId: 7,
    sequence: 6,
    timestamp: AT,
    author: AGENT,
    type: 'error',
    code: 'usage_limit',
    message: 'RAW USAGE LIMIT DETAIL VERBATIM',
  },
]

describe('localized conversation history', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    window.history.replaceState({}, '', '/')
    localStorage.clear()
    vi.clearAllMocks()
  })

  // Reproduce under full-suite load with `pnpm test & suite_pid=$!; target_status=0;
  // for run_index in 1 2 3; do pnpm --filter @gadgets/workshop-frontend exec vitest run
  // src/conversation-history.localization.test.tsx -t "lets a Chinese user" || target_status=$?;
  // done; wait "$suite_pid"; suite_status=$?; if test "$target_status" -ne 0;
  // then exit "$target_status"; else exit "$suite_status"; fi`.
  // Five isolated runs took 0.90-1.19s. A loaded run took 5.41s. The test has no unawaited
  // updates or leaked subscriptions, so this local margin covers measured CPU contention.
  it('lets a Chinese user view a response, inspect a tool, approve an action, and open a result', async () => {
    window.history.replaceState({}, '', '/zh/workspace/7')
    const approveAction = vi.fn<(actionId: number) => Promise<void>>(async () => {})
    const denyConnectionRequest = vi.fn<(requestId: string) => Promise<void>>(async () => {})
    const revertChanges = vi.fn<(chatId: number, revertFrom: number) => Promise<void>>(async () => {})
    const onOpenGadget = vi.fn<(gadgetId: number) => void>()
    const outputOfWorkpiece = (gadgetId: number) => {
      if (gadgetId === 11) return DOCUMENT_OUTPUT
      if (gadgetId === 12) return CUSTOM_OUTPUT
      if (gadgetId === 13) return FUTURE_OUTPUT
      return undefined
    }
    const disposable = { [Symbol.dispose]: vi.fn<() => void>() }
    const overseer = {
      subscribeToChat: (_subscriber: AiChatSubscriber) => disposable,
      subscribeToActions: async (subscriber: ActionsSubscriber) => {
        subscriber.ready()
        return disposable
      },
      listChats: async () => [{
        id: 7,
        title: 'CONVERSATION TITLE VERBATIM',
        started: AT,
        lastActive: AT,
        hasProposedChanges: true,
      }],
      listModels: async () => [AGENT],
      listSlashCommands: async () => [],
      getChatHistory: async () => ({ messages }),
      approveAction,
      rejectAction: async () => {},
      denyConnectionRequest,
      revertChanges,
    } as unknown as RpcStub<Overseer>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ChatInterface
        workspaceId="workspace-7"
        overseer={overseer}
        selectedChatId={7}
        onNavigateToChat={() => {}}
        pendingConsoleLogCount={0}
        consoleLogPreview=""
        consoleLogSeverity="info"
        onConsumeConsoleLogs={() => ''}
        onDiscardConsoleLogs={() => {}}
        onOpenGadget={onOpenGadget}
        outputOfWorkpiece={outputOfWorkpiece}
      />,
    ))

    expect(container.textContent).toContain('USER CONTENT VERBATIM')
    expect(container.textContent).toContain('AGENT OUTPUT VERBATIM')
    expect(container.textContent).toContain('REASONING CONTENT VERBATIM')
    const attachment = container.querySelector<HTMLButtonElement>(
      '[aria-label="预览 ATTACHMENT NAME VERBATIM.pdf"]',
    )
    await act(async () => attachment!.click())
    expect(document.body.textContent).toContain('ATTACHMENT NAME VERBATIM.pdf')
    expect(document.body.textContent).toContain('无法在这里预览此文件。')
    expect(document.body.textContent).toContain('下载')
    expect(document.body.querySelector('[aria-label="关闭预览"]')).not.toBeNull()
    await act(async () => document.body.querySelector<HTMLButtonElement>('[aria-label="关闭预览"]')!.click())
    expect(container.textContent).toContain('运行代码')
    expect(container.textContent).toContain('读取了 2 个文件')
    expect(container.textContent).toContain('新文档 · 点击预览')
    expect(container.textContent).toContain('新Launch Board · 点击预览')
    expect(container.textContent).toContain('新应用 · 点击预览')
    expect(container.textContent).not.toContain('新Future Item')
    expect(container.textContent).toContain('RAW-FILE-A.txt')

    const toolCall = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('运行代码'))
    await act(async () => toolCall!.click())
    const nestedToolCall = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button !== toolCall && button.textContent?.includes('运行代码'))
    await act(async () => nestedToolCall!.click())
    expect(container.textContent).toContain('代码')
    expect(container.textContent).toContain('结果')
    expect(container.textContent).toContain('TOOL RESPONSE VERBATIM')

    expect(container.textContent).toContain('CONNECTOR ACTION TITLE VERBATIM')
    expect(container.textContent).toContain('CONNECTOR ACTION BODY VERBATIM')
    expect(container.textContent).toContain('RESOURCE TITLE VERBATIM')
    const approve = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === '批准')
    await act(async () => approve!.click())
    expect(approveAction).toHaveBeenCalledWith(42)

    expect(container.textContent).toContain('连接 VENDOR NAME VERBATIM')
    expect(container.textContent).toContain('CONNECTION SCOPE VERBATIM')
    expect(container.textContent).toContain('CONNECTION REASON VERBATIM')
    expect(container.textContent).toContain('设置')
    const setUp = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === '设置')
    const denyConnection = [...setUp!.parentElement!.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === '拒绝')
    await act(async () => denyConnection!.click())
    expect(denyConnectionRequest).toHaveBeenCalledWith('request-1')

    expect(container.textContent).toContain('错误：RAW DIAGNOSTIC VERBATIM')
    expect(container.textContent).toContain('错误：额度已用完。')
    expect(container.textContent).toContain('继续')
    expect(container.textContent).not.toContain('RAW USAGE LIMIT DETAIL VERBATIM')
    const usageError = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('额度已用完'))
    await act(async () => usageError!.click())
    expect(container.textContent).toContain('RAW USAGE LIMIT DETAIL VERBATIM')
    expect(container.textContent).toContain('待处理的更改')
    expect(container.textContent).toContain('接受更改')
    const discard = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === '放弃…')
    await act(async () => discard!.click())
    expect(document.body.textContent).toContain('放弃所有待处理的更改？')
    expect(document.body.textContent).toContain('待处理的更改无法恢复。')
    expect(document.body.textContent).toContain('取消')
    const confirmDiscard = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === '放弃更改')
    await act(async () => confirmDiscard!.click())
    expect(revertChanges).toHaveBeenCalledWith(7, 0)
    expect(container.textContent).toContain('RESULT TITLE VERBATIM')
    const result = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('RESULT TITLE VERBATIM'))
    await act(async () => result!.click())
    expect(onOpenGadget).toHaveBeenCalledWith(11)
  }, 15_000)

  it('localizes the Chinese conversation list and formats its time and cost', async () => {
    window.history.replaceState({}, '', '/zh/workspace/7')
    const now = new Date()
    const disposable = { [Symbol.dispose]: vi.fn<() => void>() }
    const overseer = {
      subscribeToChat: () => disposable,
      subscribeToActions: async (subscriber: ActionsSubscriber) => {
        subscriber.ready()
        return disposable
      },
      listChats: async () => [{
        id: 8,
        title: 'LIST TITLE VERBATIM',
        started: now,
        lastActive: now,
        hasProposedChanges: true,
        spawnerName: 'AGENT SPAWNER VERBATIM',
        totalCost: 0.1234,
      }],
      listModels: async () => [AGENT],
      listSlashCommands: async () => [],
    } as unknown as RpcStub<Overseer>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ChatInterface
        workspaceId="workspace-8"
        overseer={overseer}
        selectedChatId={null}
        onNavigateToChat={() => {}}
        pendingConsoleLogCount={0}
        consoleLogPreview=""
        consoleLogSeverity="info"
        onConsumeConsoleLogs={() => ''}
        onDiscardConsoleLogs={() => {}}
        onOpenGadget={() => {}}
        outputOfWorkpiece={() => undefined}
      />,
    ))

    expect(container.querySelector('[aria-label="筛选对话"]')).not.toBeNull()
    expect(container.textContent).toContain('全部对话')
    expect(container.textContent).toContain('今天')
    expect(container.textContent).toContain('LIST TITLE VERBATIM')
    expect(container.textContent).toContain('智能体 · AGENT SPAWNER VERBATIM')
    expect(container.textContent).toContain('待处理的更改')
    expect(container.textContent).toContain(new Intl.NumberFormat('zh', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    }).format(0.1234))
  })

  it('keeps the complete response, approval, connection, and result journey usable in English', async () => {
    window.history.replaceState({}, '', '/en/workspace/7')
    const approveAction = vi.fn<(actionId: number) => Promise<void>>(async () => {})
    const denyConnectionRequest = vi.fn<(requestId: string) => Promise<void>>(async () => {})
    const onOpenGadget = vi.fn<(gadgetId: number) => void>()
    const disposable = { [Symbol.dispose]: vi.fn<() => void>() }
    const overseer = {
      subscribeToChat: () => disposable,
      subscribeToActions: async (subscriber: ActionsSubscriber) => {
        subscriber.ready()
        return disposable
      },
      listChats: async () => [{
        id: 7,
        title: 'CONVERSATION TITLE VERBATIM',
        started: AT,
        lastActive: AT,
        hasProposedChanges: true,
      }],
      listModels: async () => [AGENT],
      listSlashCommands: async () => [],
      getChatHistory: async () => ({ messages }),
      approveAction,
      rejectAction: async () => {},
      denyConnectionRequest,
    } as unknown as RpcStub<Overseer>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ChatInterface
        workspaceId="workspace-7"
        overseer={overseer}
        selectedChatId={7}
        onNavigateToChat={stableNavigateToChat}
        pendingConsoleLogCount={0}
        consoleLogPreview=""
        consoleLogSeverity="info"
        onConsumeConsoleLogs={stableConsumeConsoleLogs}
        onDiscardConsoleLogs={stableDiscardConsoleLogs}
        onOpenGadget={onOpenGadget}
        outputOfWorkpiece={stableOutputOfWorkpiece}
      />,
    ))

    expect(container.textContent).toContain('USER CONTENT VERBATIM')
    expect(container.textContent).toContain('AGENT OUTPUT VERBATIM')
    expect(container.textContent).toContain('Ran code')
    expect(container.textContent).toContain('read 2 files')

    const approve = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === 'Approve')
    await act(async () => approve!.click())
    expect(approveAction).toHaveBeenCalledWith(42)

    expect(container.textContent).toContain('Connect VENDOR NAME VERBATIM')
    const setUp = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === 'Set up')
    const denyConnection = [...setUp!.parentElement!.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent === 'Deny')
    await act(async () => denyConnection!.click())
    expect(denyConnectionRequest).toHaveBeenCalledWith('request-1')

    expect(container.textContent).toContain('Error: You’re out of credits.')
    expect(container.textContent).toContain('Continue')
    expect(container.textContent).toContain('Pending changes')
    expect(container.textContent).toContain('Accept changes')
    expect(container.textContent).toContain('RESULT TITLE VERBATIM')
    const result = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('RESULT TITLE VERBATIM'))
    await act(async () => result!.click())
    expect(onOpenGadget).toHaveBeenCalledWith(11)

    window.history.replaceState({}, '', '/zh/workspace/7')
    await act(async () => root!.render(
      <ChatInterface
        workspaceId="workspace-7"
        overseer={overseer}
        selectedChatId={7}
        onNavigateToChat={stableNavigateToChat}
        pendingConsoleLogCount={0}
        consoleLogPreview=""
        consoleLogSeverity="info"
        onConsumeConsoleLogs={stableConsumeConsoleLogs}
        onDiscardConsoleLogs={stableDiscardConsoleLogs}
        onOpenGadget={onOpenGadget}
        outputOfWorkpiece={stableOutputOfWorkpiece}
      />,
    ))
    expect(container.textContent).toContain('运行代码')
    expect(container.textContent).toContain('读取了 2 个文件')
  })
})
