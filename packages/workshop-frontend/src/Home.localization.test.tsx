// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  authenticatedApi: {
    listModels: async () => [],
    getPreferredModel: async () => null,
    setPreferredModel: async () => {},
    newGadget: vi.fn<() => void>(),
  },
  navigate: vi.fn<(options: unknown) => void>(),
  seedText: '',
}))

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
  ChatInput: ({ seedText = '' }: { seedText?: string }) => {
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
    window.history.replaceState({}, '', '/')
    document.title = ''
    testState.seedText = ''
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
    expect(document.title).toBe('Home - azhen')
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
    expect(document.title).toBe('首页 - 阿珍')

    const suggestion = [...container!.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('撰写一对一会前材料'))!
    await act(async () => suggestion.click())

    expect(testState.seedText).toBe(
      '创建一份文档，帮助我准备下一次与直属成员的一对一会议，包括当前情况、辅导思路、需要关注的事项、上次遗留事项和一个明确诉求。',
    )
  })
})
