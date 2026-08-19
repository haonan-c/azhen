// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RpcStub } from 'capnweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OutputFormatOffer, Overseer } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  addToast: vi.fn<(toast: unknown) => void>(),
  isAdmin: false,
  outputFormats: [] as OutputFormatOffer[],
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: testState.addToast }),
}))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: {}, isAdmin: testState.isAdmin }),
}))

vi.mock('./useVendorBranding', () => ({
  useVendorBranding: () => new Map(),
}))

vi.mock('./GatekeeperModal', () => ({ default: () => null }))

vi.mock('./components/format/useOutputFormats', () => ({
  useOutputFormats: () => ({
    formats: testState.outputFormats,
    creating: null,
    create: vi.fn<(format: OutputFormatOffer) => Promise<void>>(),
  }),
}))

import { ChatInput } from './ChatInterface'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (check()) return
    await act(async () => new Promise(resolve => setTimeout(resolve, 10)))
  }
  expect(check()).toBe(true)
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  setValue.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('localized Prompt Composer', () => {
  let container: HTMLDivElement
  let root: Root | undefined

  async function renderComposer(
    overrides: Partial<Parameters<typeof ChatInput>[0]> = {},
  ) {
    if (!root) {
      container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
    }
    const overseer = {
      listSlashCommands: async () => [],
    } as unknown as RpcStub<Overseer>
    const props = {
      createCapsuleGatekeeper: async () => null,
      getOverseer: () => overseer,
      onSend: () => {},
      isAgentActive: false,
      models: [],
      selectedModel: null,
      onModelChange: () => {},
      ...overrides,
    } satisfies Parameters<typeof ChatInput>[0]

    await act(async () => root!.render(<ChatInput {...props} />))
  }

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    window.history.replaceState({}, '', '/')
    testState.isAdmin = false
    testState.outputFormats = []
    vi.clearAllMocks()
  })

  it('localizes Chinese controls without changing prompt or model names', async () => {
    window.history.replaceState({}, '', '/zh')
    await renderComposer({
      models: [{ type: 'agent', id: 'model-1', name: 'Model 原名' }],
      selectedModel: 'model-1',
      newChat: true,
      seedText: '分析 Q3.csv',
      seedNonce: 1,
    })

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')
    expect(textarea?.placeholder).toBe('开始新对话…')
    expect(textarea?.value).toBe('分析 Q3.csv')
    expect(container.textContent).toContain('添加资源')
    expect(container.textContent).toContain('Model 原名')
    expect(container.querySelector('[aria-label="选择模型"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="发送消息"]')).not.toBeNull()
  })

  it('does not expose an internal model ID when the catalog is empty', async () => {
    window.history.replaceState({}, '', '/zh')
    await renderComposer({ selectedModel: 'internal-model-id' })

    expect(container.textContent).toContain('管理员尚未配置可用模型')
    expect(container.textContent).not.toContain('internal-model-id')
  })

  it('guides an administrator to deployment model configuration when the catalog is empty', async () => {
    window.history.replaceState({}, '', '/zh')
    testState.isAdmin = true
    await renderComposer()

    const modelMenu = container.querySelector<HTMLButtonElement>('[aria-label="选择模型"]')!
    await act(async () => modelMenu.click())
    expect(document.body.textContent).toContain('前往“管理员 → AI 模型”配置可用模型。')
  })

  it('localizes active-agent and chat-option states', async () => {
    window.history.replaceState({}, '', '/zh/workspace/one')
    await renderComposer({
      isAgentActive: true,
      onStop: () => {},
      onToggleThinkingTraces: () => {},
    })

    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.placeholder)
      .toBe('等待 Agent…')
    expect(container.querySelector('[aria-label="停止 Agent"]')).not.toBeNull()

    const options = container.querySelector<HTMLButtonElement>('[aria-label="打开对话选项"]')
    expect(options).not.toBeNull()
    await act(async () => options!.click())
    expect(document.body.textContent).toContain('隐藏思考过程')
    expect(document.body.textContent).toContain('上传文件')

    await renderComposer()
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.placeholder)
      .toBe('继续提问…')
  })

  it('localizes the attachment drop state', async () => {
    window.history.replaceState({}, '', '/zh')
    await renderComposer({ newChat: true })

    const promptCard = container.querySelector<HTMLElement>('.themed-prompt-card-shadow')!
    const dragEnter = new Event('dragenter', { bubbles: true, cancelable: true })
    Object.defineProperty(dragEnter, 'dataTransfer', { value: { types: ['Files'] } })
    await act(async () => promptCard.dispatchEvent(dragEnter))

    expect(container.textContent).toContain('拖放文件即可添加')
  })

  it('localizes attachment progress and errors while preserving technical details', async () => {
    window.history.replaceState({}, '', '/zh')
    let rejectUpload: ((reason: Error) => void) | undefined
    const uploadChatAttachment = vi.fn<(...args: unknown[]) => Promise<never>>(() => new Promise<never>((_resolve, reject) => {
      rejectUpload = reject
    }))
    const overseer = {
      listSlashCommands: async () => [],
      uploadChatAttachment,
    } as unknown as RpcStub<Overseer>

    await renderComposer({ getOverseer: () => overseer, newChat: true })

    const file = new File(['quarter,revenue'], 'Q3.csv', { type: 'text/csv' })
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new TextEncoder().encode('quarter,revenue').buffer,
    })
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    await waitFor(() => uploadChatAttachment.mock.calls.length === 1)
    expect(container.textContent).toContain('正在上传')

    await act(async () => rejectUpload!(new Error('S3 timed out')))
    await waitFor(() => container!.textContent?.includes('失败') === true)
    expect(testState.addToast).toHaveBeenCalledWith({
      title: '上传附件失败：S3 timed out',
      variant: 'error',
    })
  })

  it('localizes known attachment validation errors', async () => {
    window.history.replaceState({}, '', '/zh')
    await renderComposer({ newChat: true })

    const file = new File([new Uint8Array(1024 * 1024 + 1)], '原始文件.csv', {
      type: 'text/csv',
    })
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    await waitFor(() => testState.addToast.mock.calls.length === 1)

    expect(testState.addToast).toHaveBeenCalledWith({
      title: '附件大小不能超过 1 MB。',
      variant: 'error',
    })
  })

  it('localizes attachment count and pending-upload validation', async () => {
    window.history.replaceState({}, '', '/zh')
    const uploadChatAttachment = vi.fn<(...args: unknown[]) => Promise<never>>(
      () => new Promise<never>(() => {}),
    )
    const overseer = {
      listSlashCommands: async () => [],
      uploadChatAttachment,
    } as unknown as RpcStub<Overseer>

    await renderComposer({ getOverseer: () => overseer, newChat: true })

    const files = Array.from({ length: 6 }, (_unused, index) => {
      const file = new File(['value'], `原始文件-${index}.csv`, { type: 'text/csv' })
      Object.defineProperty(file, 'arrayBuffer', {
        value: async () => new TextEncoder().encode('value').buffer,
      })
      return file
    })
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', { configurable: true, value: files })
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    await waitFor(() => uploadChatAttachment.mock.calls.length === 5)
    expect(testState.addToast).toHaveBeenCalledWith({
      title: '仅添加了前 5 个附件',
      variant: 'error',
    })

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => setTextareaValue(textarea, '分析这些文件'))
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    })))
    expect(testState.addToast).toHaveBeenCalledWith({
      title: '请等待附件上传完成',
      variant: 'error',
    })
  })

  it('localizes captured-log actions', async () => {
    window.history.replaceState({}, '', '/zh')
    await renderComposer({ pendingConsoleLogCount: 2, consoleLogSeverity: 'error' })

    expect(container.textContent).toContain('向对话发送 2 条捕获的错误日志')
    expect(container.querySelector('[aria-label="丢弃捕获的日志"]')).not.toBeNull()
  })

  it('does not send unfinished Chinese IME text when Enter confirms a candidate', async () => {
    window.history.replaceState({}, '', '/zh')
    const onSend = vi.fn<(...args: unknown[]) => void>()
    await renderComposer({ onSend })

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => textarea.dispatchEvent(new CompositionEvent('compositionstart', {
      bubbles: true,
    })))
    await act(async () => setTextareaValue(textarea, 'nihao'))
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    })))
    expect(onSend).not.toHaveBeenCalled()

    await act(async () => textarea.dispatchEvent(new CompositionEvent('compositionend', {
      bubbles: true,
      data: '你好',
    })))
    await act(async () => setTextareaValue(textarea, '你好'))
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    })))
    expect(onSend).toHaveBeenCalledWith('你好', null, undefined, undefined, undefined)
  })

  it('does not send pre-composition text when Safari confirms an IME candidate', async () => {
    window.history.replaceState({}, '', '/zh')
    const onSend = vi.fn<(...args: unknown[]) => void>()
    await renderComposer({ onSend })

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => textarea.dispatchEvent(new CompositionEvent('compositionstart', {
      bubbles: true,
    })))
    await act(async () => setTextareaValue(textarea, 'nihao'))
    await act(async () => textarea.dispatchEvent(new CompositionEvent('compositionend', {
      bubbles: true,
      data: '你好',
    })))
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      isComposing: false,
    })
    Object.defineProperty(enter, 'keyCode', { value: 229 })
    await act(async () => textarea.dispatchEvent(enter))

    expect(onSend).not.toHaveBeenCalled()
  })

  it('sends a selected Chinese format with its localized reference', async () => {
    window.history.replaceState({}, '', '/zh')
    testState.outputFormats = [{
      blueprintId: 'format.document',
      description: 'Use to write documents.',
      output: { id: 'document', noun: 'Doc', plural: 'Docs', icon: 'fileText' },
      requiresSetup: false,
    }]
    const onSend = vi.fn<(...args: unknown[]) => void>()
    await renderComposer({ onSend, newChat: true, offerFormats: true })

    const options = container.querySelector<HTMLButtonElement>('[aria-label="打开对话选项"]')!
    await act(async () => options.click())
    const documentOption = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find(button => button.textContent?.includes('文档'))!
    await act(async () => documentOption.click())
    await waitFor(() => container!.querySelector<HTMLTextAreaElement>('textarea')?.value.includes('文档') === true)

    await act(async () => container!.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click())
    await waitFor(() => onSend.mock.calls.length === 1)
    expect(onSend).toHaveBeenCalledWith(
      'Doc',
      null,
      undefined,
      undefined,
      [{ position: 0, length: 3, noun: 'Doc', icon: 'fileText' }],
    )
  })
})
