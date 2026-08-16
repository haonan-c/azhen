import { useEffect } from 'react'
import { Link } from '@tanstack/react-router'
import { enabledPages, localizedPath, type SiteLocale } from '@gadgets/site-config'
import { ChartLineUp, FileText, PencilSimple } from '@phosphor-icons/react'
import AnonymousAngleRunTool from './AnonymousAngleRunTool'
import { angleWallEntries as defaultAngleWallEntries, type AngleWallEntry } from './angleWall'
import LanguageSelector from './components/LanguageSelector'
import SiteLogo from './components/SiteLogo'
import { marketingFaq } from './marketingContent'
import { useSiteName } from './ServerConfigContext'
import { getLocale } from './paraglide/runtime.js'
import { m as messages } from './paraglide/messages.js'
import {
  marketingBodyClassName,
  marketingFocusClassName,
  marketingPrimaryActionClassName,
  marketingSectionClassName,
} from './marketingStyles'

interface MarketingLandingPageProps {
  onSignIn: () => void
  angleWallEntries?: readonly AngleWallEntry[]
  isAuthenticated?: boolean
}

const COMPARISON_COLLECTED_ON = '2026-08-13'
const COPYRIGHT_YEAR = 2026

function footerPageLabel(path: string, siteName: string): string {
  if (path === '/') return siteName
  if (path === '/pricing') return messages.marketing_footer_pricing()
  if (path === '/about') return messages.marketing_footer_about()
  if (path === '/privacy') return messages.marketing_footer_privacy()
  if (path === '/terms') return messages.marketing_footer_terms()
  if (path === '/hub/') return messages.marketing_footer_resources()
  return messages.marketing_footer_page_label({ path })
}

export default function MarketingLandingPage({
  onSignIn,
  angleWallEntries = defaultAngleWallEntries,
  isAuthenticated = false,
}: MarketingLandingPageProps) {
  const locale = getLocale() as SiteLocale
  const siteName = useSiteName()
  const documentTitle = messages.marketing_document_title()

  useEffect(() => {
    const previousTitle = document.title
    document.title = documentTitle
    return () => {
      document.title = previousTitle
    }
  }, [documentTitle])

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
  const hubPage = enabledPages().find(page => page.path === '/hub/' && page.locales.includes(locale))
  const hubPlaybooksPath = hubPage
    ? `${localizedPath(hubPage.path, locale)}playbooks/`
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
            className={`shrink-0 rounded-md ${marketingFocusClassName}`}
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
        <AnonymousAngleRunTool
          locale={locale}
          isAuthenticated={isAuthenticated}
          onContinue={onSignIn}
        />

        <section id="marketing-steps" className="border-t border-kumo-line">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:px-8">
            <h2 className={marketingSectionClassName}>{messages.marketing_steps_heading()}</h2>
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
              <h2 className={marketingSectionClassName}>{messages.marketing_wall_heading()}</h2>
              <p className={`mt-4 ${marketingBodyClassName}`}>{messages.marketing_wall_description()}</p>
              <div className="mt-10 grid gap-4 lg:grid-cols-3">
                {angleWallEntries.map(entry => (
                  <details key={entry.id} className="rounded-md border border-kumo-line p-5">
                    <summary className={`cursor-pointer rounded-sm ${marketingFocusClassName}`}>
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
              <h2 className={marketingSectionClassName}>{messages.marketing_diff_heading()}</h2>
              <div className="mt-7 space-y-5 text-[17px] leading-[1.7] text-kumo-subtle">
                <p>{messages.marketing_diff_body_one()}</p>
                <p>{messages.marketing_diff_body_two()}</p>
                <p>{messages.marketing_diff_body_three()}</p>
              </div>
              {hubPlaybooksPath && (
                <a
                  href={hubPlaybooksPath}
                  className={`mt-7 inline-flex rounded-sm text-sm font-semibold text-kumo-link hover:underline ${marketingFocusClassName}`}
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
              <h2 className={marketingSectionClassName}>{messages.marketing_whatis_heading()}</h2>
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
            <h2 className={marketingSectionClassName}>{messages.marketing_compare_heading()}</h2>
            <div
              data-marketing-compare-scroll=""
              role="region"
              aria-label={messages.marketing_compare_heading()}
              tabIndex={0}
              className={`mt-10 overflow-x-auto rounded-md border border-kumo-line ${marketingFocusClassName}`}
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
              <h2 className={marketingSectionClassName}>{messages.marketing_access_heading()}</h2>
              <p className={`mt-4 ${marketingBodyClassName}`}>{messages.marketing_access_description()}</p>
              {isAuthenticated ? (
                <button
                  type="button"
                  onClick={onSignIn}
                  className={`mt-7 ${marketingPrimaryActionClassName}`}
                >
                  {messages.marketing_back_to_workshop()}
                </button>
              ) : (
                <Link
                  to="/signup"
                  className={`mt-7 ${marketingPrimaryActionClassName}`}
                >
                  {messages.marketing_access_cta()}
                </Link>
              )}
              <p className="mt-3 text-sm text-kumo-subtle">{messages.marketing_access_note()}</p>
            </div>
          </div>
        </section>

        <section id="marketing-faq" className="border-t border-kumo-line">
          <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6 lg:px-8">
            <h2 className={marketingSectionClassName}>{messages.marketing_faq_heading()}</h2>
            <div className="mt-10 max-w-[68ch] divide-y divide-kumo-line border-y border-kumo-line">
              {faq.map((item, index) => (
                <details key={item.question} open={index === 0 ? true : undefined} className="py-5">
                  <summary className={`cursor-pointer text-lg font-semibold leading-7 text-kumo-default ${marketingFocusClassName}`}>
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
                  className={`rounded-sm text-sm font-semibold text-kumo-default hover:text-kumo-link ${marketingFocusClassName}`}
                >
                  {footerPageLabel(page.path, siteName)}
                </a>
              ))}
              <button
                type="button"
                onClick={onSignIn}
                className={`rounded-sm text-sm text-kumo-subtle hover:text-kumo-link ${marketingFocusClassName}`}
              >
                {isAuthenticated
                  ? messages.marketing_back_to_workshop()
                  : messages.marketing_sign_in()}
              </button>
              {!isAuthenticated && (
                <Link
                  to="/signup"
                  className={`rounded-sm text-sm text-kumo-subtle hover:text-kumo-link ${marketingFocusClassName}`}
                >
                  {messages.marketing_create_account()}
                </Link>
              )}
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
