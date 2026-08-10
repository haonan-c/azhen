import { getLocale } from '../paraglide/runtime.js'

export function CountBadge({
  count,
  tone = 'tint',
  max = 9,
  className = '',
}: {
  count: number
  tone?: 'solid' | 'tint'
  max?: number
  className?: string
}) {
  if (count <= 0) return null

  const toneClassName = tone === 'solid'
    ? 'border border-kumo-base bg-kumo-brand text-white'
    : 'bg-kumo-brand/15 text-kumo-strong'

  return (
    <span
      className={`grid h-4 min-w-4 flex-shrink-0 place-items-center rounded-full px-1 text-[10px] font-semibold leading-none tabular-nums ${toneClassName} ${className}`}
    >
      {count > max
        ? `${new Intl.NumberFormat(getLocale()).format(max)}+`
        : new Intl.NumberFormat(getLocale()).format(count)}
    </span>
  )
}
