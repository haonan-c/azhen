// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./main', () => ({ markConnectionRestored: vi.fn<() => void>() }))

import { createRouter } from './router'

describe('localized shell navigation', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/')
  })

  it.each([
    ['/workspaces', '/zh/workspaces'],
    ['/blueprints', '/zh/blueprints'],
    ['/outputs', '/zh/outputs'],
  ] as const)('keeps the Chinese locale when navigating to %s', async (to, expected) => {
    window.history.replaceState({}, '', '/zh')
    const router = createRouter()
    await router.load()

    await router.navigate({ to })

    expect(window.location.pathname).toBe(expected)
  })
})
