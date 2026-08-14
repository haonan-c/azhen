import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { enabledPages, localizedPath, type SiteLocale } from '@gadgets/site-config'
import {
  ANONYMOUS_ANGLE_RUN_MARKET_MAX_CHARS,
  ANONYMOUS_ANGLE_RUN_PRODUCT_MAX_CHARS,
  type AnonymousAdAngle,
  type AnonymousAngleRunErrorCode,
  type AnonymousAngleRunResponse,
} from '@gadgets/workshop-shared/anonymous-angle-run'
import { ChartLineUp, FileText, PencilSimple } from '@phosphor-icons/react'
import { angleWallEntries as defaultAngleWallEntries, type AngleWallEntry } from './angleWall'
import LanguageSelector from './components/LanguageSelector'
import SiteLogo from './components/SiteLogo'
import { marketingFaq } from './marketingContent'
import { useSiteName } from './ServerConfigContext'
import { getLocale } from './paraglide/runtime.js'
import { m as messages } from './paraglide/messages.js'

interface MarketingLandingPageProps {
  onSignIn: () => void
  angleWallEntries?: readonly AngleWallEntry[]
}

type RunFailure = AnonymousAngleRunErrorCode | 'unknown'

type StoredAnonymousAngleRun = {
  version: 1
  locale: SiteLocale
  product: string
  market: string
  angles: AnonymousAngleRunResponse['angles']
  selectedIndex: number | null
}

type CompletedAnonymousAngleRun = Pick<
  StoredAnonymousAngleRun,
  'product' | 'market' | 'angles'
>

/** The browser-session key that keeps one Anonymous Angle Run through registration. */
export const ANONYMOUS_ANGLE_RUN_SESSION_KEY = 'ugc-angle.anonymous-angle-run.v1'

const COMPARISON_COLLECTED_ON = '2026-08-13'
const COPYRIGHT_YEAR = 2026
const focusClassName = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-base'
const primaryActionClassName = `inline-flex min-h-11 items-center justify-center rounded-md bg-kumo-brand px-5 text-sm font-semibold text-kumo-base transition-colors hover:bg-kumo-brand-hover disabled:cursor-not-allowed disabled:opacity-60 ${focusClassName}`
const secondaryActionClassName = `inline-flex min-h-11 items-center justify-center rounded-md border border-kumo-line bg-kumo-base px-5 text-sm font-semibold text-kumo-default transition-colors hover:bg-kumo-elevated ${focusClassName}`
const sectionHeadingCls = 'font-display text-[2rem] font-normal leading-10 tracking-[-0.025em] text-kumo-default'
const bodyCopyCls = 'max-w-[68ch] text-[17px] leading-[1.7] text-kumo-subtle'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAdAngle(value: unknown): value is AnonymousAdAngle {
  if (!isRecord(value)) return false
  return ['name', 'tension', 'hypothesis', 'openingHook', 'worthTesting']
    .every(field => typeof value[field] === 'string' && value[field].trim().length > 0)
}

function isAngleRunResponse(value: unknown): value is AnonymousAngleRunResponse {
  return isRecord(value)
    && Array.isArray(value.angles)
    && value.angles.length === 3
    && value.angles.every(isAdAngle)
}

function isAngleRunError(value: unknown): value is { error: AnonymousAngleRunErrorCode } {
  if (!isRecord(value) || typeof value.error !== 'string') return false
  return [
    'forbidden',
    'invalid_request',
    'method_not_allowed',
    'payload_too_large',
    'rate_limited',
    'unavailable',
    'unsupported_media_type',
  ].includes(value.error)
}

function isStoredRun(value: unknown): value is StoredAnonymousAngleRun {
  if (!isRecord(value) || value.version !== 1 || !['en', 'zh'].includes(String(value.locale))) {
    return false
  }
  if (typeof value.product !== 'string' || typeof value.market !== 'string') return false
  const productLength = [...value.product.trim()].length
  const marketLength = [...value.market.trim()].length
  if (
    productLength < 1
    || productLength > ANONYMOUS_ANGLE_RUN_PRODUCT_MAX_CHARS
    || marketLength < 1
    || marketLength > ANONYMOUS_ANGLE_RUN_MARKET_MAX_CHARS
  ) {
    return false
  }
  if (!Array.isArray(value.angles) || value.angles.length !== 3 || !value.angles.every(isAdAngle)) {
    return false
  }
  if (value.selectedIndex === null) return true
  return typeof value.selectedIndex === 'number'
    && Number.isInteger(value.selectedIndex)
    && value.selectedIndex >= 0
    && value.selectedIndex < 3
}

function readStoredRun(): StoredAnonymousAngleRun | null {
  if (typeof window === 'undefined') return null
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(ANONYMOUS_ANGLE_RUN_SESSION_KEY) ?? 'null')
    return isStoredRun(value) ? value : null
  } catch {
    return null
  }
}

function writeStoredRun(value: StoredAnonymousAngleRun): void {
  try {
    window.sessionStorage.setItem(ANONYMOUS_ANGLE_RUN_SESSION_KEY, JSON.stringify(value))
  } catch {
    // The page still works when the browser cannot use session storage.
  }
}

function failureCopy(failure: RunFailure): string {
  if (failure === 'unavailable') return messages.marketing_hero_unavailable()
  if (failure === 'rate_limited') return messages.marketing_hero_rate_limited()
  if (failure === 'forbidden') return messages.marketing_hero_forbidden()
  if (
    failure === 'invalid_request'
    || failure === 'payload_too_large'
    || failure === 'unsupported_media_type'
  ) {
    return messages.marketing_hero_validation()
  }
  return messages.marketing_hero_error()
}

function footerPageLabel(path: string, siteName: string): string {
  if (path === '/') return siteName
  if (path === '/pricing') return messages.marketing_footer_pricing()
  if (path === '/about') return messages.marketing_footer_about()
  if (path === '/privacy') return messages.marketing_footer_privacy()
  if (path === '/terms') return messages.marketing_footer_terms()
  if (path === '/hub') return messages.marketing_footer_resources()
  return messages.marketing_footer_page_label({ path })
}

export default function MarketingLandingPage({
  onSignIn,
  angleWallEntries = defaultAngleWallEntries,
}: MarketingLandingPageProps) {
  const locale = getLocale() as SiteLocale
  const siteName = useSiteName()
  const [product, setProduct] = useState('')
  const [market, setMarket] = useState('')
  const [completedRun, setCompletedRun] = useState<CompletedAnonymousAngleRun | null>(null)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [failure, setFailure] = useState<RunFailure | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingStep, setLoadingStep] = useState(0)
  const [showLimit, setShowLimit] = useState(false)
  const resultsRef = useRef<HTMLElement>(null)
  const runInFlight = useRef(false)
  const shouldScrollToResults = useRef(false)
  const documentTitle = messages.marketing_document_title()
  const angles = completedRun?.angles ?? null

  useEffect(() => {
    const previousTitle = document.title
    document.title = documentTitle
    return () => {
      document.title = previousTitle
    }
  }, [documentTitle])

  useEffect(() => {
    const stored = readStoredRun()
    if (!stored) return
    setProduct(stored.product)
    setMarket(stored.market)
    setCompletedRun({
      product: stored.product,
      market: stored.market,
      angles: stored.angles,
    })
    setSelectedIndex(stored.selectedIndex)
  }, [locale])

  useEffect(() => {
    if (!loading) return
    setLoadingStep(0)
    const timer = window.setInterval(() => {
      setLoadingStep(step => Math.min(step + 1, 2))
    }, 18_000)
    return () => window.clearInterval(timer)
  }, [loading])

  useEffect(() => {
    if (!angles || !shouldScrollToResults.current) return
    shouldScrollToResults.current = false
    resultsRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }, [angles])

  useEffect(() => {
    if (!completedRun) return
    writeStoredRun({
      version: 1,
      locale,
      ...completedRun,
      selectedIndex,
    })
  }, [completedRun, locale, selectedIndex])

  const persistAnonymousRun = () => {
    if (!completedRun) return
    writeStoredRun({
      version: 1,
      locale,
      ...completedRun,
      selectedIndex,
    })
  }

  const handleSignIn = () => {
    persistAnonymousRun()
    onSignIn()
  }

  const handleSelectAngle = (index: number) => {
    setSelectedIndex(index)
    if (!completedRun) return
    writeStoredRun({
      version: 1,
      locale,
      ...completedRun,
      selectedIndex: index,
    })
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (runInFlight.current) return
    if (angles) {
      setShowLimit(true)
      return
    }

    const normalizedProduct = product.trim()
    const normalizedMarket = market.trim()
    if (!normalizedProduct || !normalizedMarket) {
      setFailure('invalid_request')
      return
    }

    setFailure(null)
    setShowLimit(false)
    runInFlight.current = true
    setLoading(true)
    try {
      const response = await fetch('/api/anonymous-angle-run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          product: normalizedProduct,
          market: normalizedMarket,
          locale,
        }),
      })
      const value: unknown = await response.json().catch(() => null)
      if (response.ok && isAngleRunResponse(value)) {
        const nextRun = {
          product: normalizedProduct,
          market: normalizedMarket,
          angles: value.angles,
        } satisfies CompletedAnonymousAngleRun
        writeStoredRun({
          version: 1,
          locale,
          ...nextRun,
          selectedIndex: null,
        })
        shouldScrollToResults.current = true
        setCompletedRun(nextRun)
        setSelectedIndex(null)
        return
      }
      setFailure(isAngleRunError(value) ? value.error : 'unknown')
    } catch {
      setFailure('unknown')
    } finally {
      runInFlight.current = false
      setLoading(false)
    }
  }

  const loadingCopy = [
    messages.marketing_hero_loading_product(),
    messages.marketing_hero_loading_market(),
    messages.marketing_hero_loading_angles(),
  ]
  const steps = [
    {
      number: messages.marketing_steps_one_number(),
      title: messages.marketing_steps_one_title(),
      body: messages.marketing_steps_one_body(),
      icon: FileText,
    },
    {
      number: messages.marketing_steps_two_number(),
      title: messages.marketing_steps_two_title(),
      body: messages.marketing_steps_two_body(),
      icon: ChartLineUp,
    },
    {
      number: messages.marketing_steps_three_number(),
      title: messages.marketing_steps_three_title(),
      body: messages.marketing_steps_three_body(),
      icon: PencilSimple,
    },
  ]
  const comparisonRows = [
    [
      messages.marketing_compare_starting_point(),
      messages.marketing_compare_starting_point_us(),
      messages.marketing_compare_starting_point_them(),
    ],
    [
      messages.marketing_compare_output(),
      messages.marketing_compare_output_us(),
      messages.marketing_compare_output_them(),
    ],
    [
      messages.marketing_compare_testing(),
      messages.marketing_compare_testing_us(),
      messages.marketing_compare_testing_them(),
    ],
    [
      messages.marketing_compare_shoot(),
      messages.marketing_compare_shoot_us(),
      messages.marketing_compare_shoot_them(),
    ],
    [
      messages.marketing_compare_time(),
      messages.marketing_compare_time_us(),
      messages.marketing_compare_time_them(),
    ],
    [
      messages.marketing_compare_video(),
      messages.marketing_compare_video_us(),
      messages.marketing_compare_video_them(),
    ],
  ] as const
  const faq = marketingFaq(locale)
  const footerPages = enabledPages().filter(page => page.locales.includes(locale))
  const hubPage = enabledPages().find(page => page.path === '/hub' && page.locales.includes(locale))
  const hubPlaybooksPath = hubPage
    ? `${localizedPath(hubPage.path, locale)}/playbooks/`
    : null

  return (
    <div className="min-h-[100dvh] bg-kumo-base text-kumo-default">
      <header className="border-b border-kumo-line bg-kumo-base">
        <nav
          aria-label={messages.marketing_header_navigation()}
          className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-5 px-4 sm:px-6 lg:px-8"
        >
          <a
            href={localizedPath('/', locale)}
            aria-label={siteName}
            className={`shrink-0 rounded-md ${focusClassName}`}
          >
            <SiteLogo size={32} className="h-8 w-auto max-w-40">
              <span className="text-xl font-semibold tracking-[-0.04em] text-kumo-default">
                {siteName}
              </span>
            </SiteLogo>
          </a>
          <LanguageSelector />
        </nav>
      </header>

      <main>
        <section id="marketing-hero" className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-16 lg:px-8">
          <div className="max-w-4xl">
            <span
              aria-hidden="true"
              className="mb-4 block h-px w-12 bg-[color:var(--color-accent-mark)] sm:mb-6"
            />
            <h1 className="font-display text-[2rem] font-normal leading-10 tracking-[-0.035em] text-kumo-default sm:text-5xl sm:leading-[3.5rem]">
              {messages.marketing_hero_heading()}
            </h1>
            <p className={`mt-4 ${bodyCopyCls} sm:mt-5`}>
              {messages.marketing_hero_description()}
            </p>
          </div>

          <div
            data-marketing-tool=""
            className="mt-6 max-w-4xl rounded-md border border-kumo-line bg-kumo-base p-4 sm:mt-8 sm:p-6"
          >
            <form onSubmit={handleSubmit} aria-busy={loading}>
              <div className="grid gap-4 md:grid-cols-2 md:gap-5">
                <label className="block text-sm font-semibold text-kumo-default" htmlFor="anonymous-angle-product">
                  {messages.marketing_hero_product_label()}
                  <input
                    id="anonymous-angle-product"
                    name="product"
                    type="text"
                    aria-describedby="anonymous-angle-microcopy"
                    required
                    maxLength={ANONYMOUS_ANGLE_RUN_PRODUCT_MAX_CHARS}
                    value={product}
                    onChange={event => setProduct(event.target.value)}
                    placeholder={messages.marketing_hero_product_placeholder()}
                    className={`mt-2 block h-12 w-full rounded-md border border-kumo-line bg-kumo-control px-3 text-base font-normal text-kumo-default placeholder:text-kumo-inactive ${focusClassName}`}
                  />
                </label>
                <label className="block text-sm font-semibold text-kumo-default" htmlFor="anonymous-angle-market">
                  {messages.marketing_hero_market_label()}
                  <input
                    id="anonymous-angle-market"
                    name="market"
                    type="text"
                    aria-describedby="anonymous-angle-microcopy"
                    required
                    maxLength={ANONYMOUS_ANGLE_RUN_MARKET_MAX_CHARS}
                    value={market}
                    onChange={event => setMarket(event.target.value)}
                    placeholder={messages.marketing_hero_market_placeholder()}
                    className={`mt-2 block h-12 w-full rounded-md border border-kumo-line bg-kumo-control px-3 text-base font-normal text-kumo-default placeholder:text-kumo-inactive ${focusClassName}`}
                  />
                </label>
              </div>
              <div className="mt-5 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
                <button type="submit" disabled={loading} className={primaryActionClassName}>
                  {loading ? loadingCopy[loadingStep] : messages.marketing_hero_submit()}
                </button>
                <p id="anonymous-angle-microcopy" className="text-sm leading-6 text-kumo-subtle">
                  {messages.marketing_hero_microcopy()}
                </p>
              </div>
              {loading && (
                <p className="mt-3 text-sm text-kumo-brand" aria-live="polite">
                  {loadingCopy[loadingStep]}
                </p>
              )}
            </form>
          </div>

          {angles ? (
            <section
              ref={resultsRef}
              id="anonymous-angle-results"
              data-marketing-results=""
              aria-labelledby="anonymous-angle-results-heading"
              className="mt-8 max-w-6xl scroll-mt-6 border-t border-kumo-line pt-8"
            >
              <h2 id="anonymous-angle-results-heading" className={sectionHeadingCls}>
                {messages.marketing_hero_results_heading()}
              </h2>
              {showLimit && (
                <div className="mt-5 rounded-md border border-kumo-line p-4" role="status">
                  <p className="text-sm leading-6 text-kumo-subtle">
                    {messages.marketing_hero_limit()}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-kumo-subtle">
                    {messages.marketing_hero_register_prompt()}
                  </p>
                </div>
              )}
              <div className="mt-7 grid gap-4 lg:grid-cols-3">
                {angles.map((angle, index) => {
                  const selected = selectedIndex === index
                  return (
                    <article
                      key={`${angle.name}-${index}`}
                      data-angle-card=""
                      className={`rounded-md border p-5 ${selected ? 'border-kumo-brand' : 'border-kumo-line'}`}
                    >
                      <h3 className="text-xl font-semibold leading-7 text-kumo-default">{angle.name}</h3>
                      <dl className="mt-5 space-y-4 text-sm leading-6">
                        <div>
                          <dt className="font-semibold text-kumo-default">{messages.marketing_hero_tension_label()}</dt>
                          <dd className="mt-1 text-kumo-subtle">{angle.tension}</dd>
                        </div>
                        <div>
                          <dt className="font-semibold text-kumo-default">{messages.marketing_hero_hypothesis_label()}</dt>
                          <dd className="mt-1 text-kumo-subtle">{angle.hypothesis}</dd>
                        </div>
                        <div>
                          <dt className="font-semibold text-kumo-default">{messages.marketing_hero_hook_label()}</dt>
                          <dd className="mt-1 text-kumo-subtle">{angle.openingHook}</dd>
                        </div>
                        <div>
                          <dt className="font-semibold text-kumo-default">{messages.marketing_hero_worth_label()}</dt>
                          <dd className="mt-1 text-kumo-subtle">{angle.worthTesting}</dd>
                        </div>
                      </dl>
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => handleSelectAngle(index)}
                        className={`mt-6 w-full ${secondaryActionClassName}`}
                      >
                        {selected
                          ? messages.marketing_hero_angle_selected()
                          : messages.marketing_hero_use_angle()}
                      </button>
                    </article>
                  )
                })}
              </div>
              <Link
                to="/signup"
                onClick={() => persistAnonymousRun()}
                className={`mt-6 ${primaryActionClassName}`}
              >
                {selectedIndex === null
                  ? messages.marketing_create_account()
                  : messages.marketing_hero_results_save()}
              </Link>
            </section>
          ) : failure ? (
            <div
              data-marketing-error=""
              role="alert"
              className="mt-6 max-w-4xl rounded-md border border-kumo-line p-4 text-sm leading-6 text-kumo-subtle"
            >
              {failureCopy(failure)}
            </div>
          ) : null}
        </section>

        <section id="marketing-steps" className="border-t border-kumo-line">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:px-8">
            <h2 className={sectionHeadingCls}>{messages.marketing_steps_heading()}</h2>
            <div className="mt-10 grid gap-6 md:grid-cols-3">
              {steps.map((step) => {
                const Icon = step.icon
                return (
                  <article key={step.number} className="rounded-md border border-kumo-line p-6">
                    <Icon aria-hidden="true" size={24} weight="regular" className="text-kumo-brand" />
                    <p className="mt-6 text-sm font-semibold text-kumo-brand">{step.number}</p>
                    <h3 className="mt-2 text-xl font-semibold leading-7 text-kumo-default">{step.title}</h3>
                    <p className="mt-3 text-[17px] leading-[1.7] text-kumo-subtle">{step.body}</p>
                  </article>
                )
              })}
            </div>
          </div>
        </section>

        {angleWallEntries.length > 0 && (
          <section id="marketing-wall" className="border-t border-kumo-line">
            <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:px-8">
              <h2 className={sectionHeadingCls}>{messages.marketing_wall_heading()}</h2>
              <p className={`mt-4 ${bodyCopyCls}`}>{messages.marketing_wall_description()}</p>
              <div className="mt-10 grid gap-4 lg:grid-cols-3">
                {angleWallEntries.map(entry => (
                  <details key={entry.id} className="rounded-md border border-kumo-line p-5">
                    <summary className={`cursor-pointer rounded-sm ${focusClassName}`}>
                      <span className="block text-sm font-semibold text-kumo-brand">
                        {messages.marketing_wall_summary({
                          industry: entry.industry,
                          angleName: entry.angleName,
                          platform: entry.platform,
                        })}
                      </span>
                      <span className="mt-3 block text-[17px] leading-[1.7] text-kumo-subtle">
                        {entry.tension}
                      </span>
                      <span className="mt-4 block text-sm font-semibold text-kumo-default">
                        {messages.marketing_wall_read_script()}
                      </span>
                    </summary>
                    <dl className="mt-5 space-y-4 border-t border-kumo-line pt-5 text-sm leading-6">
                      <div>
                        <dt className="font-semibold text-kumo-default">{messages.marketing_wall_hypothesis_label()}</dt>
                        <dd className="mt-1 text-kumo-subtle">{entry.hypothesis}</dd>
                      </div>
                      <div>
                        <dt className="font-semibold text-kumo-default">{messages.marketing_wall_hook_label()}</dt>
                        <dd className="mt-1 text-kumo-subtle">{entry.openingHook}</dd>
                      </div>
                      <div>
                        <dt className="font-semibold text-kumo-default">{messages.marketing_wall_script_label()}</dt>
                        <dd className="mt-1 text-kumo-subtle">{entry.scriptExcerpt}</dd>
                      </div>
                    </dl>
                    <p className="mt-5 text-xs text-kumo-inactive">
                      {messages.marketing_wall_produced_on({ date: entry.producedOn })}
                    </p>
                  </details>
                ))}
              </div>
            </div>
          </section>
        )}

        <section id="marketing-difference" className="border-t border-kumo-line">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:px-8">
            <div className="max-w-[68ch]">
              <h2 className={sectionHeadingCls}>{messages.marketing_diff_heading()}</h2>
              <div className="mt-7 space-y-5 text-[17px] leading-[1.7] text-kumo-subtle">
                <p>{messages.marketing_diff_body_one()}</p>
                <p>{messages.marketing_diff_body_two()}</p>
                <p>{messages.marketing_diff_body_three()}</p>
              </div>
              {hubPlaybooksPath && (
                <a
                  href={hubPlaybooksPath}
                  className={`mt-7 inline-flex rounded-sm text-sm font-semibold text-kumo-link hover:underline ${focusClassName}`}
                >
                  {messages.marketing_diff_link()}
                </a>
              )}
            </div>
          </div>
        </section>

        <section id="marketing-whatis" className="border-t border-kumo-line">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:px-8">
            <article className="max-w-[68ch]">
              <h2 className={sectionHeadingCls}>{messages.marketing_whatis_heading()}</h2>
              <div className="mt-10 space-y-10 text-[17px] leading-[1.7] text-kumo-subtle">
                <section>
                  <h3 className="text-xl font-semibold leading-7 text-kumo-default">
                    {messages.marketing_whatis_definition_heading()}
                  </h3>
                  <p className="mt-3">{messages.marketing_whatis_definition_body()}</p>
                </section>
                <section>
                  <h3 className="text-xl font-semibold leading-7 text-kumo-default">
                    {messages.marketing_whatis_fit_heading()}
                  </h3>
                  <div className="mt-3 space-y-4">
                    <p>{messages.marketing_whatis_fit_body_one()}</p>
                    <p>{messages.marketing_whatis_fit_body_two()}</p>
                    <p>{messages.marketing_whatis_fit_body_three()}</p>
                  </div>
                </section>
                <section>
                  <h3 className="text-xl font-semibold leading-7 text-kumo-default">
                    {messages.marketing_whatis_comparison_heading()}
                  </h3>
                  <div className="mt-3 space-y-4">
                    <p>{messages.marketing_whatis_comparison_body_one()}</p>
                    <p>{messages.marketing_whatis_comparison_body_two()}</p>
                  </div>
                </section>
              </div>
            </article>
          </div>
        </section>

        <section id="marketing-compare" className="border-t border-kumo-line">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:px-8">
            <h2 className={sectionHeadingCls}>{messages.marketing_compare_heading()}</h2>
            <div
              data-marketing-compare-scroll=""
              role="region"
              aria-label={messages.marketing_compare_heading()}
              tabIndex={0}
              className={`mt-10 overflow-x-auto rounded-md border border-kumo-line ${focusClassName}`}
            >
              <table className="w-full min-w-[720px] border-collapse text-left text-sm leading-6">
                <thead>
                  <tr className="border-b border-kumo-line">
                    <th scope="col" className="p-4 font-semibold text-kumo-subtle">
                      <span className="sr-only">{messages.marketing_compare_dimension()}</span>
                    </th>
                    <th scope="col" className="p-4 font-semibold text-kumo-default">
                      {messages.marketing_compare_ugc_angle()}
                    </th>
                    <th scope="col" className="p-4 font-semibold text-kumo-default">
                      {messages.marketing_compare_prompt_tools()}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {comparisonRows.map(([dimension, ownValue, otherValue], index) => (
                    <tr
                      key={dimension}
                      data-video-production-row={index === comparisonRows.length - 1 ? '' : undefined}
                      className="border-b border-kumo-line last:border-b-0"
                    >
                      <th scope="row" className="p-4 font-semibold text-kumo-default">{dimension}</th>
                      <td className="p-4 text-kumo-subtle">{ownValue}</td>
                      <td className="p-4 text-kumo-subtle">{otherValue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 max-w-[68ch] text-xs leading-5 text-kumo-inactive">
              {messages.marketing_compare_footnote({ date: COMPARISON_COLLECTED_ON })}
            </p>
          </div>
        </section>

        <section id="marketing-access" className="border-t border-kumo-line">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:px-8">
            <div className="max-w-[68ch]">
              <h2 className={sectionHeadingCls}>{messages.marketing_access_heading()}</h2>
              <p className={`mt-4 ${bodyCopyCls}`}>{messages.marketing_access_description()}</p>
              <Link
                to="/signup"
                onClick={() => persistAnonymousRun()}
                className={`mt-7 ${primaryActionClassName}`}
              >
                {messages.marketing_access_cta()}
              </Link>
              <p className="mt-3 text-sm text-kumo-subtle">{messages.marketing_access_note()}</p>
            </div>
          </div>
        </section>

        <section id="marketing-faq" className="border-t border-kumo-line">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:px-8">
            <h2 className={sectionHeadingCls}>{messages.marketing_faq_heading()}</h2>
            <div className="mt-10 max-w-[68ch] divide-y divide-kumo-line border-y border-kumo-line">
              {faq.map((item, index) => (
                <details key={item.question} open={index === 0 ? true : undefined} className="py-5">
                  <summary className={`cursor-pointer text-lg font-semibold leading-7 text-kumo-default ${focusClassName}`}>
                    {item.question}
                  </summary>
                  <p data-faq-answer="" className="mt-3 text-[17px] leading-[1.7] text-kumo-subtle">
                    {item.answer}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-kumo-line bg-kumo-base">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:px-6 md:grid-cols-[1fr_auto] md:items-end lg:px-8">
          <div>
            <nav
              aria-label={messages.marketing_footer_navigation()}
              className="flex flex-wrap items-center gap-x-5 gap-y-3"
            >
              {footerPages.map(page => (
                <a
                  key={page.path}
                  data-site-page-link=""
                  href={localizedPath(page.path, locale)}
                  className={`rounded-sm text-sm font-semibold text-kumo-default hover:text-kumo-link ${focusClassName}`}
                >
                  {footerPageLabel(page.path, siteName)}
                </a>
              ))}
              <button
                type="button"
                onClick={handleSignIn}
                className={`rounded-sm text-sm text-kumo-subtle hover:text-kumo-link ${focusClassName}`}
              >
                {messages.marketing_sign_in()}
              </button>
              <Link
                to="/signup"
                onClick={() => persistAnonymousRun()}
                className={`rounded-sm text-sm text-kumo-subtle hover:text-kumo-link ${focusClassName}`}
              >
                {messages.marketing_create_account()}
              </Link>
            </nav>
            <p className="mt-4 text-sm text-kumo-subtle">
              {messages.marketing_footer_copyright({ year: COPYRIGHT_YEAR, brand: siteName })}
            </p>
          </div>
          <LanguageSelector />
        </div>
      </footer>
    </div>
  )
}
