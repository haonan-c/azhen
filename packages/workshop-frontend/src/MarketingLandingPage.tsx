import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  AppWindow,
  ArrowRight,
  ChartLineUp,
  FileText,
  ImageSquare,
  List,
  PencilSimple,
  PlugsConnected,
  ShieldCheck,
  SquaresFour,
  UsersThree,
  X,
} from '@phosphor-icons/react'
import LanguageSelector from './components/LanguageSelector'
import SiteLogo from './components/SiteLogo'
import { useServerConfig, useSiteName } from './ServerConfigContext'
import { CF_ACCESS_MODE } from './useAuth'
import { useDocumentTitle } from './useDocumentTitle'
import { getLocale } from './paraglide/runtime.js'
import { m as messages } from './paraglide/messages.js'

interface MarketingLandingPageProps {
  onSignIn?: () => void
}

const focusClassName = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-base'
const primaryActionClassName = `inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-kumo-contrast px-5 text-sm font-semibold text-kumo-inverse transition-[background-color,transform] hover:bg-kumo-strong active:scale-[0.98] ${focusClassName}`
const secondaryActionClassName = `inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-lg border border-kumo-line bg-kumo-base px-5 text-sm font-semibold text-kumo-default transition-[background-color,transform] hover:bg-kumo-elevated active:scale-[0.98] ${focusClassName}`

function MarketingActions({
  signupAvailable,
  onSignIn,
  className = '',
}: {
  signupAvailable: boolean
  onSignIn: () => void
  className?: string
}) {
  return (
    <div className={`flex flex-col gap-3 sm:flex-row ${className}`}>
      {signupAvailable ? (
        <Link to="/signup" className={primaryActionClassName}>
          {messages.auth_create_account_submit()}
          <ArrowRight aria-hidden="true" size={16} weight="bold" />
        </Link>
      ) : (
        <button type="button" onClick={onSignIn} className={primaryActionClassName}>
          {messages.auth_sign_in()}
          <ArrowRight aria-hidden="true" size={16} weight="bold" />
        </button>
      )}
      <button type="button" onClick={onSignIn} className={secondaryActionClassName}>
        {messages.auth_sign_in()}
      </button>
    </div>
  )
}

export default function MarketingLandingPage({ onSignIn = () => {} }: MarketingLandingPageProps) {
  const locale = getLocale()
  const siteName = useSiteName()
  const serverConfig = useServerConfig()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null)
  useDocumentTitle(messages.marketing_document_title())

  const signupAvailable = !CF_ACCESS_MODE
    && serverConfig?.signupsEnabled === true
    && (serverConfig.passwordAuthEnabled || serverConfig.authVendors.length > 0)

  useEffect(() => {
    if (!mobileMenuOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMobileMenuOpen(false)
      mobileMenuButtonRef.current?.focus()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [mobileMenuOpen])

  const workflow = [
    {
      icon: FileText,
      title: messages.marketing_workflow_brief_title(),
      description: messages.marketing_workflow_brief_description(),
      className: 'md:col-span-5',
    },
    {
      icon: ChartLineUp,
      title: messages.marketing_workflow_evidence_title(),
      description: messages.marketing_workflow_evidence_description(),
      className: 'md:col-span-3',
    },
    {
      icon: PencilSimple,
      title: messages.marketing_workflow_result_title(),
      description: messages.marketing_workflow_result_description(),
      className: 'md:col-span-4',
    },
  ]

  const capabilities = [
    {
      icon: ChartLineUp,
      title: messages.marketing_capability_insight_title(),
      description: messages.marketing_capability_insight_description(),
      className: 'lg:col-span-7 bg-kumo-tint',
    },
    {
      icon: PencilSimple,
      title: messages.marketing_capability_content_title(),
      description: messages.marketing_capability_content_description(),
      className: 'lg:col-span-5 bg-kumo-elevated',
    },
    {
      icon: FileText,
      title: messages.marketing_capability_documents_title(),
      description: messages.marketing_capability_documents_description(),
      className: 'lg:col-span-5 bg-kumo-elevated',
    },
    {
      icon: ImageSquare,
      title: messages.marketing_capability_rendering_title(),
      description: messages.marketing_capability_rendering_description(),
      className: 'lg:col-span-4 bg-kumo-tint',
    },
    {
      icon: AppWindow,
      title: messages.marketing_capability_apps_title(),
      description: messages.marketing_capability_apps_description(),
      className: 'lg:col-span-3 bg-kumo-elevated',
    },
  ]

  const security = [
    {
      icon: ShieldCheck,
      title: messages.marketing_security_sandbox_title(),
      description: messages.marketing_security_sandbox_description(),
    },
    {
      icon: PlugsConnected,
      title: messages.marketing_security_connectors_title(),
      description: messages.marketing_security_connectors_description(),
    },
    {
      icon: SquaresFour,
      title: messages.marketing_security_actions_title(),
      description: messages.marketing_security_actions_description(),
    },
  ]

  const screenshot = locale === 'zh'
    ? '/marketing/product-evidence-zh.jpg'
    : '/marketing/product-evidence-en.jpg'
  const mobileScreenshot = locale === 'zh'
    ? '/marketing/product-evidence-zh-mobile.jpg'
    : '/marketing/product-evidence-en-mobile.jpg'

  return (
    <div className="min-h-[100dvh] bg-kumo-base text-kumo-default">
      <header className="sticky top-0 z-50 border-b border-kumo-line bg-kumo-base/95 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-5 px-4 sm:px-6 lg:px-8">
          <Link
            to="/"
            aria-label={siteName}
            className={`shrink-0 rounded-md ${focusClassName}`}
          >
            <SiteLogo size={32} className="h-8 w-auto max-w-36">
              <span className="text-xl font-semibold tracking-[-0.04em] text-kumo-default">
                {siteName}
              </span>
            </SiteLogo>
          </Link>

          <nav
            aria-label={messages.marketing_header_navigation()}
            className="hidden items-center gap-1 lg:flex"
          >
            <a className={`rounded-md px-3 py-2 text-sm text-kumo-subtle hover:text-kumo-default ${focusClassName}`} href="#workflow">
              {messages.marketing_nav_workflow()}
            </a>
            <a className={`rounded-md px-3 py-2 text-sm text-kumo-subtle hover:text-kumo-default ${focusClassName}`} href="#capabilities">
              {messages.marketing_nav_capabilities()}
            </a>
            <a className={`rounded-md px-3 py-2 text-sm text-kumo-subtle hover:text-kumo-default ${focusClassName}`} href="#security">
              {messages.marketing_nav_security()}
            </a>
            <a className={`rounded-md px-3 py-2 text-sm text-kumo-subtle hover:text-kumo-default ${focusClassName}`} href="#templates">
              {messages.marketing_nav_templates()}
            </a>
          </nav>

          <div className="flex items-center gap-2">
            <LanguageSelector className="hidden sm:flex" />
            <button
              ref={mobileMenuButtonRef}
              type="button"
              aria-label={mobileMenuOpen
                ? messages.marketing_menu_close()
                : messages.marketing_menu_open()}
              aria-controls="marketing-mobile-navigation"
              aria-expanded={mobileMenuOpen}
              onClick={() => setMobileMenuOpen(open => !open)}
              className={`flex h-10 w-10 items-center justify-center rounded-lg border border-kumo-line text-kumo-default hover:bg-kumo-elevated lg:hidden ${focusClassName}`}
            >
              {mobileMenuOpen
                ? <X aria-hidden="true" size={20} />
                : <List aria-hidden="true" size={20} />}
            </button>
          </div>
        </div>
        {mobileMenuOpen && (
          <div id="marketing-mobile-navigation" className="border-t border-kumo-line bg-kumo-base px-4 py-4 lg:hidden">
            <nav aria-label={messages.marketing_header_navigation()} className="mx-auto flex max-w-7xl flex-col">
              <a onClick={() => setMobileMenuOpen(false)} className={`rounded-md px-3 py-2.5 text-sm text-kumo-default ${focusClassName}`} href="#workflow">
                {messages.marketing_nav_workflow()}
              </a>
              <a onClick={() => setMobileMenuOpen(false)} className={`rounded-md px-3 py-2.5 text-sm text-kumo-default ${focusClassName}`} href="#capabilities">
                {messages.marketing_nav_capabilities()}
              </a>
              <a onClick={() => setMobileMenuOpen(false)} className={`rounded-md px-3 py-2.5 text-sm text-kumo-default ${focusClassName}`} href="#security">
                {messages.marketing_nav_security()}
              </a>
              <a onClick={() => setMobileMenuOpen(false)} className={`rounded-md px-3 py-2.5 text-sm text-kumo-default ${focusClassName}`} href="#templates">
                {messages.marketing_nav_templates()}
              </a>
              <div className="mt-3 border-t border-kumo-line px-3 pt-4 sm:hidden">
                <LanguageSelector />
              </div>
            </nav>
          </div>
        )}
      </header>

      <main>
        <section id="marketing-hero" className="mx-auto grid max-w-7xl items-center gap-10 px-4 py-12 sm:px-6 sm:py-16 lg:grid-cols-12 lg:gap-12 lg:px-8 lg:py-20">
          <div className="lg:col-span-5">
            <p className="text-sm font-medium uppercase tracking-[0.14em] text-kumo-brand">
              {messages.marketing_category()}
            </p>
            <h1 className="mt-5 max-w-xl text-4xl font-semibold leading-[1.03] tracking-[-0.055em] text-kumo-default sm:text-5xl lg:text-6xl">
              {messages.marketing_hero_heading()}
            </h1>
            <p className="mt-6 max-w-[54ch] text-base leading-7 text-kumo-subtle sm:text-lg">
              {messages.marketing_hero_description()}
            </p>
            <MarketingActions
              signupAvailable={signupAvailable}
              onSignIn={onSignIn}
              className="mt-8"
            />
          </div>

          <figure className="lg:col-span-7">
            <div className="mx-auto aspect-[9/10] w-full max-w-[360px] overflow-hidden rounded-2xl border border-kumo-line bg-kumo-elevated p-1.5 shadow-[0_24px_64px_-36px_color-mix(in_srgb,var(--color-kumo-brand)_38%,transparent)] sm:aspect-[8/5] sm:max-w-none">
              <picture>
                <source media="(max-width: 640px)" srcSet={`${mobileScreenshot} 360w`} />
                <img
                  src={screenshot}
                  alt={messages.marketing_product_evidence_alt()}
                  width={1440}
                  height={900}
                  loading="eager"
                  fetchPriority="high"
                  decoding="async"
                  className="h-full w-full rounded-xl object-cover object-left-top"
                />
              </picture>
            </div>
            <figcaption className="mx-auto mt-3 max-w-2xl text-center text-xs leading-5 text-kumo-subtle">
              {messages.marketing_product_evidence_caption()}
            </figcaption>
          </figure>
        </section>

        <section id="workflow" className="border-y border-kumo-line bg-kumo-elevated">
          <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-24">
            <div className="max-w-2xl">
              <h2 className="text-3xl font-semibold tracking-[-0.04em] text-kumo-default sm:text-4xl">
                {messages.marketing_workflow_heading()}
              </h2>
              <p className="mt-4 max-w-[60ch] text-base leading-7 text-kumo-subtle">
                {messages.marketing_workflow_description()}
              </p>
            </div>

            <div className="mt-12 grid gap-8 md:grid-cols-12 md:gap-0">
              {workflow.map((item) => {
                const Icon = item.icon
                return (
                  <article key={item.title} className={`${item.className} border-l border-kumo-line pl-5 pr-6`}>
                    <Icon aria-hidden="true" size={22} weight="duotone" className="text-kumo-brand" />
                    <h3 className="mt-5 text-lg font-semibold text-kumo-default">{item.title}</h3>
                    <p className="mt-2 max-w-[38ch] text-sm leading-6 text-kumo-subtle">
                      {item.description}
                    </p>
                  </article>
                )
              })}
            </div>
          </div>
        </section>

        <section id="capabilities" className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-semibold tracking-[-0.04em] text-kumo-default sm:text-4xl">
              {messages.marketing_capabilities_heading()}
            </h2>
            <p className="mt-4 max-w-[60ch] text-base leading-7 text-kumo-subtle">
              {messages.marketing_capabilities_description()}
            </p>
          </div>

          <div className="mt-12 grid grid-cols-1 gap-4 lg:grid-cols-12">
            {capabilities.map((item) => {
              const Icon = item.icon
              return (
                <article key={item.title} className={`${item.className} rounded-2xl border border-kumo-line p-6 sm:p-8`}>
                  <Icon aria-hidden="true" size={24} weight="duotone" className="text-kumo-brand" />
                  <h3 className="mt-8 text-xl font-semibold tracking-[-0.025em] text-kumo-default">
                    {item.title}
                  </h3>
                  <p className="mt-2 max-w-[52ch] text-sm leading-6 text-kumo-subtle">
                    {item.description}
                  </p>
                </article>
              )
            })}
          </div>
        </section>

        <section id="security" className="border-y border-kumo-line bg-kumo-tint">
          <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
            <div className="max-w-2xl">
              <h2 className="text-3xl font-semibold tracking-[-0.04em] text-kumo-default sm:text-4xl">
                {messages.marketing_security_heading()}
              </h2>
              <p className="mt-4 max-w-[60ch] text-base leading-7 text-kumo-subtle">
                {messages.marketing_security_description()}
              </p>
            </div>

            <div className="mt-12 grid gap-8 md:grid-cols-3">
              {security.map((item) => {
                const Icon = item.icon
                return (
                  <article key={item.title}>
                    <Icon aria-hidden="true" size={26} weight="duotone" className="text-kumo-brand" />
                    <h3 className="mt-5 text-lg font-semibold text-kumo-default">{item.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-kumo-subtle">{item.description}</p>
                  </article>
                )
              })}
            </div>
          </div>
        </section>

        <section id="templates" className="mx-auto grid max-w-7xl gap-12 px-4 py-20 sm:px-6 md:grid-cols-2 lg:px-8 lg:py-28">
          <div className="max-w-xl">
            <h2 className="text-3xl font-semibold tracking-[-0.04em] text-kumo-default sm:text-4xl">
              {messages.marketing_templates_heading()}
            </h2>
            <p className="mt-4 max-w-[58ch] text-base leading-7 text-kumo-subtle">
              {messages.marketing_templates_description()}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
            <article className="rounded-2xl border border-kumo-line bg-kumo-elevated p-6">
              <SquaresFour aria-hidden="true" size={24} weight="duotone" className="text-kumo-brand" />
              <h3 className="mt-8 text-lg font-semibold text-kumo-default">
                {messages.marketing_templates_reuse_title()}
              </h3>
              <p className="mt-2 text-sm leading-6 text-kumo-subtle">
                {messages.marketing_templates_reuse_description()}
              </p>
            </article>
            <article className="rounded-2xl border border-kumo-line bg-kumo-tint p-6">
              <UsersThree aria-hidden="true" size={24} weight="duotone" className="text-kumo-brand" />
              <h3 className="mt-8 text-lg font-semibold text-kumo-default">
                {messages.marketing_collaboration_title()}
              </h3>
              <p className="mt-2 text-sm leading-6 text-kumo-subtle">
                {messages.marketing_collaboration_description()}
              </p>
            </article>
          </div>
        </section>

        <section id="get-started" className="border-t border-kumo-line bg-kumo-elevated">
          <div className="mx-auto max-w-4xl px-4 py-20 text-center sm:px-6 lg:py-24">
            <h2 className="text-3xl font-semibold tracking-[-0.04em] text-kumo-default sm:text-4xl">
              {messages.marketing_final_heading()}
            </h2>
            <p className="mx-auto mt-4 max-w-[52ch] text-base leading-7 text-kumo-subtle">
              {messages.marketing_final_description()}
            </p>
            <MarketingActions
              signupAvailable={signupAvailable}
              onSignIn={onSignIn}
              className="mx-auto mt-8 justify-center"
            />
          </div>
        </section>
      </main>

      <footer className="border-t border-kumo-line bg-kumo-base">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-10 sm:px-6 md:flex-row md:items-end md:justify-between lg:px-8">
          <div>
            <p className="text-lg font-semibold tracking-[-0.035em] text-kumo-default">{siteName}</p>
            <p className="mt-2 max-w-xl text-sm leading-6 text-kumo-subtle">
              {messages.marketing_footer_description()}
            </p>
          </div>
          <LanguageSelector />
        </div>
      </footer>
    </div>
  )
}
