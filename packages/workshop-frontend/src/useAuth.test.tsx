// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RpcStub } from 'capnweb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PublicApi } from '@gadgets/workshop-shared/api'
import { useAuth } from './useAuth'
import {
  AUTH_TEST_USER,
  createAuthenticatedApi,
  createPublicApi,
  deferred,
} from './authTestHelpers'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type AuthPhase = 'pending' | 'retry' | 'authenticated' | 'signed-out'

function AuthProbe({
  api,
  onCommit,
}: {
  api: RpcStub<PublicApi>
  onCommit?: (api: RpcStub<PublicApi>, phase: AuthPhase) => void
}) {
  const auth = useAuth(api)
  const phase: AuthPhase = auth.isLoading
    ? 'pending'
    : auth.error
      ? 'retry'
      : auth.isAuthenticated
        ? 'authenticated'
        : 'signed-out'

  useLayoutEffect(() => {
    onCommit?.(api, phase)
  }, [api, onCommit, phase])

  return (
    <>
      <p data-state>{phase}</p>
      <button type="button" onClick={auth.retry}>retry</button>
      <button type="button" onClick={() => auth.login('replacement-token')}>replace</button>
    </>
  )
}

describe('useAuth stored-session validation', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    localStorage.clear()
    vi.restoreAllMocks()
    root = undefined
    container = undefined
  })

  async function render(
    api: RpcStub<PublicApi>,
    onCommit?: (api: RpcStub<PublicApi>, phase: AuthPhase) => void,
  ) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<AuthProbe api={api} onCommit={onCommit} />))
  }

  async function rerender(
    api: RpcStub<PublicApi>,
    onCommit?: (api: RpcStub<PublicApi>, phase: AuthPhase) => void,
  ) {
    await act(async () => root!.render(<AuthProbe api={api} onCommit={onCommit} />))
  }

  function state() {
    return container?.querySelector('[data-state]')?.textContent
  }

  it('resolves to signed out without an authentication request when no token is stored', async () => {
    const api = createPublicApi(() => { throw new Error('unexpected authentication') })

    await render(api)

    expect(state()).toBe('signed-out')
    expect(api.authenticate).not.toHaveBeenCalled()
  })

  it('keeps a neutral pending state until the stored token identity check succeeds', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const identity = deferred<typeof AUTH_TEST_USER>()
    const authenticated = createAuthenticatedApi(() => identity.promise)
    const api = createPublicApi(() => authenticated.stub)

    await render(api)

    expect(state()).toBe('pending')
    expect(api.authenticate).toHaveBeenCalledWith('stored-token')

    await act(async () => identity.resolve(AUTH_TEST_USER))

    expect(state()).toBe('authenticated')
    expect(authenticated.dispose).not.toHaveBeenCalled()
  })

  it('clears a confirmed invalid token and disposes its authentication capability', async () => {
    localStorage.setItem('authToken', 'invalid-token')
    const authenticated = createAuthenticatedApi(async () => {
      throw new Error('invalid session token')
    })
    const api = createPublicApi(() => authenticated.stub)

    await render(api)

    expect(state()).toBe('signed-out')
    expect(localStorage.getItem('authToken')).toBeNull()
    expect(authenticated.dispose).toHaveBeenCalledOnce()
  })

  it('preserves the token after a transient failure and can retry validation', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const failed = createAuthenticatedApi(async () => { throw new Error('connection lost') })
    const recovered = createAuthenticatedApi(async () => AUTH_TEST_USER)
    const api = createPublicApi(vi.fn()
      .mockReturnValueOnce(failed.stub)
      .mockReturnValueOnce(recovered.stub))

    await render(api)

    expect(state()).toBe('retry')
    expect(localStorage.getItem('authToken')).toBe('stored-token')
    expect(failed.dispose).toHaveBeenCalledOnce()

    await act(async () => {
      container!.querySelector<HTMLButtonElement>('button')!.click()
    })

    expect(state()).toBe('authenticated')
    expect(api.authenticate).toHaveBeenNthCalledWith(2, 'stored-token')
  })

  it('does not retain a capability from an obsolete validation attempt', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const obsoleteIdentity = deferred<typeof AUTH_TEST_USER>()
    const obsolete = createAuthenticatedApi(() => obsoleteIdentity.promise)
    const replacement = createAuthenticatedApi(async () => AUTH_TEST_USER)
    const api = createPublicApi(vi.fn()
      .mockReturnValueOnce(obsolete.stub)
      .mockReturnValueOnce(replacement.stub))

    await render(api)
    await act(async () => {
      container!.querySelectorAll<HTMLButtonElement>('button')[1].click()
    })

    expect(state()).toBe('authenticated')
    expect(obsolete.dispose).toHaveBeenCalledOnce()

    await act(async () => obsoleteIdentity.resolve(AUTH_TEST_USER))

    expect(state()).toBe('authenticated')
    expect(obsolete.dispose).toHaveBeenCalledOnce()
    expect(replacement.dispose).not.toHaveBeenCalled()
  })

  it('disposes the previous capability and validates again when the RPC session changes', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const previous = createAuthenticatedApi(async () => AUTH_TEST_USER)
    const previousApi = createPublicApi(() => previous.stub)
    const commits: Array<{ api: RpcStub<PublicApi>, phase: AuthPhase }> = []
    const recordCommit = (api: RpcStub<PublicApi>, phase: AuthPhase) => {
      commits.push({ api, phase })
    }
    await render(previousApi, recordCommit)
    expect(state()).toBe('authenticated')

    const nextIdentity = deferred<typeof AUTH_TEST_USER>()
    const next = createAuthenticatedApi(() => nextIdentity.promise)
    const nextApi = createPublicApi(() => next.stub)
    commits.length = 0
    await rerender(nextApi, recordCommit)

    expect(commits[0]).toEqual({ api: nextApi, phase: 'pending' })
    expect(commits).not.toContainEqual({ api: nextApi, phase: 'authenticated' })
    expect(state()).toBe('pending')
    expect(previous.dispose).toHaveBeenCalledOnce()

    await act(async () => nextIdentity.resolve(AUTH_TEST_USER))
    expect(state()).toBe('authenticated')
  })

  it('disposes the authentication capability when the component unmounts', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const authenticated = createAuthenticatedApi(async () => AUTH_TEST_USER)
    const api = createPublicApi(() => authenticated.stub)

    await render(api)
    act(() => root!.unmount())
    root = undefined

    expect(authenticated.dispose).toHaveBeenCalledOnce()
  })
})
