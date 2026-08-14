import type { SiteLocale } from '@gadgets/site-config'
import { m as messages } from './paraglide/messages.js'

/** One localized FAQ item used by the visible page and FAQPage structured data. */
export interface MarketingFaqItem {
  question: string
  answer: string
}

/** Return the eight localized Marketing Landing Page FAQ items. */
export function marketingFaq(locale: SiteLocale): readonly MarketingFaqItem[] {
  const options = { locale }
  return [
    {
      question: messages.marketing_faq_q1({}, options),
      answer: messages.marketing_faq_a1({}, options),
    },
    {
      question: messages.marketing_faq_q2({}, options),
      answer: messages.marketing_faq_a2({}, options),
    },
    {
      question: messages.marketing_faq_q3({}, options),
      answer: messages.marketing_faq_a3({}, options),
    },
    {
      question: messages.marketing_faq_q4({}, options),
      answer: messages.marketing_faq_a4({}, options),
    },
    {
      question: messages.marketing_faq_q5({}, options),
      answer: messages.marketing_faq_a5({}, options),
    },
    {
      question: messages.marketing_faq_q6({}, options),
      answer: messages.marketing_faq_a6({}, options),
    },
    {
      question: messages.marketing_faq_q7({}, options),
      answer: messages.marketing_faq_a7({}, options),
    },
    {
      question: messages.marketing_faq_q8({}, options),
      answer: messages.marketing_faq_a8({}, options),
    },
  ]
}
