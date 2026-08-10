import { changeLocale } from '../locale'
import { getLocale, type Locale } from '../paraglide/runtime.js'
import { m as messages } from '../paraglide/messages.js'

export default function LanguageSelector({ className = '' }: { className?: string }) {
  return (
    <label className={`flex items-center gap-2 text-xs text-kumo-subtle ${className}`}>
      <span>{messages.language_label()}</span>
      <select
        aria-label={messages.language_label()}
        value={getLocale()}
        onChange={event => changeLocale(event.target.value as Locale)}
        className="h-8 cursor-pointer rounded-md border border-kumo-line bg-kumo-base px-2 text-sm text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
      >
        <option value="en">{messages.language_english()}</option>
        <option value="zh">{messages.language_chinese()}</option>
      </select>
    </label>
  )
}
