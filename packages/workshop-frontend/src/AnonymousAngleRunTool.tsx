import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import type { SiteLocale } from '@gadgets/site-config'
import {
  ANONYMOUS_ANGLE_RUN_MARKET_MAX_CHARS,
  ANONYMOUS_ANGLE_RUN_PRODUCT_MAX_CHARS,
  isAnonymousAngleRunErrorResponse,
  normalizeAnonymousAngleRunResponse,
  type AnonymousAngleRunErrorCode,
} from '@gadgets/workshop-shared/anonymous-angle-run'
import {
  readStoredAnonymousAngleRun,
  writeStoredAnonymousAngleRun,
  type StoredAnonymousAngleRun,
} from './anonymousAngleRunSession'
import {
  marketingBodyClassName,
  marketingFocusClassName,
  marketingPrimaryActionClassName,
  marketingSecondaryActionClassName,
  marketingSectionClassName,
} from './marketingStyles'
import { m as messages } from './paraglide/messages.js'

type RunFailure = AnonymousAngleRunErrorCode | 'unknown'

type CompletedAnonymousAngleRun = Pick<
  StoredAnonymousAngleRun,
  'product' | 'market' | 'angles'
>

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

interface AnonymousAngleRunToolProps {
  locale: SiteLocale
  isAuthenticated: boolean
  onContinue: () => void
}

export default function AnonymousAngleRunTool({
  locale,
  isAuthenticated,
  onContinue,
}: AnonymousAngleRunToolProps) {
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
  const angles = completedRun?.angles ?? null

  useEffect(() => {
    const stored = readStoredAnonymousAngleRun()
    if (!stored || stored.locale !== locale) return
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
    writeStoredAnonymousAngleRun({
      version: 1,
      locale,
      ...completedRun,
      selectedIndex,
    })
  }, [completedRun, locale, selectedIndex])

  const handleSelectAngle = (index: number) => {
    setSelectedIndex(index)
    if (!completedRun) return
    writeStoredAnonymousAngleRun({
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
      const result = normalizeAnonymousAngleRunResponse(value)
      if (response.ok && result) {
        const nextRun = {
          product: normalizedProduct,
          market: normalizedMarket,
          angles: result.angles,
        } satisfies CompletedAnonymousAngleRun
        writeStoredAnonymousAngleRun({
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
      setFailure(isAnonymousAngleRunErrorResponse(value) ? value.error : 'unknown')
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

  return (
    <section id="marketing-hero" className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-16 lg:px-8">
      <div className="max-w-4xl">
        <span
          aria-hidden="true"
          className="mb-4 block h-px w-12 bg-[color:var(--color-accent-mark)] sm:mb-6"
        />
        <h1 className="font-display text-[2rem] font-normal leading-10 tracking-[-0.035em] text-kumo-default sm:text-5xl sm:leading-[3.5rem]">
          {messages.marketing_hero_heading()}
        </h1>
        <p className={`mt-4 ${marketingBodyClassName} sm:mt-5`}>
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
                className={`mt-2 block h-12 w-full rounded-md border border-kumo-line bg-kumo-control px-3 text-base font-normal text-kumo-default placeholder:text-kumo-inactive ${marketingFocusClassName}`}
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
                className={`mt-2 block h-12 w-full rounded-md border border-kumo-line bg-kumo-control px-3 text-base font-normal text-kumo-default placeholder:text-kumo-inactive ${marketingFocusClassName}`}
              />
            </label>
          </div>
          <div className="mt-5 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
            <button type="submit" disabled={loading} className={marketingPrimaryActionClassName}>
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
          <h2 id="anonymous-angle-results-heading" className={marketingSectionClassName}>
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
                    className={`mt-6 w-full ${marketingSecondaryActionClassName}`}
                  >
                    {selected
                      ? messages.marketing_hero_angle_selected()
                      : messages.marketing_hero_use_angle()}
                  </button>
                </article>
              )
            })}
          </div>
          {isAuthenticated ? (
            <button
              type="button"
              onClick={onContinue}
              className={`mt-6 ${marketingPrimaryActionClassName}`}
            >
              {selectedIndex === null
                ? messages.marketing_back_to_workshop()
                : messages.marketing_continue_in_workshop()}
            </button>
          ) : (
            <Link to="/signup" className={`mt-6 ${marketingPrimaryActionClassName}`}>
              {selectedIndex === null
                ? messages.marketing_create_account()
                : messages.marketing_hero_results_save()}
            </Link>
          )}
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
  )
}
