// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => {
  const overseer = {
    newChat: vi.fn<(...args: unknown[]) => Promise<number>>(async () => 7),
    getMetadata: vi.fn<() => Promise<{ id: string }>>(async () => ({ id: 'workspace-1' })),
    [Symbol.dispose]: vi.fn<() => void>(),
  }
  return {
    authenticatedApi: {
      listModels: async () => [],
      newGadget: vi.fn<() => typeof overseer>(() => overseer),
    },
    navigate: vi.fn<(options: unknown) => void>(),
    onSend: undefined as undefined | ((message: string, modelId: string | null) => Promise<void>),
    seedText: '',
  }
})

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => testState.navigate,
}))

vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
}))

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: testState.authenticatedApi,
  }),
}))

vi.mock('./ChatInterface', () => ({
  ChatInput: ({
    onSend,
    seedText = '',
  }: {
    onSend: (message: string, modelId: string | null) => Promise<void>
    seedText?: string
  }) => {
    testState.onSend = onSend
    testState.seedText = seedText
    return <textarea aria-label="Prompt" readOnly value={seedText} />
  },
}))

vi.mock('./components/MeshBackground', () => ({ default: () => null }))

import { HomePageContent } from './routes/index'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('localized Workshop Home', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.sessionStorage.clear()
    window.history.replaceState({}, '', '/')
    document.title = ''
    testState.onSend = undefined
    testState.seedText = ''
    vi.clearAllMocks()
    vi.restoreAllMocks()
    root = undefined
    container = undefined
  })

  async function render(path: string) {
    window.history.replaceState({}, '', path)
    vi.spyOn(Math, 'random').mockReturnValue(0.999)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<HomePageContent />))
  }

  it('renders the English Home surface', async () => {
    await render('/')

    expect(container?.textContent).toContain('What are we working on?')
    expect(container?.textContent).toContain('Ask a question, create an output')
    expect(container?.textContent).toContain('Get started')
    expect(container?.querySelector('[aria-label="Example tasks"]')).not.toBeNull()
    expect(document.title).toBe('Home - UGC Angle')
  })

  it('restores the selected anonymous Ad Angle as the first-workspace prompt', async () => {
    window.sessionStorage.setItem('ugc-angle.anonymous-angle-run.v1', JSON.stringify({
      version: 1,
      locale: 'en',
      product: 'Quiet fan',
      market: 'Remote workers',
      angles: [
        {
          name: 'The meeting mute test',
          tension: 'Desk fans interrupt calls.',
          hypothesis: 'A silent demo makes the benefit credible.',
          openingHook: 'Can you hear the fan?',
          worthTesting: 'It demonstrates the claim in context.',
        },
        {
          name: 'A cooler desk',
          tension: 'Small offices get warm.',
          hypothesis: 'A compact product fits the workspace.',
          openingHook: 'My desk changed one degree at a time.',
          worthTesting: 'It makes the setting familiar.',
        },
        {
          name: 'No more headset sweat',
          tension: 'Long calls become uncomfortable.',
          hypothesis: 'Visible relief creates desire.',
          openingHook: 'This is my fifth call today.',
          worthTesting: 'It starts with a known frustration.',
        },
      ],
      selectedIndex: 0,
    }))

    await render('/')

    expect(testState.seedText).toContain('Quiet fan')
    expect(testState.seedText).toContain('Remote workers')
    expect(testState.seedText).toContain('The meeting mute test')
    expect(testState.seedText).toContain('Can you hear the fan?')
    expect(testState.seedText).toContain('A cooler desk')
    expect(testState.seedText).toContain('My desk changed one degree at a time.')
    expect(testState.seedText).toContain('No more headset sweat')
    expect(testState.seedText).toContain('This is my fifth call today.')
    expect(testState.seedText).toContain('ready-to-shoot UGC script')

    await act(async () => testState.onSend!('Start a different task', null))

    expect(window.sessionStorage.getItem('ugc-angle.anonymous-angle-run.v1')).not.toBeNull()

    await act(async () => testState.onSend!(testState.seedText, null))

    expect(window.sessionStorage.getItem('ugc-angle.anonymous-angle-run.v1')).toBeNull()
    expect(testState.navigate).toHaveBeenCalledWith({
      to: '/workspace/$id',
      params: { id: 'workspace-1' },
      search: { chat: 7 },
    })
  })

  it('renders Chinese task suggestions and seeds the localized prompt', async () => {
    await render('/zh')

    expect(container?.textContent).toContain('今天要处理什么？')
    expect(container?.textContent).toContain('提出问题、创建成果')
    expect(container?.textContent).toContain('开始使用')
    expect(container?.textContent).toContain('撰写一对一会前材料')
    expect(container?.textContent).toContain('制作团队会议演示文稿')
    expect(container?.textContent).toContain('从数据中发现洞察')
    expect(container?.querySelector('[aria-label="任务示例"]')).not.toBeNull()
    expect(document.title).toBe('首页 - UGC Angle')

    const suggestion = [...container!.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('撰写一对一会前材料'))!
    await act(async () => suggestion.click())

    expect(testState.seedText).toBe(
      '创建一份文档，帮助我准备下一次与直属成员的一对一会议，包括当前情况、辅导思路、需要关注的事项、上次遗留事项和一个明确诉求。',
    )
  })
})
