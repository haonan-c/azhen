import { BRAND_NAME, type SiteLocale } from '@gadgets/site-config'
import MarketingLandingPage from '../MarketingLandingPage'
import { marketingFaq } from '../marketingContent'
import type { SitePagePrerenderer } from '../marketing-prerender'
import { m as messages } from '../paraglide/messages.js'

const marketingLandingPage: SitePagePrerenderer = {
  component: () => <MarketingLandingPage onSignIn={() => undefined} />,
  metadata: (locale: SiteLocale) => {
    const faq = marketingFaq(locale)
    return {
      description: messages.marketing_meta_description({}, { locale }),
      openGraphDescription: messages.marketing_og_description({}, { locale }),
      openGraphTitle: messages.marketing_og_title({}, { locale }),
      structuredData: [
        {
          '@context': 'https://schema.org',
          '@type': 'Organization',
          name: BRAND_NAME,
        },
        {
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: BRAND_NAME,
        },
        {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: faq.map(({ question, answer }) => ({
            '@type': 'Question',
            name: question,
            acceptedAnswer: {
              '@type': 'Answer',
              text: answer,
            },
          })),
        },
      ],
      title: messages.marketing_document_title({}, { locale }),
    }
  },
}

export default marketingLandingPage
