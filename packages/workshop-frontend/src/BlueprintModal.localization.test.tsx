// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { GadgetClient, GadgetMetadata, Overseer } from '@gadgets/workshop-shared/api'

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cloudflare/kumo')>()
  return {
    ...actual,
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})

import BlueprintModal from './BlueprintModal'
import { BlueprintBindingCard } from './components/BlueprintBindingCard'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('BlueprintModal localization', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.history.replaceState({}, '', '/')
    root = undefined
    container = undefined
  })

  it('localizes app template management while preserving creator-authored details', async () => {
    window.history.replaceState({}, '', '/zh/workspace/campaign')
    const overseer = {
      listBlueprints: async () => [{
        id: 'campaign-template',
        title: 'Summer Campaign Kit',
        description: 'Keep this creator-authored description.',
        version: 3,
        codeVersionDate: new Date('2026-08-10T00:00:00Z'),
      }],
    } as unknown as RpcStub<Overseer>
    const gadget = {
      listBindings: async () => [],
    } as unknown as RpcStub<GadgetClient>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <BlueprintModal
        open
        onClose={() => {}}
        overseer={overseer}
        gadget={gadget}
        metadata={{ id: 'campaign', title: 'Campaign workspace' } as GadgetMetadata}
      />,
    ))

    await vi.waitFor(() => expect(document.body.textContent).toContain('Summer Campaign Kit'))
    expect(document.body.textContent).toContain('模板')
    expect(document.body.textContent).toContain('将此应用变成可复用的起点。')
    expect(document.body.textContent).toContain('创建模板')
    expect(document.body.textContent).toContain('现有模板')
    expect(document.body.textContent).toContain('Keep this creator-authored description.')
    expect(document.body.querySelector('[aria-label="编辑模板"]')).not.toBeNull()
    expect(document.body.querySelector('[aria-label="删除模板"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain('Existing blueprints')

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="编辑模板"]')?.click()
    })
    expect(document.body.textContent).toContain('更新此模板的详细信息、截图和连接说明。')
    expect(document.body.textContent).not.toContain('安全连接器')
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent?.includes('返回'))
        ?.click()
    })

    const create = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('创建模板'))
    await act(async () => create?.click())

    await vi.waitFor(() => expect(document.body.querySelector('[aria-label="模板标题"]')).not.toBeNull())
    expect(document.body.querySelector<HTMLInputElement>('[aria-label="模板标题"]')?.value)
      .toBe('Campaign workspace')
    expect(document.body.querySelector('[aria-label="模板描述"]')).not.toBeNull()
    expect(document.body.textContent).toContain('说明用户从此模板开始时会得到什么。')
    expect(document.body.textContent).toContain('截图')
    expect(document.body.textContent).toContain('返回')
  })

  it('uses generic connection language for an AI model binding', async () => {
    window.history.replaceState({}, '', '/zh/workspace/campaign')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(
      <BlueprintBindingCard
        data={{
          bindingName: 'writerModel',
          resourceTitle: 'Claude Sonnet',
          creationSpec: {
            type: 'aiModel',
            modelId: 'model-1',
          },
          annotation: { title: '', description: '', suggestValue: false },
        }}
        onChange={() => {}}
      />,
    ))

    expect(container.querySelector('[placeholder="连接名称"]')).not.toBeNull()
    expect(container.textContent).not.toContain('安全连接器')
    expect(container.textContent).toContain('Claude Sonnet')
  })

  it('keeps English RPC errors out of Chinese template management', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    window.history.replaceState({}, '', '/zh/workspace/campaign')
    const overseer = {
      listBlueprints: async () => [],
    } as unknown as RpcStub<Overseer>
    const gadget = {
      listBindings: async () => [],
      createBlueprint: async () => { throw new Error('Backend denied the blueprint request.') },
    } as unknown as RpcStub<GadgetClient>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <BlueprintModal
        open
        onClose={() => {}}
        overseer={overseer}
        gadget={gadget}
        metadata={{ id: 'campaign', title: 'Campaign workspace' } as GadgetMetadata}
      />,
    ))

    await vi.waitFor(() => expect(document.body.textContent).toContain('创建模板'))
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent?.includes('创建模板'))
        ?.click()
    })
    await vi.waitFor(() => expect(document.body.querySelector('[aria-label="模板标题"]')).not.toBeNull())
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent?.trim() === '创建')
        ?.click()
    })

    await vi.waitFor(() => expect(document.body.textContent).toContain('无法创建模板。'))
    expect(document.body.textContent).not.toContain('Backend denied the blueprint request.')
    consoleError.mockRestore()
  })
})
