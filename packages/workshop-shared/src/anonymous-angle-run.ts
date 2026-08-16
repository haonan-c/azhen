/** Maximum number of Unicode characters in the product value. */
export const ANONYMOUS_ANGLE_RUN_PRODUCT_MAX_CHARS = 600;

/** Maximum number of Unicode characters in the market value. */
export const ANONYMOUS_ANGLE_RUN_MARKET_MAX_CHARS = 300;

/** Maximum number of Unicode characters in an Ad Angle name. */
export const ANONYMOUS_ANGLE_RUN_NAME_MAX_CHARS = 80;

/** Maximum number of Unicode characters in each detailed Ad Angle field. */
export const ANONYMOUS_ANGLE_RUN_FIELD_MAX_CHARS = 320;

/** A language supported by Anonymous Angle Run. */
export type AnonymousAngleRunLocale = "en" | "zh";

/** The visitor input for one Anonymous Angle Run. */
export interface AnonymousAngleRunRequest {
  /** A non-empty product link or description within the shared product limit. */
  product: string;
  /** A non-empty market or audience within the shared market limit. */
  market: string;
  /** The language for the returned Ad Angles. */
  locale: AnonymousAngleRunLocale;
}

/** One Ad Angle returned by Anonymous Angle Run. */
export interface AnonymousAdAngle {
  /** The short name of the Ad Angle. */
  name: string;
  /** The audience tension that the Ad Angle addresses. */
  tension: string;
  /** The assumption that the Ad Angle tests. */
  hypothesis: string;
  /** The opening Hook that the Ad Angle recommends. */
  openingHook: string;
  /** The reason to spend budget to test the Ad Angle. */
  worthTesting: string;
}

/** A successful Anonymous Angle Run response with exactly three Ad Angles. */
export interface AnonymousAngleRunResponse {
  /** The three Ad Angles for the product and market. */
  angles: readonly [AnonymousAdAngle, AnonymousAdAngle, AnonymousAdAngle];
}

/** Every stable error code returned by Anonymous Angle Run. */
export const ANONYMOUS_ANGLE_RUN_ERROR_CODES = [
  "invalid_request",
  "forbidden",
  "method_not_allowed",
  "payload_too_large",
  "unsupported_media_type",
  "rate_limited",
  "unavailable",
] as const;

/** A stable error code returned by Anonymous Angle Run. */
export type AnonymousAngleRunErrorCode = typeof ANONYMOUS_ANGLE_RUN_ERROR_CODES[number];

/** An unsuccessful Anonymous Angle Run response. */
export interface AnonymousAngleRunErrorResponse {
  /** The stable error code for the failed request. */
  error: AnonymousAngleRunErrorCode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const length = [...normalized].length;
  if (length < 1 || length > maxChars) return null;
  return normalized;
}

function normalizeAdAngle(value: unknown): AnonymousAdAngle | null {
  if (!isRecord(value)) return null;
  const name = normalizedString(value.name, ANONYMOUS_ANGLE_RUN_NAME_MAX_CHARS);
  const tension = normalizedString(value.tension, ANONYMOUS_ANGLE_RUN_FIELD_MAX_CHARS);
  const hypothesis = normalizedString(value.hypothesis, ANONYMOUS_ANGLE_RUN_FIELD_MAX_CHARS);
  const openingHook = normalizedString(value.openingHook, ANONYMOUS_ANGLE_RUN_FIELD_MAX_CHARS);
  const worthTesting = normalizedString(value.worthTesting, ANONYMOUS_ANGLE_RUN_FIELD_MAX_CHARS);
  if (!name || !tension || !hypothesis || !openingHook || !worthTesting) return null;
  return { name, tension, hypothesis, openingHook, worthTesting };
}

/** Validate and normalize an unknown Anonymous Angle Run request. */
export function normalizeAnonymousAngleRunRequest(
  value: unknown,
): AnonymousAngleRunRequest | null {
  if (!isRecord(value)) return null;
  const product = normalizedString(value.product, ANONYMOUS_ANGLE_RUN_PRODUCT_MAX_CHARS);
  const market = normalizedString(value.market, ANONYMOUS_ANGLE_RUN_MARKET_MAX_CHARS);
  const locale = value.locale;
  if (!product || !market || (locale !== "en" && locale !== "zh")) return null;
  return { product, market, locale };
}

/** Validate and normalize an unknown successful Anonymous Angle Run response. */
export function normalizeAnonymousAngleRunResponse(
  value: unknown,
): AnonymousAngleRunResponse | null {
  if (!isRecord(value) || !Array.isArray(value.angles) || value.angles.length !== 3) return null;
  const first = normalizeAdAngle(value.angles[0]);
  const second = normalizeAdAngle(value.angles[1]);
  const third = normalizeAdAngle(value.angles[2]);
  if (!first || !second || !third) return null;
  return { angles: [first, second, third] };
}

/** Return whether an unknown value is an Anonymous Angle Run error response. */
export function isAnonymousAngleRunErrorResponse(
  value: unknown,
): value is AnonymousAngleRunErrorResponse {
  return isRecord(value) && typeof value.error === "string" &&
    (ANONYMOUS_ANGLE_RUN_ERROR_CODES as readonly string[]).includes(value.error);
}
