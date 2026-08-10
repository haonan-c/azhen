// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdminApi, AdminFormat } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'

vi.mock('@cloudflare/kumo', () => {
  const DropdownMenu = Object.assign(
    ({ children }: { children: ReactNode }) => <>{children}</>,
    {
      Trigger: ({ render }: { render: ReactNode }) => <>{render}</>,
      Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Item: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    },
  )
  return {
    Button: ({ children, ...props }: ComponentProps<'button'>) => <button {...props}>{children}</button>,
    DropdownMenu,
    Input: (props: ComponentProps<'input'>) => <input {...props} />,
    Switch: ({ checked = false }: { checked?: boolean }) => (
      <button type="button" role="switch" aria-checked={checked} aria-label="format" />
    ),
    useKumoToastManager: () => ({ add: vi.fn<(toast: unknown) => void>() }),
  }
})
vi.mock('../../AuthContext', () => {
  const auth = {
    authenticatedApi: {
      listFeaturedBlueprints: async () => [{
        id: 'candidate',
        metadata: {
          title: 'BLUEPRINT TITLE 原样',
          output: { id: 'custom', noun: 'Campaign Deck', plural: 'Campaign Decks', icon: 'presentation' },
        },
      }],
      listOwnBlueprints: async () => [],
    },
  }
  return { useAuthenticatedApi: () => auth }
})

import AdminFormatsPanel from './AdminFormatsPanel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const formats: AdminFormat[] = [{
  blueprintId: 'promoted',
  blueprintTitle: 'PROMOTED BLUEPRINT 原样',
  blueprintDescription: 'BLUEPRINT DESCRIPTION 原样',
  output: { id: 'custom', noun: 'Campaign Deck', plural: 'Campaign Decks', icon: 'presentation' },
  declared: { id: 'custom', noun: 'Campaign Deck', plural: 'Campaign Decks', icon: 'presentation' },
  enabled: true,
  agentHint: 'ADMIN HINT 原样',
  missing: false,
  bundled: false,
}]

describe('standard format management localization', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.history.replaceState({}, '', '/')
    root = undefined
    container = undefined
  })

  it('localizes Chinese format management and keeps configured names unchanged', async () => {
    window.history.replaceState({}, '', '/zh/admin')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <AdminFormatsPanel
        admin={{} as RpcStub<AdminApi>}
        formats={formats}
        onChanged={async () => {}}
      />,
    ))

    await vi.waitFor(() => expect(container?.textContent).toContain('BLUEPRINT TITLE 原样'))
    expect(container?.textContent).toContain('标准格式')
    expect(container?.textContent).toContain('用户将看到的内容')
    expect(container?.textContent).toContain('推广模板')
    expect(container?.textContent).toContain('新建Campaign Deck')
    expect(container?.textContent).toContain('PROMOTED BLUEPRINT 原样')
    expect(container?.textContent).toContain('BLUEPRINT TITLE 原样')
    expect(container?.textContent).toContain('Campaign Decks')
  })
})
