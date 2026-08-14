import { createFileRoute } from '@tanstack/react-router'
import { BookOpen, Sparkle, type Icon as PhosphorIcon } from '@phosphor-icons/react'
import { useDocumentTitle } from '../useDocumentTitle'
import ComingSoonPreview from '../components/ComingSoonPreview'
import { useSiteName } from '../ServerConfigContext'
import { m as messages } from '../paraglide/messages.js'
import { formatLocaleNumber } from '../utils/formatNumber'

/**
 * Context & Skills. The knowledge/skills surface isn't built into the rail yet — agents read
 * curated collections of documents (context) and reusable skills. Until then this page shows a
 * frosted design mock so the nav entry has a stable, on-language target.
 */
export const Route = createFileRoute('/context')({
  component: ContextPage,
})

type Kind = 'collection' | 'skill'

interface ContextItem {
  id: string
  name: string
  kind: Kind
  detail: string
  updated: string
}

const TYPE_META: Record<Kind, { label: () => string; Icon: PhosphorIcon }> = {
  collection: { label: messages.context_collection, Icon: BookOpen },
  skill: { label: messages.context_skill, Icon: Sparkle },
}

const documents = (count: number) => messages.context_documents({
  count: formatLocaleNumber(count),
})

const days = (count: number) => messages.context_updated_days({
  count: formatLocaleNumber(count),
})

const weeks = (count: number) => messages.context_updated_weeks({
  count: formatLocaleNumber(count),
})

function mockItems(): ContextItem[] {
  return [
    { id: '1', name: messages.context_item_company_handbook(), kind: 'collection', detail: documents(12), updated: days(2) },
    { id: '2', name: messages.context_item_brand_voice(), kind: 'collection', detail: documents(5), updated: weeks(1) },
    { id: '3', name: messages.context_item_api_reference(), kind: 'collection', detail: documents(28), updated: weeks(1) },
    { id: '4', name: messages.context_item_summarize_meeting(), kind: 'skill', detail: messages.context_reusable_skill(), updated: days(3) },
    { id: '5', name: messages.context_item_sales_playbook(), kind: 'collection', detail: documents(9), updated: weeks(2) },
    { id: '6', name: messages.context_item_customer_email(), kind: 'skill', detail: messages.context_reusable_skill(), updated: weeks(2) },
  ]
}

function ContextRow({ item }: { item: ContextItem }) {
  const { label, Icon } = TYPE_META[item.kind]
  return (
    <div className="flex items-center gap-3 rounded-lg px-3 py-2.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle">
        <Icon size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium tracking-[-0.25px] text-kumo-default">{item.name}</p>
        <p className="mt-0.5 truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
          {label()} · {item.detail}
        </p>
      </div>
      <span className="hidden shrink-0 text-xs tracking-[-0.1px] text-kumo-inactive lg:block">
        {item.updated}
      </span>
    </div>
  )
}

function ContextPage() {
  useDocumentTitle(messages.context_document_title())
  const siteName = useSiteName()
  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-6 sm:px-10">
      <header className="px-3 pb-4 pt-10">
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">
          {messages.context_heading()}
        </h1>
        <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          {messages.context_description()}
        </p>
      </header>

      <ComingSoonPreview
        icon={BookOpen}
        title={messages.context_coming_soon_title({ siteName })}
        description={messages.context_coming_soon_description()}
      >
        <div className="chat-panel min-h-0 flex-1 overflow-y-auto pb-8 pt-1">
          <div className="flex flex-col gap-0.5">
            {mockItems().map((item) => (
              <ContextRow key={item.id} item={item} />
            ))}
          </div>
        </div>
      </ComingSoonPreview>
    </div>
  )
}
