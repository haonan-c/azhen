import type { RpcStub } from 'capnweb'
import { vi } from 'vitest'
import type { AiChatAuthorInfo, AuthenticatedApi, PublicApi } from '@gadgets/workshop-shared/api'

export const AUTH_TEST_USER: AiChatAuthorInfo = {
  type: 'user',
  id: 'user-1',
  name: 'Test user',
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

export function createAuthenticatedApi(whoami: () => Promise<AiChatAuthorInfo>) {
  const dispose = vi.fn<() => void>()
  const stub = {
    whoami,
    isOnboardingCompleted: async () => true,
    [Symbol.dispose]: dispose,
  } as unknown as RpcStub<AuthenticatedApi>
  return { stub, dispose }
}

export function createPublicApi(authenticate: (token: string) => RpcStub<AuthenticatedApi>) {
  return {
    authenticate: vi.fn<(token: string) => RpcStub<AuthenticatedApi>>(authenticate),
  } as unknown as RpcStub<PublicApi>
}
