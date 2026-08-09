import { describe, expect, it } from 'vitest'
import english from '../messages/en.json'
import chinese from '../messages/zh.json'

const messageKeys = (catalog: Record<string, string>) =>
  Object.keys(catalog).filter(key => key !== '$schema').sort()

describe('message catalogs', () => {
  it('defines the same non-empty messages in English and Simplified Chinese', () => {
    expect(messageKeys(chinese)).toEqual(messageKeys(english))
    for (const key of messageKeys(english)) {
      expect(english[key as keyof typeof english]).not.toBe('')
      expect(chinese[key as keyof typeof chinese]).not.toBe('')
    }
  })
})
