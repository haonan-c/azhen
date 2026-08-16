import type { SiteLocale } from '@gadgets/site-config'
import {
  normalizeAnonymousAngleRunRequest,
  normalizeAnonymousAngleRunResponse,
  type AnonymousAngleRunResponse,
} from '@gadgets/workshop-shared/anonymous-angle-run'
import { m as messages } from './paraglide/messages.js'

export type StoredAnonymousAngleRun = {
  version: 1
  locale: SiteLocale
  product: string
  market: string
  angles: AnonymousAngleRunResponse['angles']
  selectedIndex: number | null
}

/** The browser-session key that keeps one Anonymous Angle Run through registration. */
export const ANONYMOUS_ANGLE_RUN_SESSION_KEY = 'ugc-angle.anonymous-angle-run.v1'

function normalizeStoredRun(value: unknown): StoredAnonymousAngleRun | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.version !== 1) return null
  const request = normalizeAnonymousAngleRunRequest(record)
  const response = normalizeAnonymousAngleRunResponse({ angles: record.angles })
  if (!request || !response) return null
  const selectedIndex = record.selectedIndex
  if (
    selectedIndex !== null
    && (
      typeof selectedIndex !== 'number'
      || !Number.isInteger(selectedIndex)
      || selectedIndex < 0
      || selectedIndex >= response.angles.length
    )
  ) {
    return null
  }
  return {
    version: 1,
    ...request,
    angles: response.angles,
    selectedIndex,
  }
}

export function readStoredAnonymousAngleRun(): StoredAnonymousAngleRun | null {
  if (typeof window === 'undefined') return null
  try {
    return normalizeStoredRun(JSON.parse(
      window.sessionStorage.getItem(ANONYMOUS_ANGLE_RUN_SESSION_KEY) ?? 'null',
    ))
  } catch {
    return null
  }
}

export function writeStoredAnonymousAngleRun(value: StoredAnonymousAngleRun): void {
  try {
    window.sessionStorage.setItem(ANONYMOUS_ANGLE_RUN_SESSION_KEY, JSON.stringify(value))
  } catch {
    // The page still works when the browser cannot use session storage.
  }
}

export function clearStoredAnonymousAngleRun(): void {
  try {
    window.sessionStorage.removeItem(ANONYMOUS_ANGLE_RUN_SESSION_KEY)
  } catch {
    // The page still works when the browser cannot use session storage.
  }
}

export function anonymousAngleRunHandoffPrompt(
  storedRun: StoredAnonymousAngleRun,
): string | null {
  if (storedRun.selectedIndex === null) return null
  const selectedAngle = storedRun.angles[storedRun.selectedIndex]
  const angles = storedRun.angles.map((angle, index) => messages.anonymous_angle_handoff_angle({
    number: index + 1,
    angleName: angle.name,
    tension: angle.tension,
    hypothesis: angle.hypothesis,
    openingHook: angle.openingHook,
    worthTesting: angle.worthTesting,
  }, { locale: storedRun.locale })).join('\n\n')
  return messages.anonymous_angle_handoff_prompt({
    product: storedRun.product,
    market: storedRun.market,
    angles,
    selectedNumber: storedRun.selectedIndex + 1,
    selectedName: selectedAngle.name,
  }, { locale: storedRun.locale })
}
