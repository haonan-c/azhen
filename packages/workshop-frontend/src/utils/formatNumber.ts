import { getLocale } from '../paraglide/runtime.js'

export function formatLocaleNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(getLocale(), options).format(value)
}
