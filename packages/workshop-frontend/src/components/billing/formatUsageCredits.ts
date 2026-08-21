import { USAGE_CREDIT_SUBUNITS_PER_CREDIT } from "@gadgets/workshop-shared/api";
import { getLocale } from "../../paraglide/runtime.js";

/** Format exact Usage Credit subunits without converting the financial value to a number. */
export function formatUsageCreditSubunits(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / USAGE_CREDIT_SUBUNITS_PER_CREDIT;
  const fraction = (absolute % USAGE_CREDIT_SUBUNITS_PER_CREDIT)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");
  const formatter = new Intl.NumberFormat(getLocale());
  const decimal = formatter.formatToParts(1.1)
    .find((part) => part.type === "decimal")?.value ?? ".";
  return `${negative ? "-" : ""}${formatter.format(whole)}` +
    (fraction.length > 0 ? `${decimal}${fraction}` : "");
}
