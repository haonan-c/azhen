// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { formatFullTimestamp } from './formatTimestamp'

describe('formatFullTimestamp', () => {
  afterEach(() => window.history.replaceState({}, '', '/'))

  it('uses the active application locale and updates after the locale changes', () => {
    const date = new Date('2026-08-10T12:34:00Z')

    window.history.replaceState({}, '', '/en/workspace/7')
    const english = formatFullTimestamp(date)

    window.history.replaceState({}, '', '/zh/workspace/7')
    const chinese = formatFullTimestamp(date)

    expect(english).not.toBe(chinese)
    expect(chinese).toMatch(/2026/)
  })
})
