// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenGadgetError, OPEN_GADGET_ERROR_CODES } from '@gadgets/workshop-shared/api'
import type { OpenGadgetObserverFailure } from '@gadgets/workshop-shared/api'
import WorkspaceOpenErrorPage, { classifyWorkspaceOpenFailure } from './WorkspaceOpenErrorPage'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

vi.mock('./WorkshopControls', () => ({
  WorkshopButton: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}))

describe('WorkspaceOpenErrorPage', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    window.history.replaceState({}, '', '/')
    root = undefined
    container = undefined
  })

  async function render(
    kind: 'access-denied' | 'not-found' | 'observer-accounts-required'
      | 'observer-verification-failed' | 'unexpected',
    details?: OpenGadgetObserverFailure[],
  ) {
    const onRetry = vi.fn<() => void>()
    const onGoToWorkspaces = vi.fn<() => void>()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <WorkspaceOpenErrorPage
        kind={kind}
        details={details}
        onRetry={onRetry}
        onGoToWorkspaces={onGoToWorkspaces}
      />,
    ))
    return { container, onGoToWorkspaces, onRetry }
  }

  it('explains how to recover when access is denied without exposing workspace metadata', async () => {
    const { container: renderedContainer, onGoToWorkspaces, onRetry } = await render('access-denied')

    expect(renderedContainer.querySelector('h1')?.textContent).toBe("You don't have access to this workspace")
    expect(renderedContainer.textContent).toContain('Ask the workspace owner to grant you access, then try again.')
    expect(document.activeElement).toBe(renderedContainer.querySelector('h1'))

    const buttons = [...renderedContainer.querySelectorAll('button')]
    expect(buttons.map(button => button.textContent)).toEqual(['Go to workspaces', 'Try again'])
    act(() => buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    act(() => buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onGoToWorkspaces).toHaveBeenCalledOnce()
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('gives a missing workspace a distinct, non-retryable state', async () => {
    const { container: renderedContainer } = await render('not-found')

    expect(renderedContainer.querySelector('h1')?.textContent).toBe('Workspace not found')
    expect(renderedContainer.textContent).toContain('The link may be incorrect, or the workspace may have been deleted.')
    expect([...renderedContainer.querySelectorAll('button')].map(button => button.textContent))
      .toEqual(['Go to workspaces'])
  })

  it('localizes access denial without exposing or changing workspace metadata', async () => {
    window.history.replaceState({}, '', '/zh/workspace/private-campaign')

    const { container: renderedContainer } = await render('access-denied')

    expect(renderedContainer.querySelector('h1')?.textContent).toBe('你没有访问此工作空间的权限')
    expect(renderedContainer.textContent).toContain('请让工作空间所有者授予你权限，然后重试。')
    expect([...renderedContainer.querySelectorAll('button')].map(button => button.textContent))
      .toEqual(['前往工作空间', '重试'])
    expect(renderedContainer.textContent).not.toContain('private-campaign')
  })

  it('keeps unexpected failures retryable', async () => {
    const { container: renderedContainer } = await render('unexpected')

    expect(renderedContainer.querySelector('h1')?.textContent).toBe("We couldn't load this workspace")
    expect(renderedContainer.textContent).toContain('Try again. If the problem continues, return to your workspaces.')
    expect([...renderedContainer.querySelectorAll('button')].map(button => button.textContent))
      .toEqual(['Go to workspaces', 'Try again'])
  })

  it('localizes observer verification failures while preserving vendor details', async () => {
    window.history.replaceState({}, '', '/zh/workspace/shared-campaign')

    const { container: renderedContainer } = await render(
      'observer-verification-failed',
      [{
        resourceTitle: 'RESOURCE TITLE VERBATIM',
        accountLabel: 'ACCOUNT LABEL VERBATIM',
        reason: 'VENDOR DETAIL VERBATIM',
      }],
    )

    expect(renderedContainer.querySelector('h1')?.textContent).toBe('无法验证工作空间连接')
    expect(renderedContainer.textContent).toContain('请修复以下连接问题，然后重试。')
    expect(renderedContainer.textContent).toContain('RESOURCE TITLE VERBATIM')
    expect(renderedContainer.textContent).toContain('ACCOUNT LABEL VERBATIM')
    expect(renderedContainer.textContent).toContain('VENDOR DETAIL VERBATIM')
  })

  it('classifies stable open error codes without treating unexpected errors as expected', () => {
    expect(classifyWorkspaceOpenFailure(
      createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied),
    )).toBe('access-denied')
    expect(classifyWorkspaceOpenFailure(
      createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceNotFound),
    )).toBe('not-found')
    expect(classifyWorkspaceOpenFailure(
      createOpenGadgetError(OPEN_GADGET_ERROR_CODES.observerAccountsRequired),
    )).toBe('observer-accounts-required')
    expect(classifyWorkspaceOpenFailure(
      createOpenGadgetError(OPEN_GADGET_ERROR_CODES.observerVerificationFailed),
    )).toBe('observer-verification-failed')
    expect(classifyWorkspaceOpenFailure(
      new Error(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied),
    )).toBe('unexpected')
    expect(classifyWorkspaceOpenFailure(new Error('storage unavailable'))).toBe('unexpected')
  })
})
