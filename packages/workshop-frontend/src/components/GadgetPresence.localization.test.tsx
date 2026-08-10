// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi,
  Overseer,
  PresenceParticipant,
  PresenceSubscriber,
} from '@gadgets/workshop-shared/api'

vi.mock('@cloudflare/kumo', () => {
  const Popover = Object.assign(
    ({ children }: { children: ReactNode }) => <>{children}</>,
    {
      Trigger: ({ render }: { render: ReactElement }) => render,
      Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    },
  )
  return {
    Popover,
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  }
})

vi.mock('./PersonAvatar', () => ({
  PersonAvatar: ({ name }: { name: string }) => <span>{name.slice(0, 1)}</span>,
}))

import { GadgetPresence } from './GadgetPresence'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('GadgetPresence localization', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.history.replaceState({}, '', '/')
    root = undefined
    container = undefined
  })

  it('localizes live collaborator status while preserving collaborator names', async () => {
    window.history.replaceState({}, '', '/zh/workspace/campaign')
    const participant: PresenceParticipant = {
      key: 'ada-session',
      user: { type: 'user', id: 'ada@example.com', name: 'Ada Lovelace' },
      role: 'build',
    }
    const overseer = {
      subscribeToPresence: async (subscriber: RpcStub<PresenceSubscriber>) => {
        await subscriber.init([participant])
        return { [Symbol.dispose]: () => {} }
      },
    } as unknown as RpcStub<Overseer>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <GadgetPresence
        overseer={overseer}
        authenticatedApi={{} as RpcStub<AuthenticatedApi>}
        currentUserId="owner@example.com"
      />,
    ))

    await vi.waitFor(() => expect(container?.textContent).toContain('Ada Lovelace'))
    expect(container.querySelector('[aria-label="1 人正在查看此工作空间"]')).not.toBeNull()
    expect(container.textContent).toContain('当前有 1 人')
    expect(container.textContent).toContain('工作空间')
    expect(container.textContent).not.toContain('1 person here now')
  })
})
