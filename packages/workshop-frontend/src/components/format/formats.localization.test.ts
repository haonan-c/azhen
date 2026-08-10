// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import type { BlueprintOutput } from '@gadgets/workshop-shared/api'
import { formatNoun, formatPlural } from './formats'

const futureFormat: BlueprintOutput = {
  id: 'future-format',
  noun: 'Future Item',
  plural: 'Future Items',
  icon: 'futureIcon' as BlueprintOutput['icon'],
}

describe('output format localization', () => {
  afterEach(() => window.history.replaceState({}, '', '/'))

  it('localizes the generic fallback when a cached client does not know the format icon', () => {
    window.history.replaceState({}, '', '/zh/outputs')
    expect(formatNoun(futureFormat)).toBe('应用')
    expect(formatPlural(futureFormat)).toBe('应用')

    window.history.replaceState({}, '', '/en/outputs')
    expect(formatNoun(futureFormat)).toBe('App')
    expect(formatPlural(futureFormat)).toBe('Apps')
  })
})
