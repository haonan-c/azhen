// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  changeLocale,
  getWorkshopHomeHref,
  initializeLocale,
  resolveInitialLocale,
} from './locale'
import { m as messages } from './paraglide/messages.js'

afterEach(() => {
  localStorage.clear()
  document.documentElement.lang = ''
  vi.restoreAllMocks()
})

describe('resolveInitialLocale', () => {
  it('uses explicit localized URLs before a saved preference', () => {
    expect(resolveInitialLocale({
      href: 'https://azhen.example/zh/workspace/123?panel=files#result',
      savedLocale: 'en',
      hasVisitedBareRoot: true,
      browserLanguages: ['en-US'],
    })).toEqual({
      locale: 'zh',
      href: 'https://azhen.example/zh/workspace/123?panel=files#result',
      markBareRootVisited: false,
    })

    expect(resolveInitialLocale({
      href: 'https://azhen.example/workspace/123',
      savedLocale: 'zh',
      hasVisitedBareRoot: true,
      browserLanguages: ['zh-CN'],
    }).locale).toBe('en')
  })

  it('uses saved and first-visit browser preferences only at the bare root', () => {
    expect(resolveInitialLocale({
      href: 'https://azhen.example/?ref=launch#hero',
      savedLocale: 'zh',
      hasVisitedBareRoot: true,
      browserLanguages: ['en-US'],
    })).toEqual({
      locale: 'zh',
      href: 'https://azhen.example/zh?ref=launch#hero',
      markBareRootVisited: false,
    })

    expect(resolveInitialLocale({
      href: 'https://azhen.example/',
      savedLocale: null,
      hasVisitedBareRoot: false,
      browserLanguages: ['zh-CN', 'en-US'],
    })).toEqual({
      locale: 'zh',
      href: 'https://azhen.example/zh',
      markBareRootVisited: true,
    })

    expect(resolveInitialLocale({
      href: 'https://azhen.example/',
      savedLocale: null,
      hasVisitedBareRoot: false,
      browserLanguages: ['en-US', 'zh-CN'],
    }).locale).toBe('en')

    expect(resolveInitialLocale({
      href: 'https://azhen.example/',
      savedLocale: null,
      hasVisitedBareRoot: true,
      browserLanguages: ['zh-CN'],
    }).locale).toBe('en')
  })

  it('normalizes locale aliases without treating unknown segments as locales', () => {
    expect(resolveInitialLocale({
      href: 'https://azhen.example/en/workspaces?view=grid#recent',
      savedLocale: null,
      hasVisitedBareRoot: true,
      browserLanguages: [],
    }).href).toBe('https://azhen.example/workspaces?view=grid#recent')

    expect(resolveInitialLocale({
      href: 'https://azhen.example/zh/?view=grid#recent',
      savedLocale: null,
      hasVisitedBareRoot: true,
      browserLanguages: [],
    }).href).toBe('https://azhen.example/zh?view=grid#recent')

    expect(resolveInitialLocale({
      href: 'https://azhen.example/fr/workspaces',
      savedLocale: 'zh',
      hasVisitedBareRoot: true,
      browserLanguages: ['zh-CN'],
    })).toMatchObject({
      locale: 'en',
      href: 'https://azhen.example/fr/workspaces',
    })
  })
})

describe('locale browser integration', () => {
  it('keeps the URL locale when sign-up continues to the Workshop', () => {
    expect(getWorkshopHomeHref('https://example.com/signup')).toBe('/')
    expect(getWorkshopHomeHref('https://example.com/zh/signup')).toBe('/zh')
  })

  it('does not overwrite an explicit preference when the URL selects another locale', () => {
    window.history.replaceState({}, '', '/workspaces')
    localStorage.setItem('PARAGLIDE_LOCALE', 'zh')

    initializeLocale()

    expect(messages.brand_name()).toBe('azhen')
    expect(localStorage.getItem('PARAGLIDE_LOCALE')).toBe('zh')
  })

  it('initializes the document language and persists the first bare-root visit', () => {
    window.history.replaceState({}, '', '/')
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['zh-CN'])

    initializeLocale()

    expect(window.location.pathname).toBe('/zh')
    expect(document.documentElement.lang).toBe('zh')
    expect(localStorage.getItem('azhen.bareRootLocaleResolved')).toBe('1')
  })

  it('changes language while preserving the route, query, and hash', () => {
    window.history.replaceState({}, '', '/workspace/123?panel=files#result')
    const navigate = vi.fn<(href: string) => void>()

    changeLocale('zh', navigate)

    expect(navigate).toHaveBeenCalledWith('/zh/workspace/123?panel=files#result')
    expect(localStorage.getItem('PARAGLIDE_LOCALE')).toBe('zh')
    expect(document.documentElement.lang).toBe('zh')

    window.history.replaceState({}, '', '/zh/workspace/123?panel=files#result')
    changeLocale('en', navigate)

    expect(navigate).toHaveBeenLastCalledWith('/workspace/123?panel=files#result')
    expect(localStorage.getItem('PARAGLIDE_LOCALE')).toBe('en')
    expect(document.documentElement.lang).toBe('en')
  })
})
