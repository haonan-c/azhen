import type {
  GatekeeperOperationRate,
  PublishedApiRate,
} from "@gadgets/workshop-shared/api";

const STABLE_PUBLIC_DIMENSION = /^[A-Za-z0-9@][A-Za-z0-9._:/@-]{0,199}$/;
const DYNAMIC_MCP_METHOD_KEY = /^mcp\.tool\.v1\.[0-9a-f]{64}$/;
const MAX_SOURCE_PAGE_LIMIT = 101;

/** Trusted keyset request used between the server and one rate-data owner. */
export type PublishedApiRateSourceRequest = {
  /** Composite method key after which the page starts. */
  cursorKey?: string;
  /** Maximum source rows to return. */
  limit: number;
};

/** Bounded current configured-rate page returned by the Admin Settings owner. */
export type ConfiguredPublishedApiRatePage = {
  /** Current safe configured rates in stable key order. */
  rates: GatekeeperOperationRate[];
  /** Composite key for the next owner page, or null. */
  nextCursorKey: string | null;
};

/** Bounded discovered-method page returned by one User Usage Account owner. */
export type DiscoveredPublishedApiMethodPage = {
  /** Safe discovered methods in stable key order. */
  methods: Array<Pick<PublishedApiRate, "vendorId" | "billingMethodKey">>;
  /** Composite key for the next owner page, or null. */
  nextCursorKey: string | null;
  /** True while legacy discovery is pending or the durable inventory cap omitted later methods. */
  truncated: boolean;
};

/** Return the stable composite key for one public Gatekeeper method. */
export function publishedApiRateKey(value: Pick<PublishedApiRate,
  "vendorId" | "billingMethodKey">): string {
  return `${value.vendorId}\n${value.billingMethodKey}`;
}

/** Return whether one composite method key contains two safe stable dimensions. */
export function isPublishedApiRateKey(value: string): boolean {
  const parts = value.split("\n");
  return parts.length === 2 && parts.every(part => STABLE_PUBLIC_DIMENSION.test(part));
}

/** Return whether a method identity is safe for the User-visible public rate inventory. */
export function isPublicPublishedApiMethod(value: Pick<PublishedApiRate,
  "vendorId" | "billingMethodKey">): boolean {
  if (!STABLE_PUBLIC_DIMENSION.test(value.vendorId) ||
      !STABLE_PUBLIC_DIMENSION.test(value.billingMethodKey)) return false;
  if (value.vendorId !== "mcp" && value.vendorId !== "mcp_portal") return true;
  return DYNAMIC_MCP_METHOD_KEY.test(value.billingMethodKey);
}

/** Validate a bounded trusted owner-page request. */
export function normalizePublishedApiRateSourceRequest(
    request: PublishedApiRateSourceRequest): PublishedApiRateSourceRequest {
  if (typeof request !== "object" || request === null || Array.isArray(request) ||
      Object.keys(request).some(key => key !== "cursorKey" && key !== "limit") ||
      !Number.isSafeInteger(request.limit) || request.limit < 1 ||
      request.limit > MAX_SOURCE_PAGE_LIMIT ||
      (request.cursorKey !== undefined &&
        (typeof request.cursorKey !== "string" || !isPublishedApiRateKey(request.cursorKey)))) {
    throw new TypeError("Published API Rate source page request is invalid.");
  }
  return request;
}
