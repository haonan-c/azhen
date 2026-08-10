// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, GadgetMetadata, Overseer } from '@gadgets/workshop-shared/api'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to: _to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a {...props}>{children}</a>
  ),
}))
vi.mock('./GadgetUI', () => ({ default: () => <div>用户应用内容</div> }))
vi.mock('./components/UserMenu', () => ({ default: () => null }))
vi.mock('./components/GadgetPresence', () => ({ GadgetPresence: () => null }))
vi.mock('./TopBarNotice', () => ({ default: () => null }))
vi.mock('./components/SiteLogo', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('./GadgetExportMenu', () => ({ default: () => null }))

import GadgetUseView from './GadgetUseView'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('GadgetUseView localization', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.history.replaceState({}, '', '/')
    root = undefined
    container = undefined
  })

  it('localizes the restricted app view while preserving workspace and owner names', async () => {
    window.history.replaceState({}, '', '/zh/workspace/campaign')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root!.render(
      <GadgetUseView
        overseer={{} as RpcStub<Overseer>}
        gadget={null}
        selectedGadgetId={null}
        gadgets={[]}
        onSelectGadget={vi.fn<(id: number) => void>()}
        metadata={{
          id: 'campaign',
          title: 'Campaign workspace',
          owner: { type: 'user', id: 'ada@example.com', name: 'Ada Lovelace' },
        } as GadgetMetadata}
        authenticatedApi={{} as RpcStub<AuthenticatedApi>}
        currentUserId="viewer@example.com"
      />,
    ))

    expect(container.querySelector('[aria-label="首页"]')).not.toBeNull()
    expect(container.textContent).toContain('Campaign workspace')
    expect(container.textContent).toContain('由 Ada Lovelace 创建')
    expect(container.textContent).toContain('此工作空间还没有应用。')
    expect(container.textContent).not.toContain('This workspace has no gadgets yet.')
  })
})
