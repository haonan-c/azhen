/** Maximum number of Unicode characters in the product value. */
export const ANONYMOUS_ANGLE_RUN_PRODUCT_MAX_CHARS = 600;

/** Maximum number of Unicode characters in the market value. */
export const ANONYMOUS_ANGLE_RUN_MARKET_MAX_CHARS = 300;

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

/** A stable error code returned by Anonymous Angle Run. */
export type AnonymousAngleRunErrorCode =
  | "invalid_request"
  | "forbidden"
  | "method_not_allowed"
  | "payload_too_large"
  | "unsupported_media_type"
  | "rate_limited"
  | "unavailable";

/** An unsuccessful Anonymous Angle Run response. */
export interface AnonymousAngleRunErrorResponse {
  /** The stable error code for the failed request. */
  error: AnonymousAngleRunErrorCode;
}
