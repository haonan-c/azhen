// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { OBSERVER_BINDING_FAILURE_CODES } from '@gadgets/workshop-shared/api'
import { presentObserverFailureReason } from './observer-failure-presentation'

describe('presentObserverFailureReason', () => {
  afterEach(() => window.history.replaceState({}, '', '/'))

  it.each([
    ['/workspace/campaign', 'This account is no longer connected.'],
    ['/zh/workspace/campaign', '此账户已断开连接。'],
  ])('uses the active catalog for a known Workshop reason at %s', (path, expected) => {
    window.history.replaceState({}, '', path)

    expect(presentObserverFailureReason({
      accountId: 7,
      reason: 'BACKWARDS-COMPATIBLE FALLBACK',
      reasonCode: OBSERVER_BINDING_FAILURE_CODES.accountDisconnected,
    })).toBe(expected)
  })

  it.each(['/workspace/campaign', '/zh/workspace/campaign'])(
    'preserves Gatekeeper and Vendor text at %s',
    path => {
      window.history.replaceState({}, '', path)
      const reason = 'Vendor outage:\n  reconnect later.'

      expect(presentObserverFailureReason({ resourceTitle: 'Quarterly plan', reason })).toBe(reason)
    },
  )
})
