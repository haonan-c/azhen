// This file defines the API spoken between the Gadgets Workshop service and the front-end UI.
//
// The UI is a good old "fat client" SPA. Why not use SSR? Because:
// - Users of this UI are likely to have it open often, maybe even all the time. Startup time is
//   less of a concern than with sites you visit only briefly, and assets are likely to be in cache
//   in any case.
// - The Gadgets themselves are sandboxed on the client side in addition to the server side. This
//   sandboxing requires running code in the browser. It is not plausible to server-side render
//   a Gadget itself.
// - By providing a really clean API boundary between client and server, we make it easier to build
//   alternative clients.
// - SPA is just easier to think about.
//
// The entire API between the client and server is an RPC API, using Cloudflare's JavaScript RPC,
// which essentially allows natural JavaScript / TypeScript interfaces to be exposed over the
// network.
//
// The RPC interface operates over a WebSocket, which the client starts immediately at startup and
// keeps open for the entire lifetime of the session, reconnecting if needed.
//
// Gadgets run inside a sandboxed iframe which has no ability to talk to the outside world at all,
// except postMessage() to the parent frame. Through postMessage() exchanges, the Gadget can speak
// RPC to the Workshop. Among other things, through this interface, the Workshop provides the
// Gadget a stub pointing to the Gadget's server-side Durable Object interface.

import { RpcCompatible, RpcStub, RpcTarget } from "capnweb";
import { AccountDescription, ActionKind, ActionDescription, AvatarImage, GatekeeperUiFrame, ObservationDescription, ResourceDescription, ResourceConfiguratorFrame, SupportedResource, VendorDescription, HookDescription } from "./gatekeeper.js";
import type { UiFeatureFlags } from "./feature-flags.js";

export const SERVICE_SALT = new Uint8Array([
  0xd9, 0x4e, 0x54, 0x1d, 0x29, 0xc1, 0x03, 0x74, 0x73, 0x7e, 0xb3, 0xe3, 0x34, 0x6d, 0x8f, 0x21
]);

/**
 * A pending gatekeeper sign-in attempt, returned by `PublicApi.startGatekeeperLogin()`. Holding this
 * stub is the capability to receive the resulting session token; dispose it to abandon the attempt.
 */
export interface LoginAttempt extends RpcTarget {
  /**
   * Resolves with a session token (to store and pass to `authenticate()`, same format as `login()`)
   * once the gatekeeper popup completes, or rejects if the attempt fails or is abandoned. Safe to
   * call immediately after `startGatekeeperLogin()`.
   */
  wait(): Promise<string>;
}

/** Public API exposed to the internet. */
export interface PublicApi extends RpcTarget {
  /**
   * Returns deployment-level configuration the client needs at boot (auth mode, available sign-in
   * vendors, whether the Cloudflare limits flow is enabled). Contains no secrets.
   */
  getServerConfig(): Promise<ServerConfig>;

  /**
   * Begin a sign-in via an authentication gatekeeper (e.g. "google", "github", "cloudflare").
   * Returns a `url` the client opens in a new tab (the gatekeeper's OAuth popup, which self-closes)
   * and an `attempt` stub whose `wait()` resolves once the popup completes. The vendor must be
   * auth-capable and allowlisted (see ServerConfig.authVendors); throws otherwise.
   *
   * Dispose `attempt` to abandon the sign-in (e.g. the user closed the popup); this cancels the wait
   * server-side.
   */
  startGatekeeperLogin(vendorId: string): Promise<{ url: string; attempt: RpcStub<LoginAttempt> }>;

  /** Authenticates the user using an auth token (typically stored in localStorage). */
  authenticate(token: string): Promise<AuthenticatedApi>;

  /**
   * Like authenticate() but the server is expected to be sitting behind Cloudflare Access, and the
   * client is expected to have already authenticated with Access (before they could load the
   * application in their browser at all). The credentials from the Cloudflare Access session will
   * be used to authenticate the user.
   */
  authenticateFromCfAccess(): Promise<AuthenticatedApi>;

  /**
   * Login with username and password.
   *
   * Returns a token to store in local storage and pass to `authenticate()` in the future.
   *
   * Returns null if login failed (no such user or wrong password).
   *
   * `passwordHash` is derived from the user's password as follows:
   *
   *     argon2id({
   *       password,
   *       salt: SERVICE_SALT + encode(username, 'utf8'),
   *       parallelism: 1,
   *       iterations: 3,
   *       memorySize: 64MiB,
   *       hashLength: 32,
   *     });
   *
   * Note that the `passwordHash` itself is NOT stored plaintext by the server -- additional
   * hashing is performed server-side. The overall scheme achieves roughly the same security
   * guarantees as traditional server-side password hashing, but with the added benefit that the
   * server never sees the user's password at all, and also the benefit of performing the expensive
   * hash on the client which tends to have more resources available than a busy server.
   *
   * This API may be disabled when the server uses SSO for authentication.
   */
  login(username: string, passwordHash: Uint8Array): Promise<string | null>;

  /**
   * Create a new account. Returns a token to store in local storage and pass to `authenticate()`
   * in the future.
   *
   * Returns null if the username already exists. (Other kinds of errors may throw exceptions.)
   *
   * See login() (above) for an explanation of the password hashing algorithm.
   *
   * This API may be disabled when the server uses SSO for authentication.
   */
  createAccount(username: string, displayName: string, passwordHash: Uint8Array)
      : Promise<string | null>;

  /**
   * Fetch blueprint metadata by ID. Returns null if the blueprint doesn't exist. No
   * authentication required (knowing the ID is sufficient, since a blueprint is "just data").
   */
  getBlueprint(id: string): Promise<BlueprintPublicInfo | null>;

  /**
   * Download a blueprint as a `.gadget` archive stream. The archive contains only
   * BlueprintMetadata plus the current blueprint code snapshot, not the full KV record.
   */
  downloadBlueprint(id: string): Promise<ReadableStream<Uint8Array>>;
}

/** Subscription callback for AuthenticatedApi.subscribeConnectedAccounts(). */
export interface ConnectedAccountsSubscriber {
  /**
   * If `credentialsValid` is false, the account's credentials are known to be expired, and the
   * UI should call reconnectAccount() to fix this if the user tries to select this account.
   */
  add(id: number, description: AccountDescription, vendor: VendorDescription,
      supportedResources: SupportedResource[], credentialsValid: boolean, vendorId: string): void;
  remove(id: number): void;

  /** Called after add() has been called for all accounts known so far. */
  ready(): void;
}

/**
 * When listing gatekeeper vendors or connected accounts, you can filter to only vendors/accounts
 * that support certain features. This type specifies the filter.
 */
export type GatekeeperVendorFilter = {
  /** Filter for vendors that can connect to the given resource. */
  resourceUrl?: string,
};

/** Options for subscribing to connected accounts. */
export type ConnectedAccountsFilter = GatekeeperVendorFilter & {
  /** Ensure and include auto-provisioned accounts forced by deployment policy. */
  includeForcedAutoProvisionedAccounts?: boolean;
};

/**
 * Identifies a workpiece within a workspace. A workpiece is a numbered thing the user (or agent)
 * is working on inside the workspace -- currently a gadget or a gatekeeper (connection), with
 * more types expected later. All workpiece types share one sequential per-workspace ID namespace,
 * so a bare number unambiguously identifies a workpiece of any type, and derived names (Yjs file
 * roots, facet names) can never collide across types.
 */
export type WorkpieceId = number;

// Matches an ASCII JavaScript identifier, excluding `$`. Deliberately conservative: binding
// names are typed by agents and rendered as `env.NAME`, so full Unicode identifier support buys
// nothing; and while `$` is technically legal in identifiers, it is conventionally reserved for
// special circumstances like code generators, so agents shouldn't be using it.
const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ECMAScript reserved words (including strict-mode reservations and literals), which are valid
// per IDENTIFIER_REGEX but cannot follow `.` in all contexts and would confuse both agents and
// humans as binding names.
const RESERVED_WORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
  "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import",
  "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with",
  // Strict-mode / contextual reservations.
  "await", "implements", "interface", "let", "package", "private", "protected", "public",
  "static", "yield",
]);

/**
 * Validates a binding name, throwing a descriptive Error if it is unacceptable. This is the one
 * shared validator applied at every chokepoint that writes a binding name (gadget binding edges,
 * the workspace default binding list, chat binding maps, spawner env configs, and the agent
 * tools), wherever the map is keyed.
 *
 * A valid name is a JavaScript identifier (see IDENTIFIER_REGEX; reserved words excluded) that is
 * not a dangerous or confusing property name: anything that exists on `Object.prototype`
 * (`__proto__`, `constructor`, `hasOwnProperty`, `toString`, etc.) or `prototype` is rejected,
 * since binding maps are used as plain objects where such names would collide with inherited
 * members -- or worse, mutate the prototype chain.
 *
 * ALL_CAPS_WITH_UNDERSCORES is style guidance only (recommended in tool descriptions and used by
 * generated names), not enforced here.
 */
export function validateBindingName(name: string): void {
  if (!IDENTIFIER_REGEX.test(name)) {
    throw new Error(
        `Invalid binding name "${name}": binding names must be JavaScript identifiers ` +
        `(letters, digits, and '_', not starting with a digit).`);
  }
  if (RESERVED_WORDS.has(name)) {
    throw new Error(`Invalid binding name "${name}": this is a reserved word in JavaScript.`);
  }
  if (name === "prototype" || name in Object.prototype) {
    throw new Error(
        `Invalid binding name "${name}": this name collides with a built-in object property.`);
  }
}

/** Stable codes for Workshop-authored observer binding failures. */
export const OBSERVER_BINDING_FAILURE_CODES = {
  accountDisconnected: "ACCOUNT_DISCONNECTED",
} as const;

/** A stable Workshop-authored observer binding failure code. */
export type ObserverBindingFailureCode =
    typeof OBSERVER_BINDING_FAILURE_CODES[keyof typeof OBSERVER_BINDING_FAILURE_CODES];

/**
 * Why a previously-configured observer binding failed verification on this open attempt. Attached to
 * the ObserverBindingNeed the overseer re-prompts with, so the client can explain what went wrong
 * instead of dead-ending the open.
 */
export type ObserverBindingFailure = {
  /**
   * The account that was tried and rejected (a ConnectedAccountRecord id in the opening user's own
   * User DO). Re-authenticating it in place is usually the fix, so the client should pre-select it
   * and aim its re-authenticate affordance at it. May no longer exist, if the user disconnected it.
   */
  accountId: number;
  /**
   * Human-readable explanation for display: either the error the gatekeeper threw when it refused
   * the account, or a message the overseer authored itself for a cause it can see directly (e.g.
   * the chosen account is no longer connected). Free text: MUST NOT be parsed or matched on.
   */
  reason: string;
  /**
   * Present when the Workshop authored `reason`; clients localize this code and treat `reason` as a
   * backwards-compatible fallback. Absent for Gatekeeper/Vendor free text, which stays unchanged.
   */
  reasonCode?: ObserverBindingFailureCode;
};

/**
 * Describes one connection a non-owner must verify using one of their own accounts. Passed to
 * ObserverConfigCallback.configure() when the opening user needs to choose an account; its result
 * echoes `gatekeeperId` in an ObserverAccountChoice.
 */
export type ObserverBindingNeed = {
  /** The overseer-assigned gatekeeper id (a workpiece id). */
  gatekeeperId: WorkpieceId;
  /**
   * The vendor the user must have a connected account for (e.g. "google"). The frontend filters
   * the user's connected accounts by this to find candidates.
   */
  vendorId: string;
  /**
   * Human-readable resource title, for display in the configuration modal. May be empty when the
   * connector has no title; clients must then supply a localized generic fallback.
   */
  resourceTitle: string;
  /** Canonical resource URL, if known, for display. */
  resourceUrl?: string;
  /**
   * Set only when this binding was already configured but its chosen account failed verification on
   * this attempt (expired credentials, a revoked grant, an upstream outage, or a genuine denial).
   * Absent for a binding that has simply never been configured. Deliberately carries no
   * "credentials valid" flag: the client already has that live from subscribeConnectedAccounts, and
   * a copy on the wire would go stale while the modal is open across an OAuth round trip.
   */
  failure?: ObserverBindingFailure;
};

/**
 * The opening user's chosen account for a single gatekeeper binding. Returned from
 * ObserverConfigCallback.configure().
 */
export type ObserverAccountChoice = {
  /** Matches the ObserverBindingNeed.gatekeeperId being satisfied. */
  gatekeeperId: WorkpieceId;
  /** An account in the opening user's own User DO (a ConnectedAccountRecord id). */
  accountId: number;
};

/**
 * Provided by the client when opening a gadget. Invoked by the overseer ONLY if the opening user
 * must choose connected accounts for one or more gatekeeper bindings before they can observe the
 * gadget. In the common case (owner, or an already-configured observer) this is never called and
 * open() resolves without an extra round trip. The overseer does not resolve open() until this
 * returns. If the user cannot or will not provide the needed accounts, the callback should reject,
 * and the overseer denies the open.
 *
 * `configure()` may be called a second time within one open, for the subset of bindings that failed
 * verification (each carrying an ObserverBindingNeed.failure). This lets the user repair a binding --
 * typically by re-authenticating the account whose credentials expired -- without leaving the flow.
 * The overseer bounds the number of such re-prompts, so a client that resubmits an account that
 * keeps failing eventually gets a denial rather than an endless loop.
 */
export interface ObserverConfigCallback extends RpcTarget {
  configure(needs: ObserverBindingNeed[]): Promise<ObserverAccountChoice[]>;
}

/** Builds the create/read helpers for a family of expected errors carrying stable
 * machine-readable codes. The per-code messages double as the classification fallback for errors
 * from older deployments that lost the code in transit, so changing one is a compatibility break. */
function codedErrorFamily<Code extends string>(messages: Record<Code, string>) {
  const codes = new Set<unknown>(Object.keys(messages));
  return {
    create: (code: Code): Error & { code: Code } =>
        Object.assign(new Error(messages[code]), { code }),
    getCode: (error: unknown): Code | undefined => {
      const candidate = typeof error === "object" && error !== null && "code" in error
          ? error.code : undefined;
      return codes.has(candidate) ? candidate as Code : undefined;
    },
  };
}

/** Stable error codes attached to expected failures from `AuthenticatedApi.openGadget()`. */
export const OPEN_GADGET_ERROR_CODES = {
  workspaceNotFound: "WORKSPACE_NOT_FOUND",
  workspaceAccessDenied: "WORKSPACE_ACCESS_DENIED",
  observerAccountsRequired: "OBSERVER_ACCOUNTS_REQUIRED",
  observerVerificationFailed: "OBSERVER_VERIFICATION_FAILED",
} as const;

/** An expected failure code from `AuthenticatedApi.openGadget()`. */
export type OpenGadgetErrorCode =
    typeof OPEN_GADGET_ERROR_CODES[keyof typeof OPEN_GADGET_ERROR_CODES];

/**
 * One structured observer failure attached to an expected `openGadget()` error, with exactly one
 * Gatekeeper/Vendor reason or Workshop-authored reason code.
 */
export type OpenGadgetObserverFailure = {
  /**
   * User- or connector-provided resource title. Clients preserve a non-empty value unchanged and
   * supply a localized generic fallback when it is empty.
   */
  resourceTitle: string;
  /** User- or connector-provided account label. Absent after the account is disconnected. */
  accountLabel?: string;
} & ({
  /** Non-blank Gatekeeper/Vendor free text, preserved unchanged. */
  reason: string;
  reasonCode?: never;
} | {
  reason?: never;
  /** Stable code for a Workshop-authored reason that the client must localize. */
  reasonCode: ObserverBindingFailureCode;
});

const OPEN_GADGET_ERROR_MESSAGES: Record<OpenGadgetErrorCode, string> = {
  [OPEN_GADGET_ERROR_CODES.workspaceNotFound]: "Workspace not found.",
  [OPEN_GADGET_ERROR_CODES.workspaceAccessDenied]: "You don't have access to this workspace.",
  [OPEN_GADGET_ERROR_CODES.observerAccountsRequired]: "Observer accounts are required.",
  [OPEN_GADGET_ERROR_CODES.observerVerificationFailed]: "Observer verification failed.",
};

const openGadgetErrors = codedErrorFamily(OPEN_GADGET_ERROR_MESSAGES);

/** Creates an expected `openGadget()` error with a code and optional structured observer failures. */
export function createOpenGadgetError(
    code: OpenGadgetErrorCode,
    observerFailures?: OpenGadgetObserverFailure[]):
    Error & { code: OpenGadgetErrorCode; observerFailures?: OpenGadgetObserverFailure[] } {
  return Object.assign(openGadgetErrors.create(code),
      observerFailures ? {observerFailures} : undefined);
}

/** Reads the machine-readable code from an expected `openGadget()` error. */
export const getOpenGadgetErrorCode = openGadgetErrors.getCode;

/** Stable error codes attached to authentication failures. */
export const AUTH_ERROR_CODES = {
  invalidSessionToken: "INVALID_SESSION_TOKEN",
  notAuthenticatedWithAccess: "NOT_AUTHENTICATED_WITH_ACCESS",
} as const;

/** Reads validated structured observer failures from an expected `openGadget()` error. */
export function getOpenGadgetObserverFailures(
    error: unknown): OpenGadgetObserverFailure[] | undefined {
  if (getOpenGadgetErrorCode(error) !== OPEN_GADGET_ERROR_CODES.observerVerificationFailed ||
      typeof error !== "object" || error === null || !("observerFailures" in error) ||
      !Array.isArray(error.observerFailures)) {
    return undefined;
  }

  return error.observerFailures.every(isOpenGadgetObserverFailure)
    ? error.observerFailures
    : undefined;
}

function isOpenGadgetObserverFailure(value: unknown): value is OpenGadgetObserverFailure {
  if (typeof value !== "object" || value === null ||
      !("resourceTitle" in value) || typeof value.resourceTitle !== "string") {
    return false;
  }
  if ("accountLabel" in value && value.accountLabel !== undefined &&
      typeof value.accountLabel !== "string") {
    return false;
  }
  const hasReason = "reason" in value;
  const hasReasonCode = "reasonCode" in value;
  if (hasReason === hasReasonCode) return false;

  if (hasReason) {
    return typeof value.reason === "string" && value.reason.trim().length > 0;
  }
  return "reasonCode" in value &&
      value.reasonCode === OBSERVER_BINDING_FAILURE_CODES.accountDisconnected;
}

/** An expected authentication failure code. */
export type AuthErrorCode = typeof AUTH_ERROR_CODES[keyof typeof AUTH_ERROR_CODES];

/** Messages for auth failures thrown without a surviving code; clients match these only as a
 * classification fallback. */
export const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  [AUTH_ERROR_CODES.invalidSessionToken]: "invalid session token",
  [AUTH_ERROR_CODES.notAuthenticatedWithAccess]: "Not authenticated with Access.",
};

const authErrors = codedErrorFamily(AUTH_ERROR_MESSAGES);

/** Creates an authentication failure with a machine-readable code. */
export const createAuthError = authErrors.create;

/** Reads the machine-readable code from an authentication failure. */
export const getAuthErrorCode = authErrors.getCode;

/**
 * Number of exact integer subunits in one Usage Credit. The 10^18 scale keeps amounts exact even
 * when later metering applies very small provider rates.
 */
export const USAGE_CREDIT_SUBUNITS_PER_CREDIT = 1_000_000_000_000_000_000n;

/** One durable activation notice shown only to a returning legacy User. */
export type UsageCreditActivationNotice = {
  /** Stable identifier used for an idempotent acknowledgement. */
  id: string;
  /** Exact Initial Grant that activated this User's Usage Account. */
  grantedSubunits: bigint;
  /** Canonical UTC time when the User's Usage Account was activated. */
  activatedAt: string;
};

/** The authenticated User's authoritative Usage Credit balance and notice state. */
export type UsageCreditBalance = {
  /** Credit that can be reserved for new Metered Use, in exact integer subunits. */
  availableSubunits: bigint;
  /** Credit currently held by active Credit Reservations, in exact integer subunits. */
  reservedSubunits: bigint;
  /** Durable monotonic revision for ordering initial and pushed snapshots. */
  revision: bigint;
  /** Server-side low-balance decision derived from this User's actual Initial Grant. */
  lowBalance: boolean;
  /** Exact threshold used by the server-side low-balance decision. */
  lowBalanceThresholdSubunits: bigint;
  /** Pending one-time legacy activation notice, or null after acknowledgement or for new Users. */
  activationNotice: UsageCreditActivationNotice | null;
};

/** Callback that receives ordered authoritative Usage Credit balance snapshots. */
export interface UsageCreditBalanceSubscriber {
  /** Receive an initial or later balance snapshot with a durable monotonic revision. */
  update(balance: UsageCreditBalance): void;
}

/** Bounded request for the authenticated User's own Usage Records. */
export type UserUsageRecordPageRequest = {
  /** Opaque cursor returned by the previous page; omit for the first page. */
  cursor?: string;
  /** Optional page size from 1 through 100; defaults to 50. */
  limit?: number;
};

/** Content-free token categories reported for one model inference. */
export type UserModelTokenUsage = {
  /** Input tokens reported as provider cache hits. */
  cacheHitInputTokens: bigint;
  /** Input tokens not reported as provider cache hits. */
  cacheMissInputTokens: bigint;
  /** Total output tokens, already including reasoning-token detail. */
  outputTokens: bigint;
  /** Reasoning-token detail already included in outputTokens. */
  reasoningTokens: bigint;
};

/** Causal origin of one Metered Use. */
export type UsageSource =
  | "agent"
  | "gadget"
  | "direct-user"
  | "system-assistance"
  | "hook"
  | "scheduled";

/** User-safe projection of one model Usage Record. */
export type UserModelUsageRecord = {
  /** Usage Record discriminator. */
  kind: "model";
  /** Opaque stable identifier safe to use as a UI list key. */
  id: string;
  /** Origin of this model inference. */
  source: UsageSource;
  /** Workspace that ran the inference. */
  workspaceId: string;
  /** Conversation that ran the inference. */
  chatId?: number;
  /** App that ran the inference, when applicable. */
  gadgetId?: WorkpieceId;
  /** Stable unattended automation identifier, when applicable. */
  automationId?: string;
  /** Stable identifier for one unattended automation run, when applicable. */
  automationRunId?: string;
  /** Deployment Model selected for the inference. */
  deploymentModelId: string;
  /** Whether the immutable Charge Snapshot had a configured rate. */
  pricing: "priced" | "unpriced";
  /** Durable terminal outcome of the Metering Attempt. */
  outcome: "settled" | "failed-before-execution" | "usage-unknown" |
    "reconciliation-required";
  /** Whether valid provider token categories were reported. */
  usageStatus: "reported" | "not-reported" | "invalid-report";
  /** Exact provider categories, or null when no valid report exists. */
  usage: UserModelTokenUsage | null;
  /** Exact Usage Credit charged, zero for priced-zero or Unpriced Use, or null when unresolved. */
  chargeSubunits: bigint | null;
  /** Canonical UTC completion time. */
  createdAt: string;
};

/** User-safe, content-free projection of one Gatekeeper API Usage Record. */
export type UserGatekeeperUsageRecord = {
  /** Usage Record discriminator. */
  kind: "gatekeeper";
  /** Opaque stable identifier safe to use as a UI list key. */
  id: string;
  /** Origin of this Gatekeeper operation. */
  source: UsageSource;
  /** Workspace that ran the operation, absent for direct account-management use. */
  workspaceId?: string;
  /** Conversation that ran the operation, when applicable. */
  chatId?: number;
  /** App that ran the operation, when applicable. */
  gadgetId?: WorkpieceId;
  /** Stable unattended automation identifier, when applicable. */
  automationId?: string;
  /** Stable identifier for one unattended automation run, when applicable. */
  automationRunId?: string;
  /** Stable Gatekeeper vendor identifier. */
  vendorId: string;
  /** Stable caller-visible business-method key. */
  billingMethodKey: string;
  /** Whether the immutable Charge Snapshot had a configured rate. */
  pricing: "priced" | "unpriced";
  /** Durable terminal outcome of the Metering Attempt. */
  outcome: "settled" | "failed-before-execution" | "usage-unknown";
  /** Exact Usage Credit charged, zero for priced-zero or Unpriced Use, or null when unresolved. */
  chargeSubunits: bigint | null;
  /** Canonical UTC completion time. */
  createdAt: string;
};

/** User-safe projection of one model or Gatekeeper Usage Record. */
export type UserUsageRecord = UserModelUsageRecord | UserGatekeeperUsageRecord;

/** One bounded page of the authenticated User's own Usage Records. */
export type UserUsageRecordPage = {
  /** Records in descending completion order. */
  records: UserUsageRecord[];
  /** Opaque cursor for the next page, or null when this page is complete. */
  nextCursor: string | null;
};

/** Bounded request for one authenticated User-owned financial list. */
export type UserCreditPageRequest = {
  /** Opaque cursor returned by the previous page; omit for the first page. */
  cursor?: string;
  /** Optional page size from 1 through 100; defaults to 50. */
  limit?: number;
};

/** User-safe projection of one Credit Reservation. */
export type UserCreditReservation = {
  /** Stable Reservation identifier for UI list keys. */
  id: string;
  /** User-visible lifecycle, including held states that require reconciliation. */
  state: "active" | "started" | "unknown-held" | "reconciliation-required" |
    "settled" | "released";
  /** Metered-use category attached to the immutable reservation snapshot. */
  meteredKind: "model" | "gatekeeper";
  /** Exact amount originally held. */
  amountSubunits: bigint;
  /** Exact settled amount, or null while held or after release. */
  settledAmountSubunits: bigint | null;
  /** Stable Gatekeeper vendor identifier for an API reservation. */
  vendorId?: string;
  /** Stable public business-method key for an API reservation. */
  billingMethodKey?: string;
  /** Canonical UTC creation time. */
  createdAt: string;
  /** Canonical UTC terminal time, or null while held. */
  completedAt: string | null;
};

/** One bounded page of the authenticated User's own Credit Reservations. */
export type UserCreditReservationPage = {
  /** User-safe Reservations in stable keyset order. */
  reservations: UserCreditReservation[];
  /** Opaque cursor for the next page, or null when this page is complete. */
  nextCursor: string | null;
};

/** User-safe summary of one Credit Ledger Entry used for bounded relationship expansion. */
export type UserCreditLedgerEntrySummary = {
  /** Stable Ledger Entry identifier. */
  id: string;
  /** Public balance-change category. */
  kind: "initial-grant" | "usage-charge" | "admin-grant" | "admin-deduction" |
    "admin-reconciliation" | "credit-reversal";
  /** Exact signed Usage Credit change. */
  deltaSubunits: bigint;
  /** Canonical UTC creation time. */
  createdAt: string;
};

/** User-safe projection of one Credit Ledger Entry. */
export type UserCreditLedgerEntry = UserCreditLedgerEntrySummary & {
  /** Safe original-entry summary linked by a Credit Reversal, or null. */
  reversalOfLedgerEntry: UserCreditLedgerEntrySummary | null;
  /** Safe Credit Reversal summary that offsets this entry, or null. */
  reversedByLedgerEntry: UserCreditLedgerEntrySummary | null;
};

/** One bounded page of the authenticated User's own Credit Ledger. */
export type UserCreditLedgerPage = {
  /** User-safe Ledger Entries in stable keyset order. */
  entries: UserCreditLedgerEntry[];
  /** Opaque cursor for the next page, or null when this page is complete. */
  nextCursor: string | null;
};

/** One public Gatekeeper method's current Usage Rate or explicit Unpriced state. */
export type PublishedApiRate = {
  /** Stable Gatekeeper vendor identifier. */
  vendorId: string;
  /** Stable caller-visible business-method key. */
  billingMethodKey: string;
  /** Current strong-consistency pricing classification. */
  pricing: "priced" | "unpriced";
  /** Exact Credit per Billable API Operation, or null for Unpriced. */
  amountSubunits: bigint | null;
};

/** Bounded keyset request for current public Gatekeeper Usage Rates. */
export type PublishedApiRatePageRequest = {
  /** Opaque cursor returned by the previous page; omit for the first page. */
  cursor?: string;
  /** Optional page size from 1 through 100; defaults to 50. */
  limit?: number;
};

/** One bounded page of current public Gatekeeper Usage Rates. */
export type PublishedApiRatePage = {
  /** Rates in stable Gatekeeper vendor and billing-method order. */
  rates: PublishedApiRate[];
  /** Opaque cursor for the next page, or null when this page is complete. */
  nextCursor: string | null;
  /** True while the User's bounded dynamic inventory is incomplete or omitted later discoveries. */
  truncated: boolean;
};

/** Number of exact integer rate subunits in one US dollar. */
export const USD_RATE_SUBUNITS_PER_USD = 1_000_000_000_000_000_000n;

/** A non-negative exact rational number in normalized form. */
export type ExactRatio = {
  /** Non-negative numerator. */
  numerator: bigint;
  /** Positive denominator. */
  denominator: bigint;
};

/** Exact provider prices in USD subunits per one million tokens. */
export type ModelTokenRates = {
  /** Price for one million input tokens reported as a provider cache hit. */
  cacheHitUsdSubunitsPerMillion: bigint;
  /** Price for one million input tokens not reported as a provider cache hit. */
  cacheMissUsdSubunitsPerMillion: bigint;
  /** Price for one million output tokens, including reasoning-token detail. */
  outputUsdSubunitsPerMillion: bigint;
};

/** A named tier in one model's daily UTC rate schedule. */
export type DailyUtcModelRateTier = {
  /** Stable tier identifier copied into a Charge Snapshot. */
  id: string;
  /** Exact token prices for this tier. */
  tokenRates: ModelTokenRates;
};

/** One half-open minute range in a daily UTC rate schedule. */
export type DailyUtcModelRateInterval = {
  /** UTC minute of day included in this interval, from 0 through 1,439. */
  startMinuteInclusive: number;
  /** UTC minute of day excluded from this interval, from 1 through 1,440. */
  endMinuteExclusive: number;
  /** Tier selected throughout the interval. */
  tier: string;
};

/** A deterministic provider rate schedule that repeats each UTC day. */
export type DailyUtcModelRateSchedule = {
  /** Schedule discriminator. */
  kind: "daily-utc";
  /** Tier selected when no interval contains the current UTC minute. */
  defaultTier: string;
  /** Complete set of named tiers. */
  tiers: DailyUtcModelRateTier[];
  /** Non-overlapping half-open UTC minute ranges. */
  intervals: DailyUtcModelRateInterval[];
};

/** One model in an immutable deployment Usage Rate version. */
export type ModelUsageRateCatalogEntry = {
  /** Provider that accepts the model identifier. */
  provider: AiModelProvider;
  /** Stable provider model identifier used by the deployment. */
  model: string;
  /** Provider release version represented by this catalog entry. */
  providerModelVersion: string;
  /** Exact daily UTC provider-price schedule. */
  schedule: DailyUtcModelRateSchedule;
  /** Deployment multiplier applied to the complete provider cost. */
  multiplier: ExactRatio;
};

/** One configured fixed Credit rate for a caller-visible Gatekeeper business operation. */
export type GatekeeperOperationRate = {
  /** Stable Gatekeeper vendor identifier. */
  vendorId: string;
  /** Stable business-method key owned by the Gatekeeper. */
  billingMethodKey: string;
  /** Exact Credit charged for one caller-visible operation. */
  amountSubunits: bigint;
};

/** One complete immutable deployment Usage Rate version. */
export type UsageRateVersion = {
  /** Monotonic version number assigned by the authoritative AdminSettings Durable Object. */
  version: bigint;
  /** Canonical UTC time when this version became current. */
  effectiveAt: string;
  /** Repository-owned released model catalog copied into this version. */
  catalogVersion: string;
  /** Exact Credits issued for one US dollar of provider cost. */
  creditConversion: ExactRatio;
  /** Exact initial Usage Credit grant for a new User. */
  initialGrantSubunits: bigint;
  /** IANA time zone used by later Usage reports. */
  reportTimeZone: string;
  /** Complete model catalog, schedules, and deployment multipliers. */
  modelCatalog: ModelUsageRateCatalogEntry[];
  /** Complete configured Gatekeeper business-operation rates. */
  gatekeeperOperationRates: GatekeeperOperationRate[];
};

/** Complete non-secret configuration values captured before or after one audited rate change. */
export type UsageRateAuditValues = Omit<UsageRateVersion, "version" | "effectiveAt">;

/** One secret-free administrator change record linking immutable Usage Rate versions. */
export type UsageRateAudit = {
  /** Version that was current before the change. */
  previousVersion: bigint;
  /** Version created by the change. */
  newVersion: bigint;
  /** Authenticated administrator identity bound by the server. */
  actorUserId: string;
  /** Canonical UTC time assigned by the server. */
  changedAt: string;
  /** Required human explanation for the change. */
  reason: string;
  /** Complete non-secret configuration values before the change. */
  oldValues: UsageRateAuditValues;
  /** Complete non-secret configuration values after the change. */
  newValues: UsageRateAuditValues;
  /** Validated typed changes applied to the previous version. */
  changes: UsageRateChange[];
};

/** Complete administrator view of deployment Usage Rates and immutable history. */
export type UsageRateAdminView = {
  /** Current authoritative version. */
  current: UsageRateVersion;
  /** All immutable versions in ascending version order. */
  versions: UsageRateVersion[];
  /** All administrator change records in ascending version order. */
  audits: UsageRateAudit[];
  /** Catalog version shipped by the running repository release. */
  releasedCatalogVersion: string;
  /** Whether an administrator must explicitly adopt a newer released catalog. */
  catalogUpdateAvailable: boolean;
};

/** A validated administrator request to change one deployment Usage Rate setting. */
export type UsageRateChange =
  | {
      /** Change the exact Credits-per-USD conversion. */
      kind: "credit-conversion";
      /** New positive conversion ratio. */
      value: ExactRatio;
    }
  | {
      /** Change the initial grant for Users created later. */
      kind: "initial-grant";
      /** New non-negative grant in exact Credit subunits. */
      amountSubunits: bigint;
    }
  | {
      /** Change the IANA time zone used by later reports. */
      kind: "report-time-zone";
      /** New canonical or supported IANA time-zone identifier. */
      timeZone: string;
    }
  | {
      /** Change one model's deployment multiplier. */
      kind: "model-multiplier";
      /** Model provider. */
      provider: AiModelProvider;
      /** Stable provider model identifier. */
      model: string;
      /** New non-negative multiplier. */
      value: ExactRatio;
    }
  | {
      /** Add, replace, or remove one Gatekeeper business-operation rate. */
      kind: "gatekeeper-operation-rate";
      /** Stable Gatekeeper vendor identifier. */
      vendorId: string;
      /** Stable business-method key owned by the Gatekeeper. */
      billingMethodKey: string;
      /** Exact per-operation Credit, or null to remove the configured rate. */
      amountSubunits: bigint | null;
    }
  | {
      /** Explicitly copy the repository's released model catalog into a new version. */
      kind: "adopt-released-model-catalog";
    };

/** Immutable initial Usage Credit grant facts issued for one not-yet-initialized User. */
export type InitialGrantSnapshot = {
  /** Snapshot discriminator. */
  kind: "initial-grant";
  /** Usage Rate version current when the snapshot was issued. */
  usageRateVersion: bigint;
  /** Canonical UTC time assigned when the snapshot was issued. */
  issuedAt: string;
  /** Exact Usage Credit grant in Credit subunits. */
  amountSubunits: bigint;
};

/** Immutable pricing facts for one configured model call. */
export type PricedModelChargeSnapshot = {
  /** Metered-use kind. */
  kind: "model";
  /** Confirms that a model rate was configured. */
  pricing: "priced";
  /** Usage Rate version current at the pricing linearization point. */
  usageRateVersion: bigint;
  /** Canonical UTC time assigned at the pricing linearization point. */
  issuedAt: string;
  /** Released catalog copied into the selected Usage Rate version. */
  catalogVersion: string;
  /** Model provider. */
  provider: AiModelProvider;
  /** Stable provider model identifier. */
  model: string;
  /** Provider release version selected by the catalog. */
  providerModelVersion: string;
  /** UTC schedule tier selected at the pricing linearization point. */
  rateTier: string;
  /** Exact provider prices selected for the call. */
  tokenRates: ModelTokenRates;
  /** Deployment multiplier captured for the call. */
  multiplier: ExactRatio;
  /** Credits-per-USD conversion captured for the call. */
  creditConversion: ExactRatio;
};

/** Explicit zero-charge configuration gap for one model identifier. */
export type UnpricedModelChargeSnapshot = {
  /** Metered-use kind. */
  kind: "model";
  /** Confirms that no model rate was configured. */
  pricing: "unpriced";
  /** Usage Rate version current at the pricing linearization point. */
  usageRateVersion: bigint;
  /** Canonical UTC time assigned at the pricing linearization point. */
  issuedAt: string;
  /** Released catalog copied into the selected Usage Rate version. */
  catalogVersion: string;
  /** Model provider. */
  provider: AiModelProvider;
  /** Stable provider model identifier that has no configured rate. */
  model: string;
  /** Exact zero Credit charge required for an Unpriced Use. */
  chargeSubunits: 0n;
  /** Explicit signal that deployment configuration needs attention. */
  configurationGap: true;
};

/** Immutable priced or Unpriced decision for one model call. */
export type ModelChargeSnapshot =
    PricedModelChargeSnapshot | UnpricedModelChargeSnapshot;

/** Immutable fixed-rate facts for one configured Gatekeeper business operation. */
export type PricedGatekeeperChargeSnapshot = {
  /** Metered-use kind. */
  kind: "gatekeeper";
  /** Confirms that an operation rate was configured, including an explicit zero rate. */
  pricing: "priced";
  /** Usage Rate version current at the pricing linearization point. */
  usageRateVersion: bigint;
  /** Canonical UTC time assigned at the pricing linearization point. */
  issuedAt: string;
  /** Stable Gatekeeper vendor identifier. */
  vendorId: string;
  /** Stable caller-visible business-method key. */
  billingMethodKey: string;
  /** Exact Credit charged for one caller-visible operation. */
  chargeSubunits: bigint;
};

/** Explicit zero-charge configuration gap for one Gatekeeper business operation. */
export type UnpricedGatekeeperChargeSnapshot = {
  /** Metered-use kind. */
  kind: "gatekeeper";
  /** Confirms that no operation rate was configured. */
  pricing: "unpriced";
  /** Usage Rate version current at the pricing linearization point. */
  usageRateVersion: bigint;
  /** Canonical UTC time assigned at the pricing linearization point. */
  issuedAt: string;
  /** Stable Gatekeeper vendor identifier. */
  vendorId: string;
  /** Stable caller-visible business-method key with no configured rate. */
  billingMethodKey: string;
  /** Exact zero Credit charge required for an Unpriced Use. */
  chargeSubunits: 0n;
  /** Explicit signal that deployment configuration needs attention. */
  configurationGap: true;
};

/** Immutable priced or Unpriced decision for one Gatekeeper business operation. */
export type GatekeeperChargeSnapshot =
    PricedGatekeeperChargeSnapshot | UnpricedGatekeeperChargeSnapshot;

/** Any immutable priced or Unpriced decision that can explain Metered Use. */
export type ChargeSnapshot = ModelChargeSnapshot | GatekeeperChargeSnapshot;

/** A configured model or Gatekeeper snapshot that can back a positive Credit Reservation. */
export type PricedChargeSnapshot =
    PricedModelChargeSnapshot | PricedGatekeeperChargeSnapshot;

/** Default number of registered Users returned by one administrator Registry search. */
export const ADMIN_USAGE_USER_SEARCH_DEFAULT_LIMIT = 25;

/** Maximum number of registered Users returned by one administrator Registry search. */
export const ADMIN_USAGE_USER_SEARCH_MAX_LIMIT = 100;

/** Bounded directory fields for one User in the authoritative deployment User Registry. */
export type AdminUsageRegisteredUser = {
  /** Opaque stable reference accepted by later administrator Usage Account operations. */
  registeredUserRef: string;
  /** Server-verified User identity captured at first Usage Credit activation. */
  identity: string;
  /** Bounded display name captured at first Usage Credit activation. */
  displayName: string;
  /** Canonical UTC time when the Registry first accepted this User. */
  registeredAt: string;
  /** Canonical UTC time when this User first activated Usage Credits. */
  activatedAt: string;
};

/** One bounded keyset search request for the authoritative deployment User Registry. */
export type AdminUsageUserSearchRequest = {
  /** Optional case-insensitive identity or display-name prefix; empty lists all registered Users. */
  query?: string;
  /** Optional opaque cursor returned by the preceding page for the same normalized query. */
  cursor?: string;
  /** Optional page size from 1 through ADMIN_USAGE_USER_SEARCH_MAX_LIMIT. */
  limit?: number;
};

/** One stable snapshot page from the authoritative deployment User Registry. */
export type AdminUsageUserSearchResult = {
  /** Registered Users in deterministic activation order. */
  users: AdminUsageRegisteredUser[];
  /** Opaque cursor for the next page in the same snapshot, or null when the snapshot is complete. */
  nextCursor: string | null;
};

/** Administrator request for one registered User's content-free Usage Records. */
export type AdminUsageRecordPageRequest = UserUsageRecordPageRequest & {
  /** Opaque target returned by Registry search. */
  registeredUserRef: string;
};

/** Exact authoritative balance components captured around one administrator correction. */
export type AdminUsageBalanceState = {
  /** Sum of every immutable Credit Ledger Entry delta. */
  ledgerBalanceSubunits: bigint;
  /** Sum of every active Credit Reservation amount. */
  reservedSubunits: bigint;
  /** Credit available for new reservations: ledger balance minus reserved Credit. */
  availableSubunits: bigint;
};

/** Operational state of the replaceable deployment Usage Projection. */
export type AdminUsageProjectionState =
  | "healthy"
  | "lagging"
  | "rebuilding"
  | "failed"
  | "unavailable";

/** Content-free health and progress of the replaceable deployment Usage Projection. */
export type AdminUsageProjectionHealth = {
  /** Current projection state. */
  state: AdminUsageProjectionState;
  /** Canonical UTC time of the latest accepted fact, or null before the first fact. */
  lastIngestedAt: string | null;
  /** Canonical UTC source time of the latest applied fact, or null before the first fact. */
  latestAppliedSourceAt: string | null;
  /** Canonical UTC source time of the oldest unapplied Projection sequence entry. */
  oldestPendingAt: string | null;
  /** Exact number of Projection facts or rejection markers still waiting to be applied. */
  pendingEventCount: bigint;
  /** Exact number of User outbox facts still waiting for Projection acknowledgement. */
  deliveryPendingEventCount: bigint;
  /** Exact number of Usage Principals with a source-sequence gap. */
  sequenceGapCount: bigint;
  /** Exact number of failed delivery attempts and rejected invariant-breaking ingestions. */
  failedIngestionCount: bigint;
  /** Bounded machine-readable failure code, or null when no failure is recorded. */
  failureCode: "delivery-failed" | "retention-failed" | "fact-id-conflict" |
    "source-sequence-conflict" | "invalid-fact" | null;
  /** Bounded rebuild failure code, or null when the latest rebuild did not fail. */
  rebuildFailureCode:
    "registry-read-failed" | "user-read-failed" | "projection-write-failed" | null;
  /** Stable rebuild request identity, or null when no rebuild is active. */
  rebuildRequestId: string | null;
  /** Exact number of Registry Users completed by the active rebuild. */
  rebuildUsersProcessed: bigint;
  /** Canonical UTC observation time. */
  asOf: string;
};

/** Exact all-recorded totals held by the replaceable deployment Usage Projection. */
export type AdminUsageOverviewMetrics = {
  /** Provider model cost in exact USD rate subunits. */
  providerCostUsdSubunits: bigint;
  /** Usage Charges in exact Usage Credit subunits. */
  chargedUsageCreditSubunits: bigint;
  /** Model input tokens reported as cache hits. */
  cacheHitInputTokens: bigint;
  /** Model input tokens not reported as cache hits. */
  cacheMissInputTokens: bigint;
  /** Model input tokens written to a provider cache, when reported. */
  cacheWriteInputTokens: bigint;
  /** Total model output tokens, already including reasoning-token detail. */
  outputTokens: bigint;
  /** Reasoning-token detail already included in outputTokens. */
  reasoningTokens: bigint;
  /** Exact count of confirmed Model uses and executed or accepted API operations. */
  meteredUseCount: bigint;
  /** Caller-visible Billable API Operations confirmed as executed or accepted. */
  billableApiOperations: bigint;
  /** Distinct Usage Principals with at least one confirmed Metered Use. */
  activeUsers: bigint;
  /** Unpriced model uses with confirmed provider Usage. */
  unpricedModelUses: bigint;
  /** Unpriced Gatekeeper Billable API Operations confirmed as executed or accepted. */
  unpricedApiOperations: bigint;
};

/** Server-owned sampling window for one deployment capacity review metric. */
export type AdminUsageCapacityWindow =
  | {
      /** The value is an authoritative observation instead of a Projection time range. */
      kind: "authoritative-current";
    }
  | {
      /** The value covers the current canonical UTC day. */
      kind: "utc-day";
      /** Inclusive canonical UTC start of the day. */
      startedAt: string;
    }
  | {
      /** The value covers the rolling thirty-day Projection window. */
      kind: "rolling-thirty-days";
      /** Inclusive canonical UTC start of the rolling window. */
      startedAt: string;
    };

/** One exact integer deployment capacity metric and its 70 percent review state. */
export type AdminUsageCapacityMetric = {
  /** Exact current sampled value. */
  current: bigint;
  /** Exact 100 percent design target. */
  target: bigint;
  /** Exact 70 percent review threshold. */
  reviewThreshold: bigint;
  /** Whether current multiplied by ten is at least target multiplied by seven. */
  reviewRequired: boolean;
  /** Bounded server-owned sampling window. */
  window: AdminUsageCapacityWindow;
  /** Canonical UTC observation time for this value. */
  asOf: string;
};

/** Capacity review telemetry for the fixed usage-capacity-v1 profile. */
export type AdminUsageCapacityReview = {
  /** Stable capacity profile identifier. */
  profileId: "usage-capacity-v1";
  /** Current authoritative registered User count. */
  registeredUsers: AdminUsageCapacityMetric;
  /** Distinct Usage Principals with confirmed Metered Use in the current UTC day. */
  dailyActiveUsers: AdminUsageCapacityMetric;
  /** Confirmed Usage Records in the rolling thirty-day window. */
  rollingThirtyDayRecords: AdminUsageCapacityMetric;
  /** Highest confirmed Usage Record count in one aligned UTC second. */
  alignedOneSecondPeakRecords: AdminUsageCapacityMetric;
  /** Supporting highest confirmed Usage Record count in one aligned UTC minute. */
  alignedSixtySecondPeakRecords: AdminUsageCapacityMetric;
  /** Whether any of the four design targets requires capacity review. */
  reviewRequired: boolean;
};

/** Administrator overview of all Usage Projection facts recorded since metering activation. */
export type AdminUsageOverview = {
  /** Exact totals, or null when the projection is unavailable. */
  metrics: AdminUsageOverviewMetrics | null;
  /** Exact count read from the authoritative User Registry, not the projection. */
  registeredUsers: bigint;
  /** Explicit range contract that #63 can later extend with frozen report filters. */
  range: {kind: "all-recorded"; startedAt: string | null};
  /** Active projection generation. */
  generation: bigint;
  /** Exact count of applied facts in the active generation. */
  ingestionWatermark: bigint;
  /** Structured projection health. */
  health: AdminUsageProjectionHealth;
  /** Canonical UTC observation time. */
  asOf: string;
};

/** Default number of rows returned by one administrator Usage report page. */
export const ADMIN_USAGE_REPORT_DEFAULT_LIMIT = 50;

/** Maximum number of rows returned by one administrator Usage report page. */
export const ADMIN_USAGE_REPORT_MAX_LIMIT = 200;

/** Maximum number of values accepted for one administrator Usage report filter dimension. */
export const ADMIN_USAGE_REPORT_FILTER_VALUE_LIMIT = 32;

/** One Gatekeeper-scoped stable business method selected by an administrator report filter. */
export type AdminUsageReportMethodFilter = {
  /** Stable Gatekeeper vendor identifier that owns the method. */
  gatekeeperId: string;
  /** Stable business-method key that is unique only within that Gatekeeper. */
  stableMethodKey: string;
};

/** Frozen administrator Usage report filter. Different dimensions combine with AND. */
export type AdminUsageReportFilter = {
  /** Inclusive date in the Deployment report timezone, in strict YYYY-MM-DD form. */
  startDateInclusive?: string;
  /** Exclusive date in the Deployment report timezone, in strict YYYY-MM-DD form. */
  endDateExclusive?: string;
  /** Opaque registered User references; values within this dimension combine with OR. */
  registeredUserRefs?: string[];
  /** Stable Gadget identifiers; values within this dimension combine with OR. */
  gadgetIds?: string[];
  /** Stable Deployment Model identifiers; values within this dimension combine with OR. */
  deploymentModelIds?: string[];
  /** Stable Gatekeeper vendor identifiers; values within this dimension combine with OR. */
  gatekeeperIds?: string[];
  /** Gatekeeper-scoped stable methods; values within this dimension combine with OR. */
  methods?: AdminUsageReportMethodFilter[];
  /** Content-free opaque external account/resource dimensions. */
  externalAccountIds?: string[];
  /** Causal Metered Use origins. */
  sources?: UsageSource[];
  /** Durable terminal Usage outcomes, including the legacy unknown selector. */
  outcomes?: AdminUsageReportFilterOutcome[];
  /** Priced and Unpriced selection. */
  pricingStatuses?: ("priced" | "unpriced")[];
  /** Model, Gatekeeper, and formal attempt-only Summary selection. */
  meteredKinds?: ("model" | "gatekeeper" | "attempt")[];
};

/** Durable outcome exposed by deployment Usage reporting. */
export type AdminUsageReportOutcome =
  | "settled"
  | "failed-before-execution"
  | "usage-unknown-released"
  | "usage-unknown-held"
  | "reconciliation-required"
  | "reconciled-settled"
  | "reconciled-released";

/** Report filter outcome, including the legacy unknown selector that expands to both new states. */
export type AdminUsageReportFilterOutcome = AdminUsageReportOutcome | "usage-unknown";

/** Authoritative Credit Reservation state that explains one reported Metering Attempt. */
export type AdminUsageReservationStatus = "held" | "released" | "settled" | "none";

/** Immutable snapshot metadata shared by overview, rows, and CSV for one report capability. */
export type AdminUsageReportSnapshot = {
  /** Canonical normalized filter frozen when the report opened. */
  filter: AdminUsageReportFilter;
  /** Strongly consistent Deployment report timezone frozen when the report opened. */
  reportTimeZone: string;
  /** Usage Rate version that supplied the frozen report timezone. */
  reportTimeZoneVersion: bigint;
  /** Inclusive UTC boundary derived from the local start date, or null for no lower bound. */
  startAtUtcInclusive: string | null;
  /** Exclusive UTC boundary derived from the local end date, or null for no upper bound. */
  endAtUtcExclusive: string | null;
  /** Projection generation frozen when the report opened. */
  projectionGeneration: bigint;
  /** Applied-ingestion watermark frozen when the report opened. */
  ingestionWatermark: bigint;
};

/** Exact metrics carried by one detail or aggregate report row. */
export type AdminUsageReportRowMetrics = {
  /** Provider model cost in exact USD rate subunits. */
  providerCostUsdSubunits: bigint;
  /** Usage Charges in exact Usage Credit subunits. */
  chargedUsageCreditSubunits: bigint;
  /** Model input tokens reported as cache hits. */
  cacheHitInputTokens: bigint;
  /** Model input tokens not reported as cache hits. */
  cacheMissInputTokens: bigint;
  /** Model input tokens written to a provider cache, when reported. */
  cacheWriteInputTokens: bigint;
  /** Total model output tokens, already including reasoning-token detail. */
  outputTokens: bigint;
  /** Reasoning-token detail already included in outputTokens. */
  reasoningTokens: bigint;
  /** Caller-visible Gatekeeper operations confirmed as executed or accepted. */
  billableApiOperations: bigint;
  /** Confirmed Metered Uses represented by this row. */
  meteredUseCount: bigint;
  /** Failed-before-execution operations represented by this row. */
  preExecutionFailures: bigint;
  /** Unknown-held or released-unknown operations represented by this row. */
  unknownOperations: bigint;
  /** Formal Metering Attempts represented by this row. */
  meteringAttempts: bigint;
  /** Attempts whose Credit Reservation remains held. */
  heldReservations: bigint;
  /** Attempts whose Credit Reservation was released. */
  releasedReservations: bigint;
  /** Attempts whose Credit Reservation was settled into a Ledger charge. */
  settledReservations: bigint;
  /** Attempts that never owned a Credit Reservation. */
  unreservedAttempts: bigint;
  /** Unpriced model uses represented by this row. */
  unpricedModelUses: bigint;
  /** Unpriced Gatekeeper operations represented by this row. */
  unpricedApiOperations: bigint;
};

/** Exact filtered totals for one frozen administrator Usage report. */
export type AdminUsageReportMetrics = AdminUsageReportRowMetrics & {
  /** Distinct Usage Principals with matching confirmed Metered Use. */
  activeUsers: bigint;
};

/** Content-free reporting dimensions shared by detail and aggregate rows. */
export type AdminUsageReportRowDimensions = {
  /** Opaque registered User reference; this remains the Usage Principal. */
  registeredUserRef: string;
  /** Causal origin of the Metered Use. */
  source: UsageSource;
  /** Model, Gatekeeper, or formal attempt-only Summary discriminator. */
  meteredKind: "model" | "gatekeeper" | "attempt";
  /** Durable terminal Usage outcome. */
  outcome: AdminUsageReportOutcome;
  /** Whether the immutable Charge Snapshot had a configured Usage Rate. */
  pricingStatus: "priced" | "unpriced";
  /** Stable Deployment Model identifier, or null for Gatekeeper rows. */
  deploymentModelId: string | null;
  /** Stable Gatekeeper vendor identifier, or null for model rows. */
  gatekeeperId: string | null;
  /** Gatekeeper-scoped stable business method, or null for model rows. */
  stableMethodKey: string | null;
  /** Content-free opaque external account/resource dimension. */
  externalAccountId: string | null;
  /** Stable Gadget identifier, when applicable. */
  gadgetId: string | null;
};

/** One immutable recent Usage event row backed by a User Usage Account record. */
export type AdminUsageReportDetailRow = AdminUsageReportRowDimensions & {
  /** Detail-row discriminator. */
  rowKind: "detail";
  /** Detail facts remain tied to a Model or Gatekeeper authority family. */
  meteredKind: "model" | "gatekeeper";
  /** Opaque Projection row identity used only for stable pagination. */
  rowId: string;
  /** Random opaque reference resolved only inside the corresponding User Durable Object. */
  safeRecordRef: string;
  /** Content-free opaque reference for the represented Metering Attempt, or null for an audit row. */
  safeAttemptRef: string | null;
  /** Authoritative Credit Reservation result for the represented Metering Attempt. */
  reservationStatus: AdminUsageReservationStatus;
  /** Canonical UTC event time from the authoritative Usage Record. */
  occurredAtUtc: string;
  /** Report-local event time including its numeric UTC offset. */
  reportLocalTimestamp: string;
  /** Exact row contribution. */
  metrics: AdminUsageReportRowMetrics;
};

/** One content-free 15-minute UTC Summary snapshot row. */
export type AdminUsageReportAggregateRow = AdminUsageReportRowDimensions & {
  /** Aggregate-row discriminator. */
  rowKind: "aggregate";
  /** Opaque Projection row identity used only for stable pagination. */
  rowId: string;
  /** Stable Summary identity across monotonic revisions. */
  summaryFactId: string;
  /** Monotonic absolute Summary revision. */
  summaryRevision: bigint;
  /** Canonical inclusive start of the 15-minute UTC bucket. */
  bucketStartUtc: string;
  /** Report-local bucket start including its numeric UTC offset. */
  reportLocalBucketStart: string;
  /** Exact absolute Summary snapshot. */
  metrics: AdminUsageReportRowMetrics;
};

/** One deployment Usage report row that never confuses an aggregate with an event. */
export type AdminUsageReportRow = AdminUsageReportDetailRow | AdminUsageReportAggregateRow;

/** Bounded keyset request against one frozen administrator Usage report. */
export type AdminUsageReportPageRequest = {
  /** Opaque cursor returned by the preceding page of this same report capability. */
  cursor?: string;
  /** Optional page size from 1 through ADMIN_USAGE_REPORT_MAX_LIMIT. */
  limit?: number;
};

/** One stable page from a frozen administrator Usage report. */
export type AdminUsageReportPage = {
  /** Rows in descending source-time and stable-row-ID order. */
  rows: AdminUsageReportRow[];
  /** Opaque cursor for the next page, or null when the snapshot is complete. */
  nextCursor: string | null;
};

/** Filtered exact totals and metadata for one frozen administrator Usage report. */
export type AdminUsageReportOverview = {
  /** Exact filtered metrics derived from effective Summary snapshots. */
  metrics: AdminUsageReportMetrics;
  /** Frozen metadata shared with every row and CSV byte. */
  snapshot: AdminUsageReportSnapshot;
  /** Structured health observed when the overview was read. */
  health: AdminUsageProjectionHealth;
  /** Canonical UTC observation time. */
  asOf: string;
};

/** Content-free authoritative Reservation linked to an administrator Usage drill-down. */
export type AdminUsageRecordReservation = {
  /** Exact reserved Usage Credit amount. */
  amountSubunits: bigint;
  /** Durable Reservation state. */
  state: "reserved" | "settled" | "released";
  /** Canonical UTC creation time. */
  createdAt: string;
  /** Canonical UTC settlement time, or null when it did not settle. */
  settledAt: string | null;
  /** Canonical UTC release time, or null when it was not released. */
  releasedAt: string | null;
};

/** Content-free authoritative Ledger entry linked to an administrator Usage drill-down. */
export type AdminUsageRecordLedgerEntry = {
  /** Opaque immutable Ledger entry identifier. */
  id: string;
  /** Ledger entry kind. */
  kind: "usage-charge" | "credit-reversal";
  /** Exact signed Usage Credit delta. */
  deltaSubunits: bigint;
  /** Canonical UTC creation time. */
  createdAt: string;
};

/** Content-free administrator reconciliation audit linked to unknown Gatekeeper Usage. */
export type AdminUsageRecordReconciliation = {
  /** Administrator decision applied to the unknown Usage. */
  decision: "settle" | "release";
  /** Authenticated administrator identity bound by the service. */
  actorUserId: string;
  /** Bounded human explanation retained for audit. */
  reason: string;
  /** Canonical UTC decision time. */
  createdAt: string;
};

/** Administrator-visible Gatekeeper Usage Record with its content-free account dimension. */
export type AdminGatekeeperUsageRecord = UserGatekeeperUsageRecord & {
  /** Content-free opaque external account/resource dimension. */
  externalAccountId: string;
};

/** Reconciliation authority retained independently from its older raw Gatekeeper Usage Record. */
export type AdminGatekeeperReconciliationRecord = {
  /** Reconciliation-record discriminator. */
  kind: "gatekeeper-reconciliation";
  /** Random opaque User-local reference returned by a Projection detail row. */
  id: string;
  /** Host-attested causal source copied into the retained authority snapshot. */
  source: UsageSource;
  /** Confirmed Gatekeeper Use, or an attempt-only release decision. */
  meteredKind: "gatekeeper" | "attempt";
  /** Stable Gatekeeper vendor identifier. */
  vendorId: string;
  /** Gatekeeper-scoped stable business method. */
  billingMethodKey: string;
  /** Content-free opaque external account/resource dimension. */
  externalAccountId: string;
  /** Stable Gadget identifier, or null when no Gadget caused this Use. */
  gadgetId: string | null;
  /** Whether the immutable Charge Snapshot had a configured Usage Rate. */
  pricing: "priced" | "unpriced";
  /** Formal terminal result of the administrator reconciliation. */
  outcome: "reconciled-settled" | "reconciled-released";
  /** Exact Usage Credit charged by the reconciliation decision. */
  chargeSubunits: bigint;
  /** Canonical UTC reconciliation time, never the older Usage event time. */
  createdAt: string;
};

/** Content-free authoritative administrator view of one Usage detail event. */
export type AdminUsageRecord =
  | UserModelUsageRecord
  | AdminGatekeeperUsageRecord
  | AdminGatekeeperReconciliationRecord;

/** Serializable authoritative graph for one administrator Usage drill-down. */
export type AdminUsageRecordDetail = {
  /** Content-free authoritative Usage or reconciliation record. */
  record: AdminUsageRecord;
  /** Immutable pricing evidence used by the authoritative User Usage Account. */
  chargeSnapshot: ChargeSnapshot;
  /** Linked Credit Reservation, or null for zero-charge and Unpriced Use. */
  reservation: AdminUsageRecordReservation | null;
  /** Linked Usage Charge and later Credit Reversal entries. */
  ledgerEntries: AdminUsageRecordLedgerEntry[];
  /** Linked unknown-Usage reconciliation audit, or null before reconciliation. */
  reconciliation: AdminUsageRecordReconciliation | null;
};

/** Administrator request for authoritative detail in exactly one registered User account. */
export type AdminUsageRecordDetailRequest = {
  /** Opaque target returned by the authoritative User Registry. */
  registeredUserRef: string;
  /** Random opaque reference returned only by a Projection detail row. */
  safeRecordRef: string;
};

/** Frozen administrator report capability returned by AdminUsageApi.openReport(). */
export interface AdminUsageReport {
  /** Read exact filtered totals against this report's frozen snapshot. */
  getOverview(): Promise<AdminUsageReportOverview>;

  /** Read one bounded keyset page against this report's frozen snapshot. */
  listRows(request: AdminUsageReportPageRequest): Promise<AdminUsageReportPage>;

  /** Stream RFC 4180 CSV bytes for this same frozen snapshot with Cap'n Web flow control. */
  exportCsv(): Promise<ReadableStream<Uint8Array>>;

  /** Cancel every active CSV source owned by this report and release its bounded stream slots. */
  cancelCsvExports(): Promise<void>;
}

/** Durable status of an idempotent Usage Projection rebuild request. */
export type ProjectionRebuildStatus = {
  /** Stable caller-supplied rebuild identity. */
  requestId: string;
  /** Current rebuild state. */
  state: "rebuilding" | "completed" | "failed";
  /** Generation being built or activated. */
  generation: bigint;
  /** Exact number of Registry Users completed so far. */
  usersProcessed: bigint;
  /** Canonical UTC time when this rebuild began. */
  startedAt: string;
  /** Canonical UTC completion time, or null while the rebuild is active. */
  completedAt: string | null;
  /** Bounded machine-readable failure code, or null before a failure. */
  failureCode: "registry-read-failed" | "user-read-failed" | "projection-write-failed" | null;
};

/** Supported append-only administrator Usage Account correction. */
export type AdminUsageOperationKind =
    "grant" | "deduct" | "reconcile-balance" | "reverse";

/** Auditable result of one idempotent administrator Usage Account correction. */
export type AdminUsageOperationResult = {
  /** Correction kind selected by the administrator capability. */
  kind: AdminUsageOperationKind;
  /** Immutable appended Credit Ledger Entry, or null for an explicit reconciliation no-op. */
  ledgerEntryId: string | null;
  /** Immutable original Ledger Entry linked by a reversal, or null for other corrections. */
  originalLedgerEntryId: string | null;
  /** Exact signed delta created by the service; zero only for a reconciliation no-op. */
  deltaSubunits: bigint;
  /** Authenticated administrator identity bound by the server capability. */
  actorUserId: string;
  /** Trimmed bounded administrator reason retained for audit. */
  reason: string;
  /** Canonical UTC time created in the authoritative User transaction. */
  createdAt: string;
  /** Authoritative values immediately before the correction. */
  before: AdminUsageBalanceState;
  /** Authoritative values immediately after the correction. */
  after: AdminUsageBalanceState;
  /** True only when reconciliation already matched the requested exact target and appended no entry. */
  noOp: boolean;
};

/** Administrator request to append a positive Usage Credit grant. */
export type AdminUsageGrantRequest = {
  /** Opaque target returned by Registry search. */
  registeredUserRef: string;
  /** Stable client retry identity for this correction. */
  operationId: string;
  /** Strictly positive Usage Credit amount in exact integer subunits. */
  amountSubunits: bigint;
  /** Required bounded human explanation. */
  reason: string;
};

/** Administrator request to append a service-signed Usage Credit deduction. */
export type AdminUsageDeductRequest = {
  /** Opaque target returned by Registry search. */
  registeredUserRef: string;
  /** Stable client retry identity for this correction. */
  operationId: string;
  /** Strictly positive magnitude that the service converts to a negative Ledger delta. */
  amountSubunits: bigint;
  /** Required bounded human explanation. */
  reason: string;
};

/** Administrator request to append the exact delta needed to reach one Ledger balance. */
export type AdminUsageReconcileRequest = {
  /** Opaque target returned by Registry search. */
  registeredUserRef: string;
  /** Stable client retry identity for this correction. */
  operationId: string;
  /** Exact signed target Ledger balance in Usage Credit subunits. */
  targetBalanceSubunits: bigint;
  /** Required bounded human explanation. */
  reason: string;
};

/** Administrator request to reverse one immutable Credit Ledger Entry exactly once. */
export type AdminUsageReverseRequest = {
  /** Opaque target returned by Registry search. */
  registeredUserRef: string;
  /** Stable client retry identity for this correction. */
  operationId: string;
  /** Immutable original Ledger Entry identifier; the client supplies no delta or reversal amount. */
  originalLedgerEntryId: string;
  /** Required bounded human explanation. */
  reason: string;
};

/** Administrator request to permanently remove one registered User's direct identity links. */
export type AdminUsageDeleteUserRequest = {
  /** Opaque active target returned by Registry search. */
  registeredUserRef: string;
  /** Stable retry identity for the full cross-Durable-Object deletion workflow. */
  deletionId: string;
  /** Required bounded human explanation retained in the deletion audit. */
  reason: string;
};

/** Auditable terminal result of one idempotent User deletion workflow. */
export type AdminUsageDeleteUserResult = {
  /** Opaque Usage Principal retained for lifetime financial history and rebuilds. */
  registeredUserRef: string;
  /** Stable caller-supplied retry identity. */
  deletionId: string;
  /** Authenticated administrator identity bound by the server capability. */
  actorUserId: string;
  /** Bounded administrator explanation retained for audit. */
  reason: string;
  /** Canonical UTC time when the Registry committed the anonymous tombstone. */
  deletedAt: string;
  /** Explicit terminal lifecycle state. */
  state: "deleted";
};

/** Administrator decision for an Action whose financial state needs explicit coordination. */
export type AdminActionReconciliationDecision = "settle" | "release" | "reverse";

/** Administrator request to reverse one durable Action's already-settled Usage Charge. */
export type AdminActionReconciliationRequest = {
  /** Stable Workshop identifier returned by `Overseer.getMetadata()`. */
  workspaceId: string;
  /** Workspace-local Action identifier returned by `Overseer.listActions()`. */
  actionId: number;
  /** Stable client retry identity for this coordination decision. */
  operationId: string;
  /** The only raw Action-scoped decision; unknown coordination requires a selected detail. */
  decision: "reverse";
  /** Required bounded human explanation retained in the Action audit. */
  reason: string;
};

/** Detail-scoped request to settle or release one unknown Gatekeeper Usage Record. */
export type AdminUnknownUsageReconciliationRequest = {
  /** Opaque target returned by the authoritative User Registry. */
  registeredUserRef: string;
  /** Random User-local reference returned by the selected report detail row. */
  safeRecordRef: string;
  /** Stable client retry identity for this administrator decision. */
  operationId: string;
  /** Financial decision allowed for the selected unknown Usage Record. */
  decision: "settle" | "release";
  /** Bounded administrator explanation retained for audit. */
  reason: string;
};

/** Auditable unknown-detail result that omits every server-private authority locator. */
export type AdminUnknownUsageReconciliationResult = Omit<
  AdminActionReconciliationResult,
  "workspaceId" | "actionId" | "decision"
> & {
  /** Unknown-held decision accepted by the selected authoritative detail. */
  decision: "settle" | "release";
};

/** Auditable result of one idempotent administrator Action coordination decision. */
export type AdminActionReconciliationResult = {
  /** Stable Workshop identifier containing the coordinated Action. */
  workspaceId: string;
  /** Workspace-local coordinated Action identifier. */
  actionId: number;
  /** Stable client retry identity for this coordination decision. */
  operationId: string;
  /** Financial decision applied by the administrator capability. */
  decision: AdminActionReconciliationDecision;
  /** Action state before the decision. */
  previousState: ActionState;
  /** Action state after the decision. */
  newState: ActionState;
  /** Appended Usage Charge or Credit Reversal Ledger Entry, or null for release. */
  ledgerEntryId: string | null;
  /** Authenticated administrator identity bound by the server capability. */
  actorUserId: string;
  /** Trimmed bounded administrator reason retained for audit. */
  reason: string;
  /** Canonical UTC time created by the authoritative User transaction. */
  createdAt: string;
};

/**
 * Administrator-only capability for authoritative User Registry search and Usage Account
 * corrections. It is minted only through an already-authorized AdminApi and never returns a User
 * Durable Object capability.
 */
export interface AdminUsageApi {
  /** Read all-recorded deployment totals and structured projection health. */
  getOverview(): Promise<AdminUsageOverview>;

  /**
   * Read capacity telemetry for the fixed `usage-capacity-v1` profile.
   *
   * This is separate from `getOverview` because its cost is linear in the retained detail rows:
   * it aggregates a rolling thirty-day window and groups that window by second and by minute for
   * the aligned peaks. Measured on the production path it is 16 ms at a thousand records and
   * 2.1 s at two hundred thousand, so leaving it on the overview path made the overview too slow
   * to poll. The windows it reports are a day and thirty days, so it does not need the overview's
   * refresh rate. Returns null when the projection is unavailable or its values are not yet
   * verified, because capacity telemetry is operational guidance and must never delay or hide the
   * authoritative totals.
   */
  getCapacityReview(): Promise<AdminUsageCapacityReview | null>;

  /** Read one registered User's balance directly from its authoritative Usage Account. */
  getBalance(registeredUserRef: string): Promise<AdminUsageBalanceState>;

  /** Idempotently start or resume a replaceable projection rebuild from User authority. */
  requestProjectionRebuild(requestId: string): Promise<ProjectionRebuildStatus>;

  /** Search only the authoritative Registry without waking or fabricating User Durable Objects. */
  searchUsers(request: AdminUsageUserSearchRequest): Promise<AdminUsageUserSearchResult>;

  /** Return one bounded page of a registered User's content-free Usage Records. */
  listUsageRecords(request: AdminUsageRecordPageRequest): Promise<UserUsageRecordPage>;

  /** Open one report with normalized filters, timezone, generation, and watermark frozen. */
  openReport(filter: AdminUsageReportFilter): Promise<RpcStub<AdminUsageReport>>;

  /** Read one authoritative Usage graph after resolving the registered User through Registry. */
  getRecordDetail(request: AdminUsageRecordDetailRequest): Promise<AdminUsageRecordDetail>;

  /** Append one exact positive administrator grant to a registered User. */
  grant(request: AdminUsageGrantRequest): Promise<AdminUsageOperationResult>;

  /** Append one exact negative administrator deduction to a registered User. */
  deduct(request: AdminUsageDeductRequest): Promise<AdminUsageOperationResult>;

  /** Append one exact compensating entry, or record an explicit no-op, for a registered User. */
  reconcileBalance(request: AdminUsageReconcileRequest): Promise<AdminUsageOperationResult>;

  /** Append one exact linked Credit Reversal for a registered User. */
  reverse(request: AdminUsageReverseRequest): Promise<AdminUsageOperationResult>;

  /** Permanently remove one registered User's direct identity and retain pseudonymous history. */
  deleteUsageUser(request: AdminUsageDeleteUserRequest): Promise<AdminUsageDeleteUserResult>;

  /** Reverse one already-settled Action Usage Charge exactly. */
  reconcileAction(
    request: AdminActionReconciliationRequest,
  ): Promise<AdminActionReconciliationResult>;

  /** Settle or release the selected unknown detail without accepting an Action identifier. */
  reconcileUnknownRecord(
    request: AdminUnknownUsageReconciliationRequest,
  ): Promise<AdminUnknownUsageReconciliationResult>;
}

/** Top-level API exposed to the user after they have authenticated. */
export interface AuthenticatedApi extends RpcTarget {
  /** Get profile info for the user who is logged in. */
  whoami(): Promise<AiChatAuthorInfo>;

  /** Set the user's own display name, seen in chats, etc. */
  setOwnDisplayName(name: string): Promise<void>;

  /**
   * Change the user's password, if using password-based authentication.
   *
   * See `PublicApi.login()` for an explanation of the hashing algorithm.
   */
  changePassword(oldHash: Uint8Array, newHash: Uint8Array): Promise<void>;

  /**
   * Whether this account has a password set. False for accounts created via an OAuth provider, in
   * which case the change-password UI should be hidden.
   */
  hasPasswordLogin(): Promise<boolean>;

  /** List the Deployment Models that this user can select. */
  listModels(): Promise<AiChatAuthorInfo[]>;

  /** Resolve UI feature flags for the authenticated user. */
  getUiFeatureFlags(): Promise<UiFeatureFlags>;

  /** Get the logged-in User's available and reserved Usage Credit balances. */
  getUsageCreditBalance(): Promise<UsageCreditBalance>;

  /**
   * Subscribe to the logged-in User's authoritative Usage Credit balance.
   * Dispose the returned stub to cancel the subscription.
   */
  subscribeUsageCreditBalance(
    subscriber: RpcStub<UsageCreditBalanceSubscriber>,
  ): Promise<RpcStub<{}>>;

  /** Idempotently acknowledge this User's pending legacy activation notice. */
  acknowledgeUsageActivationNotice(noticeId: string): Promise<UsageCreditBalance>;

  /** List a bounded page of the logged-in User's own content-free Usage Records. */
  listOwnUsageRecords(request: UserUsageRecordPageRequest): Promise<UserUsageRecordPage>;

  /** List a bounded page of the logged-in User's own Credit Reservations. */
  listOwnCreditReservations(request: UserCreditPageRequest): Promise<UserCreditReservationPage>;

  /** List a bounded page of the logged-in User's own Credit Ledger. */
  listOwnCreditLedger(request: UserCreditPageRequest): Promise<UserCreditLedgerPage>;

  /** List a bounded page of current public Gatekeeper method rates and Unpriced methods. */
  listPublishedApiRates(request: PublishedApiRatePageRequest): Promise<PublishedApiRatePage>;

  /**
   * Get the user's preferred model, chosen during onboarding. Returns null if the user has not
   * set a preference (or explicitly chose "No agent").
   */
  getPreferredModel(): Promise<string | null>;

  /** Set the user's preferred model. Pass null to indicate "No agent". */
  setPreferredModel(id: string | null): Promise<void>;

  /** Returns true if the user has completed the onboarding wizard. */
  isOnboardingCompleted(): Promise<boolean>;

  /** Mark the onboarding wizard as completed. */
  completeOnboarding(): Promise<void>;

  /**
   * Upload a user avatar image. The data should be a compressed image (JPEG/PNG), ideally under
   * 50 KB. Pass null to remove the avatar.
   */
  setAvatar(data: Uint8Array | null): Promise<void>;

  /**
   * Fetch a user's avatar image by user ID. Returns null if no avatar has been set.
   * Accepts any user ID so that other users' avatars can be displayed (e.g. in chat).
   */
  getAvatar(userId: string): Promise<Uint8Array | null>;

  /**
   * Open an existing gadget.
   *
   * If `shareKey` is provided, the server redeems it before opening, adding the caller as a
   * collaborator. If the key is invalid or expired, the call throws an exception. This design
   * allows share-key redemption and gadget opening in a single round trip, and further calls
   * can be pipelined on the returned Overseer.
   *
   * To allow for pipelining, this throws an exception if the gadget doesn't exist. Expected
   * missing, authorization, and observer-verification failures carry a code from
   * `OPEN_GADGET_ERROR_CODES`. Observer verification failures can also carry structured
   * `OpenGadgetObserverFailure` entries so clients can localize Workshop-authored reasons while
   * preserving Gatekeeper/Vendor free text.
   *
   * `configureObservers` is invoked only when the opening user is a non-owner who must choose
   * connected accounts for one or more gatekeeper bindings before they can observe the gadget (see
   * ObserverConfigCallback). It is never called for the owner or an already-configured observer,
   * so the common-case open is still a single pipelined round trip.
   *
   * TODO(multi-gadget): This should be renamed to openWorkspace().
   */
  openGadget(id: string, shareKey?: string,
             configureObservers?: RpcStub<ObserverConfigCallback>): Promise<RpcStub<Overseer>>;

  /**
   * Create a new workspace. It will start out titled "Untitled Workspace".
   *
   * Note: A gadget is considered "provisional" until it has some sort of activity, such as a
   *   chat message or code edit. Provisional gadgets do not appear on the home page and will be
   *   automatically deleted after some time. Note in particular that calling
   *   new*Gatekeeper() will not clear the provisional bit (as long as the gatekeeper isn't bound
   *   into a gadget), so provisional gadgets are useful to allow the user to write an initial
   *   chat message without explicitly creating a new gadget.
   *
   * TODO(multi-gadget): This should be renamed to newWorkspace().
   */
  newGadget(): Promise<RpcStub<Overseer>>;

  /**
   * List metadata about all the user's Gadgets. Used to display the front-page listing.
   *
   * Provisional gadgets are hidden.
   *
   * TODO: Pagination, sort options.
   */
  listGadgets(): Promise<GadgetMetadataWithTimestamps[]>;

  /**
   * List the outputs of all the user's workspaces. Used to display the Outputs page, which lets
   * the user find things they made without remembering which workspace they made them in.
   *
   * Served from an index in the user's own account which each workspace pushes to; a workspace
   * shared with the user contributes its outputs from the first time the user opens it (matching
   * when it appears in listGadgets()), and stops updating them if their access is revoked.
   * Provisional gadgets (still awaiting acceptance of a chat's changes) are never included.
   *
   * TODO: Pagination, sort options.
   */
  listOutputs(): Promise<ListOutputsResult>;

  /**
   * The deployment's standard output formats, in the order they should be offered -- what fills a
   * "New Document / New Slides / ..." menu. Empty when the deployment promotes none.
   *
   * These are ordinary blueprints an admin has promoted.
   */
  listOutputFormats(): Promise<OutputFormatOffer[]>;

  /** List all third-party services that this account can connect to. */
  listGatekeeperVendors(filter?: GatekeeperVendorFilter): Promise<GatekeeperVendorInfo[]>;

  /**
   * Connect this account to a specific account on a third-party service. Returns the URL which
   * should be opened in a new tab in the user's browser to complete the authorization. When the
   * authorization flow completes, the account will be added to the list, which can be observed
   * through subscribeConnectedAccounts().
   *
   * `resourceUrlPatterns`, if given, limits the connection to the authorization needed for those
   * grantable resource types (those with `grantable`; see `SupportedResource`). If omitted,
   * authorization for all of the vendor's resource types is requested.
   */
  connectAccount(vendorId: string, resourceUrlPatterns?: string[]): Promise<{url: string}>;

  /**
   * Ensure the authorization for the listed grantable resource types (by `urlPattern`) is granted
   * on a connected account, expanding if needed. Returns a URL to open in a new tab to authorize
   * them, or no url if nothing was needed. The updated grant is observable via
   * subscribeConnectedAccounts().
   */
  ensureAccountResources(accountId: number, resourceUrlPatterns: string[]): Promise<{url?: string}>;

  /**
   * List the auto-provisioning ("ambient") gatekeepers the user can opt into right now: those set to
   * 'optional' by the admin that the user hasn't added yet. Rendered as an "Available" section on the
   * Connectors page. ('enabled' ones are already provisioned; 'disabled' ones aren't offered.) Returns
   * the same shape as listGatekeeperVendors (with no resources) so the connect UI handles both
   * identically, routing on `description.autoProvisionsAccount`.
   */
  listAddableGatekeepers(): Promise<GatekeeperVendorInfo[]>;

  /**
   * Opt into an ambient gatekeeper: mint its connected account for this user (no OAuth flow). Only
   * works while the vendor's mode is 'optional' (or 'enabled') and the user has no account yet; the
   * new account then appears via subscribeConnectedAccounts(). Throws otherwise.
   */
  provisionAmbientAccount(vendorId: string): Promise<void>;

  /**
   * Subscribe to the list of third-party accounts connected to the user's account.
   *
   * Dispose the returned stub to cancel the subscription.
   *
   * This is subscription-based because the flow to connect a new account completes in a separate
   * window. When it completes, we want the list of accounts in the Workshop UI to update
   * immediately, to give the user feedback that the account is now connected.
   */
  subscribeConnectedAccounts(
      subscriber: RpcStub<ConnectedAccountsSubscriber>, filter?: ConnectedAccountsFilter)
      : Promise<RpcStub<{}>>;

  /** Remove a connected account, revoking the token. */
  disconnectAccount(accountId: number): Promise<void>;

  /**
   * Get the UI used to choose a specific resource from a connected account.
   *
   * `accountId` is the user's connected account that provides this resource.
   * `resourceUrlPattern` is the `urlPattern` associated with the supported resource.
   */
  startResourceConfigurator(
    accountId: number,
    resourceUrlPattern: string,
  ): Promise<ResourceConfiguratorFrame>;

  /**
   * Remove a shared gadget from the user's home page listing. Does NOT revoke the user's
   * access -- if they open the gadget again (e.g., via link), it reappears on their home page.
   */
  dismissSharedGadget(gadgetId: string): Promise<void>;

  /**
   * List all blueprints created by the current user (from User DO). Useful for an audit
   * view in Settings.
   */
  listOwnBlueprints(): Promise<BlueprintUserSummary[]>;

  /** Return a blueprint created by the current user, or null if it is not owned by this user. */
  getOwnBlueprint(blueprintId: string): Promise<BlueprintUserSummary | null>;

  /**
   * List the blueprints currently in the user's library. This includes uploaded `.gadget`
   * archives (stored locally) and blueprints saved by reference from other publishers.
   */
  listLibraryBlueprints(): Promise<BlueprintLibrarySummary[]>;

  /**
   * Pin a blueprint for quick reuse on the home page. Pinning a public blueprint that isn't
   * already yours or in your library saves it to your library first.
   */
  setBlueprintPinned(blueprintId: string, pinned: boolean): Promise<void>;

  /** Returns whether the blueprint is pinned by the current user. */
  isBlueprintPinned(blueprintId: string): Promise<boolean>;

  /**
   * List the deployment-wide featured blueprints. This is served from a KV snapshot rather
   * than directly from the AdminSettings durable object.
   */
  listFeaturedBlueprints(): Promise<BlueprintPublicInfo[]>;

  /**
   * Add a blueprint to the user's library by reference, caching the current public metadata
   * snapshot for list rendering.
   */
  addBlueprintToLibrary(blueprintId: string): Promise<void>;

  /**
   * Remove a blueprint from the user's library. If the library entry was uploaded by the
   * current user, this also deletes the backing blueprint content from storage.
   */
  removeBlueprintFromLibrary(blueprintId: string): Promise<void>;

  /**
   * Returns info about whether the blueprint is in the user's library.
   * Returns null if not in library, or { uploaded } if it is.
   */
  isBlueprintInLibrary(blueprintId: string): Promise<{ uploaded: boolean } | null>;

  /**
   * Create a new gadget from a blueprint. Reads the blueprint from KV, downloads code from
   * R2, creates a new Overseer DO, initializes it with the blueprint's code, and creates
   * gatekeepers from the provided binding assignments.
   *
   * Every required binding in the blueprint must have a corresponding entry in `bindings`,
   * keyed by binding name. Throws if any are missing or if accountId/modelId are invalid.
   *
   * The returned Overseer can be used immediately (pipelining-friendly).
   */
  newGadgetFromBlueprint(
    blueprintId: string,
    bindings: Record<string, BlueprintBindingAssignment>
  ): Promise<RpcStub<Overseer>>;

  /**
   * Delete a blueprint that the user owns. Works even if the source gadget has been deleted
   * (operates on User DO + KV directly).
   */
  deleteOrphanedBlueprint(blueprintId: string): Promise<void>;

  /**
   * Import a `.gadget` archive from another Workshop instance. The imported blueprint is stored
   * as a local blueprint owned by the current user.
   */
  importBlueprint(archive: ReadableStream<Uint8Array>): Promise<string>;

  /**
   * Re-authenticate a connected account whose credentials have expired (or may be about to
   * expire). Returns the URL to open in a new tab. When the OAuth flow completes, the account
   * is updated and subscribers are notified with credentialsValid: true.
   */
  reconnectAccount(accountId: number): Promise<{url: string}>;

  // --- Gatekeeper management apps ---

  /**
   * List the gatekeepers that expose a full-page management UI (VendorDescription.providesUi) and are
   * available to this user. The Workshop renders a nav entry + page per entry. Independent of whether
   * the gatekeeper is a singleton.
   */
  listGatekeeperApps(): Promise<GatekeeperAppInfo[]>;

  /**
   * Get the app frame (self-contained iframe HTML + the gatekeeper's `ui` capability) for the given
   * gatekeeper id, or null if there is no such UI-providing gatekeeper. The Workshop hosts the HTML
   * in a sandboxed iframe and exposes `ui` to it over a MessagePort RPC session.
   */
  getGatekeeperApp(id: string): Promise<GatekeeperUiFrame | null>;

  // --- Deployment admin ---

  /**
   * Whether the current user is a deployment admin. Used by the client to decide whether to show
   * the admin UI.
   */
  amIAdmin(): Promise<boolean>;

  /**
   * Returns a capability for managing deployment-wide admin settings, or null when the caller is not
   * an admin. The access check happens once here, so the returned stub's methods need no per-call
   * checks. (Authentication config — sign-in providers, password login — is intentionally not
   * managed here; it stays env-var driven.)
   */
  getAdminApi(): Promise<RpcStub<AdminApi> | null>;

  // TODO:
  // - Edit permissions on a connected account.
}

/** Describes a gatekeeper's management app, for the Workshop nav + page. */
export type GatekeeperAppInfo = {
  /**
   * The vendor id (the GATEKEEPER_<ID> binding suffix, lowercased), used as the URL slug at
   * /gatekeepers/$id. This is the vendor, not a specific account: it assumes one management-UI
   * account per vendor per user, which holds for today's auto-provisioned singletons.
   */
  id: string;
  /** Title for the nav entry / page header. */
  title: string;
  /** Optional icon. */
  icon?: AvatarImage;
};

// ---------------------------------------------------------------------------
// Context Library — pluggable separate worker (packages/gatekeeper-context)
// ---------------------------------------------------------------------------
//
// The Context Library lives in its own Worker, bound as the auto-provisioned gatekeeper
// GATEKEEPER_CONTEXT. Core implements none of its logic and owns none of its types (those live in
// the gatekeeper package): the account mints a management capability (the iframe app's `ui`, treated
// opaquely here) and a read session (the agent read-path, auto-provided as an unnamed capsule).

/** Maximum length (characters) of the admin announcement / banner text. */
export const MAX_ANNOUNCEMENT_LENGTH = 2000;

/**
 * Accent colors available for the full-width announcement banner. Soft status tints plus the brand
 * color, so a banner need not look like an alert.
 */
export type BannerColor = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'brand';

export const BANNER_COLORS: BannerColor[] =
    ['neutral', 'info', 'success', 'warning', 'danger', 'brand'];

export const DEFAULT_BANNER_COLOR: BannerColor = 'info';

export function isBannerColor(value: unknown): value is BannerColor {
  return typeof value === 'string' && (BANNER_COLORS as string[]).includes(value);
}

/** The deployment-wide full-width banner configuration. */
export type BannerConfig = {
  /** Banner text (Markdown supported). Empty string hides the banner. */
  text: string;
  /** Accent color. */
  color: BannerColor;
};

/**
 * Whether `value` is a valid 3- or 6-digit hex color (e.g. "#abc" or "#aabbcc"). Used to validate
 * the admin accent color before it's interpolated into CSS, preventing CSS injection.
 */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

/** A single gatekeeper resource type in the admin resource-config UI. */
export type AdminResource = {
  /** The resource's urlPattern, used as its stable identifier. */
  urlPattern: string;
  title: string;
  description: string;
  icon?: AvatarImage;
  /** Whether this resource is currently enabled (not in the admin disabled set). */
  enabled: boolean;
};

/**
 * Provisioning mode for an auto-provisioning ("ambient") gatekeeper — one that mints a connected
 * account with no OAuth flow (VendorDescription.autoProvisionsAccount), e.g. the Context Library:
 *   - 'disabled': not available; no account is provisioned and any existing one is dormant.
 *   - 'optional': users opt in from the Connectors page; not forced on anyone (the default).
 *   - 'enabled':  auto-provisioned for every user (forced); they can't remove it.
 */
export const AMBIENT_GATEKEEPER_MODES = ['disabled', 'optional', 'enabled'] as const;
export type AmbientGatekeeperMode = typeof AMBIENT_GATEKEEPER_MODES[number];

export function isAmbientGatekeeperMode(value: unknown): value is AmbientGatekeeperMode {
  return AMBIENT_GATEKEEPER_MODES.includes(value as AmbientGatekeeperMode);
}

/**
 * A bound gatekeeper in the admin gatekeeper-config UI, discriminated by `autoProvisions`:
 *   - an ordinary OAuth/resource gatekeeper has a binary `enabled` flag and `resources` to toggle;
 *   - an auto-provisioning ("ambient") gatekeeper has a three-state `ambientMode` and no resources.
 */
export type AdminResourceVendor = {
  vendorId: string;
  displayName: string;
  logo?: AvatarImage;
} & (
  | { autoProvisions: false; enabled: boolean; resources: AdminResource[] }
  | { autoProvisions: true; ambientMode: AmbientGatekeeperMode }
);

/**
 * A connectable third-party service: its vendor id, display metadata, and the resource types it
 * offers (empty for an auto-provisioning gatekeeper like the Context Library). Returned by both
 * listGatekeeperVendors and listAddableGatekeepers so the connect UI treats both uniformly.
 */
export type GatekeeperVendorInfo = {
  id: string;
  description: VendorDescription;
  supportedResources: SupportedResource[];
  /**
   * Present when a bound gatekeeper could not be queried. UIs should surface this to the user but
   * not offer it as connectable.
   */
  unavailable?: boolean;
};

/** Maximum length (characters) of the admin-authored agent system-prompt instructions. */
export const MAX_INSTANCE_INSTRUCTIONS_LENGTH = 8000;

/** Maximum length (characters) of the admin-authored site name shown next to the top-bar logo. */
export const MAX_SITE_NAME_LENGTH = 40;

/**
 * What this deployment calls itself when the admin has not set a custom `siteName`. Also the
 * product's own name, so it appears in prose the server and UI address to the user.
 */
export const DEFAULT_SITE_NAME = "azhen";

/**
 * The name to display for this deployment. Accepts an unset or not-yet-loaded `siteName` so both
 * the server (reading admin config) and the client (reading ServerConfig) resolve it identically.
 */
export function resolveSiteName(siteName: string | undefined): string {
  return (siteName ?? "").trim() || DEFAULT_SITE_NAME;
}

/** Maximum byte length of an admin-uploaded site logo after browser-side PNG conversion. */
export const MAX_SITE_LOGO_BYTES = 256 * 1024;

/** Maximum width or height of an admin-uploaded site logo in pixels. */
export const MAX_SITE_LOGO_DIMENSION = 512;

/** All admin-managed deployment settings, returned by AdminApi.getSettings() for the admin UI. */
export type AdminSettingsView = {
  /** Whether new account signups are allowed. */
  signupsEnabled: boolean;
  /** Site name shown next to the top-bar logo ("" falls back to DEFAULT_SITE_NAME). */
  siteName: string;
  /** Custom deployment logo, or undefined to use the default Cloudflare OS mark. */
  siteLogo?: AvatarImage;
  /** Agent system-prompt instructions ("" when unset). */
  instanceInstructions: string;
  /** Top-bar notice text ("" when unset). */
  announcement: string;
  /** Full-width banner (text + accent color). */
  banner: BannerConfig;
  /** Accent color hex, or "" for the default theme. */
  accentColor: string;
  /** Every bound gatekeeper and its resource types, with enabled state (not hidden when disabled). */
  resourceVendors: AdminResourceVendor[];
  /** The blueprints promoted as standard output formats, in menu order (including disabled ones). */
  formats: AdminFormat[];
};

/**
 * One promoted blueprint, as the admin Formats panel sees it: the deployment's curation plus
 * enough of the blueprint to show what is being curated.
 */
export type AdminFormat = {
  blueprintId: string;

  blueprintTitle: string;

  /**
   * The blueprint's own description, which is the rest of the catalog entry the agent reads;
   * `agentHint` is only its last line.
   */
  blueprintDescription: string;

  /** Presentation after the deployment's overrides are applied. */
  output?: BlueprintOutput;

  /** What the blueprint itself declares, so the panel can show which fields are overridden. */
  declared?: BlueprintOutput;

  /** The deployment's presentation overrides, if any. */
  overrides?: Partial<BlueprintOutput>;

  enabled: boolean;

  /** One line telling the agent when to prefer this format. */
  agentHint: string;

  /**
   * The promoted blueprint no longer exists (deleted after promotion). Such an entry is skipped
   * everywhere else; the panel surfaces it so the admin can remove it.
   */
  missing: boolean;

  /**
   * The blueprint ships with the deployment (see format-blueprints/ and the FORMAT_BLUEPRINTS the
   * build generates from it), so an upgrade can replace its contents. Curation stays the admin's: an upgrade never re-promotes something they
   * removed, nor resets their overrides.
   */
  bundled: boolean;
};

/**
 * Capability for managing deployment-wide admin settings, obtained via
 * AuthenticatedApi.getAdminApi() (which is null for non-admins). The access check happens when the
 * capability is minted, so these methods don't re-check. Covers Deployment Models, Usage Rates,
 * branding, agent instructions, and which gatekeeper connectors/resources are offered — NOT
 * authentication config (that's env-var driven). Each setter throws on invalid input.
 */
export interface AdminApi {
  /** Read all admin-managed settings for the admin UI in one call. */
  getSettings(): Promise<AdminSettingsView>;

  /** Mint the administrator-only Registry and Usage Account correction sub-capability. */
  getUsageApi(): Promise<RpcStub<AdminUsageApi>>;

  /** Read the authoritative Usage Rate version and its immutable, secret-free history. */
  getUsageRates(): Promise<UsageRateAdminView>;

  /** Atomically apply effective Usage Rate changes, or return unchanged for a semantic no-op. */
  updateUsageRates(changes: UsageRateChange[], reason: string): Promise<UsageRateAdminView>;

  /** Read the Deployment Model Catalog without exposing Model Configuration. */
  getDeploymentModelCatalog(): Promise<DeploymentModelCatalog>;

  /** Read deployment AI Gateway settings needed by the Deployment Model management UI. */
  getAiGatewayInfo(): Promise<AiGatewayInfo>;

  /** Add a Deployment Model. The first model becomes the Deployment Default Model. */
  addDeploymentModel(name: string, config: AiModelConfig): Promise<void>;

  /** Rotate one Deployment Model's configuration while preserving its stable public reference. */
  updateDeploymentModel(id: string, name: string, config: AiModelConfig): Promise<void>;

  /** Set the Deployment Default Model. The model must be present in the catalog. */
  setDeploymentDefaultModel(id: string): Promise<void>;

  /** Set the Deployment Quick Model, or pass null to use the Deployment Default Model. */
  setDeploymentQuickModel(id: string | null): Promise<void>;

  /**
   * Revoke a Deployment Model so its stable reference cannot start any later model call. The
   * Deployment Default Model must be replaced before it can be revoked.
   */
  revokeDeploymentModel(id: string): Promise<void>;

  /** Enable or disable new account signups. Existing users can still log in while signups are closed. */
  setSignupsEnabled(enabled: boolean): Promise<void>;

  /**
   * Set the site name shown next to the top-bar logo. Pass "" to reset to DEFAULT_SITE_NAME.
   * Rejects over MAX_SITE_NAME_LENGTH.
   */
  setSiteName(name: string): Promise<void>;

  /** Set the deployment logo from browser-rasterized PNG bytes and return its canonical public
   * image, or undefined after reset. Pass null to restore the default Cloudflare OS mark. The
   * caller must supply decodable PNG data; the server enforces its header, size, and dimensions. */
  setSiteLogo(data: Uint8Array | null): Promise<AvatarImage | undefined>;

  /** Replace the agent system-prompt instructions. Pass "" to clear. Rejects over MAX_INSTANCE_INSTRUCTIONS_LENGTH. */
  setInstanceInstructions(text: string): Promise<void>;

  /**
   * Enable or disable a single gatekeeper resource type, keyed by vendor id + resource urlPattern.
   * Soft enforcement: disabling hides the resource from the connect UI, the resource picker, and the
   * agent; it doesn't revoke a capability a gadget already holds.
   */
  setResourceEnabled(vendorId: string, urlPattern: string, enabled: boolean): Promise<void>;

  /**
   * Set a gatekeeper's availability. For an auto-provisioning ("ambient") gatekeeper, `mode` is the
   * full three-state (disabled / optional / enabled); for an ordinary gatekeeper only 'disabled' /
   * 'enabled' are valid ('optional' is rejected). Soft enforcement: it doesn't revoke a capability a
   * gadget already holds, and 'disabled' leaves an ambient account's data dormant rather than deleting
   * it.
   */
  setGatekeeperMode(vendorId: string, mode: AmbientGatekeeperMode): Promise<void>;

  /**
   * Set the top-bar notice (centered text in the top navigation bar). Pass "" to clear. Rejects over
   * MAX_ANNOUNCEMENT_LENGTH.
   */
  setAnnouncement(text: string): Promise<void>;

  /**
   * Set the full-width banner. Pass an empty text to hide it. Rejects over MAX_ANNOUNCEMENT_LENGTH or
   * an invalid color.
   */
  setBanner(text: string, color: BannerColor): Promise<void>;

  /**
   * Set the deployment accent color (hex, e.g. "#3b82f6"). Pass "" to reset to the default theme.
   * Rejects an invalid hex color.
   */
  setAccentColor(color: string): Promise<void>;

  /**
   * Returns whether the blueprint is featured on the deployment. Returns null when the blueprint
   * can't be featured (e.g. it isn't a listable blueprint).
   */
  isBlueprintFeatured(blueprintId: string): Promise<boolean | null>;

  /** Mark or unmark a blueprint as featured on the deployment. */
  setBlueprintFeatured(blueprintId: string, featured: boolean): Promise<void>;

  // --- Standard output formats ---
  //
  // Promotion is what makes a blueprint one of the deployment's standard formats: offered in the
  // "New ..." menu and listed first for the agent. A blueprint declaring what it produces is
  // presentation, and never enough on its own.

  /**
   * Offer a blueprint as a standard format, appended last in menu order. Throws if the blueprint
   * doesn't exist. Promoting one that already is leaves its curation and menu position alone, so
   * that retrying a promotion whose mirror write failed repairs it rather than being refused.
   */
  promoteFormat(blueprintId: string): Promise<void>;

  /**
   * Stop offering a blueprint as a standard format, and forget the deployment's curation of it.
   * The blueprint itself is untouched.
   *
   * Refused for a bundled blueprint (see `AdminFormat.bundled`), which the deployment installed
   * and will reinstall: `enabled: false` withdraws it without discarding the admin's overrides,
   * hint and menu position.
   */
  removeFormat(blueprintId: string): Promise<void>;

  /**
   * Update one promoted format. Only the provided fields change. `agentHint: ""` clears the hint;
   * an `overrides` field set to null reverts that field to the blueprint's own declaration.
   */
  updateFormat(blueprintId: string, patch: AdminFormatPatch): Promise<void>;

  /** Reorder the menu. `blueprintIds` must be a permutation of the currently promoted ids. */
  setFormatOrder(blueprintIds: string[]): Promise<void>;
}

/** A partial edit to one promoted format. Absent fields are left alone. */
export type AdminFormatPatch = {
  enabled?: boolean;
  agentHint?: string;
  /**
   * Per-field presentation overrides. A field set to null reverts to the blueprint's declaration;
   * a field left absent is unchanged.
   */
  overrides?: {[K in keyof BlueprintOutput]?: BlueprintOutput[K] | null};
};

/**
 * A gatekeeper vendor offered as a sign-in method. The login/signup pages render a "Continue with
 * ..." button per entry, alongside (never replacing) username/password. Built from auth-capable
 * gatekeepers (VendorDescription.providesAuth) that are in the deployment's auth allowlist.
 */
export type AuthVendorInfo = {
  /** The gatekeeper vendor id (the GATEKEEPER_<NAME> binding suffix, lowercased), e.g. "google". */
  vendorId: string;
  /** Display name, logo, and brand color from the gatekeeper's VendorDescription. */
  displayName: string;
  logo?: AvatarImage;
  color?: string;
};

/**
 * Deployment-level configuration that the client needs at boot to decide what UI to render.
 * Returned by `PublicApi.getServerConfig()`. Contains no secrets.
 */
export type ServerConfig = {
  /**
   * Auth-capable, allowlisted gatekeeper vendors offered as sign-in methods. Empty when none are
   * configured (password-only).
   */
  authVendors: AuthVendorInfo[];

  /**
   * Whether username/password login is available. Defaults to true; an installation can disable it
   * (DISABLE_PASSWORD_AUTH) to be OAuth-only. Forced true if no auth vendor is configured, to avoid
   * locking everyone out.
   */
  passwordAuthEnabled: boolean;

  /**
   * Whether new account signups are allowed (admin-configurable, default true). The signup page
   * hides the create-account form when false.
   */
  signupsEnabled: boolean;

  /**
   * Site name shown next to the top-bar logo (admin-configurable). Empty falls back to
   * DEFAULT_SITE_NAME.
   */
  siteName: string;

  /** Custom deployment logo, or undefined to use the default Cloudflare OS mark. */
  siteLogo?: AvatarImage;

  /** Deployment-wide top-bar notice (centered text in the top navigation bar). Empty when none is set. */
  announcement: string;

  /** Deployment-wide full-width banner shown across the top of the app. Empty text hides it. */
  banner: string;
  bannerColor: BannerColor;

  /**
   * Deployment accent (brand) color as a hex string, or "" to use the default theme. The client
   * overrides the brand CSS variables with this (and derived shades) at runtime.
   */
  accentColor: string;
};

/** Supported AI providers. */
export type AiModelProvider =
    "openai" | "anthropic" | "google" | "cloudflare" | "deepseek" | "ollama";

/** Providers that always use administrator-controlled Deployment Model credentials directly. */
export const DIRECT_ONLY_AI_PROVIDERS: ReadonlySet<AiModelProvider> =
    new Set<AiModelProvider>(["deepseek", "ollama"]);

/** Information about the AI gateway configuration. Returned by `AdminApi.getAiGatewayInfo()`. */
export type AiGatewayInfo = {
  enabled: true;
  enabledProviders: AiModelProvider[];
} | {
  enabled: false;
};

/** Configuration specifying how to connect to an AI model provider. */
export type AiModelConfig = {
  /** Which AI provider hosts the model? */
  provider: AiModelProvider;

  /** Name of the specific model, as specified to the provider's API. */
  model: string;

  /** Secret API token for the respective provider, for billing purposes. */
  apiToken: string;

  /**
   * Cloudflare account ID owning the Workers AI deployment the token authorizes. Required for
   * provider "cloudflare" (whose REST endpoint is account-scoped); unused for other providers.
   */
  accountId?: string;

  /**
   * URL of the API. If not specified, use the default for the provider. Overriding the URL is
   * useful in order to use AI proxy products like Cloudflare's AI gateway, or even to use an
   * alternative provider that provides a compatible API.
   */
  apiUrl?: string;
};

/** Public Deployment Model Catalog data. It never contains Model Configuration. */
export type DeploymentModelCatalog = {
  /** Deployment Models in selection order. */
  models: AiChatAuthorInfo[];
  /** Stable public reference for the Deployment Default Model, or null when none exists. */
  defaultModelId: string | null;
  /** Stable public reference for the Deployment Quick Model, or null to use the default. */
  quickModelId: string | null;
};

/**
 * Workers AI adds the response cap to the prompt and rejects a request whose total exceeds the
 * model's window, so every Cloudflare model reserves this much of it for the response.
 */
export const WORKERS_AI_OUTPUT_LIMIT = 32768;

/**
 * Models offered in the picker. `contextWindow` is the maximum tokens one request may total.
 * `outputLimit`, when present, is both the requested response cap and the space reserved for it,
 * leaving the remainder as the prompt budget context compaction sizes against.
 */
export const SUGGESTED_MODELS: Record<
  AiModelProvider,
  Record<string, {name: string, contextWindow: number, outputLimit?: number}>
> = {
  "cloudflare": {
    "@cf/moonshotai/kimi-k2.7-code": {
      name: "Kimi K2.7 Code (Workers AI)", contextWindow: 262144,
      outputLimit: WORKERS_AI_OUTPUT_LIMIT,
    },
    "@cf/zai-org/glm-5.2": {
      name: "GLM 5.2 (Workers AI)", contextWindow: 262144, outputLimit: WORKERS_AI_OUTPUT_LIMIT,
    },
  },
  "anthropic": {
    // TODO: Include Fable -- but we need an admin option to disable it, since many orgs don't
    //   allow it for ZDR reasons. It's sort of overkill for building gadgets anyway.
    "claude-opus-5": {name: "Claude Opus 5", contextWindow: 1000000},
    "claude-sonnet-5": {name: "Claude Sonnet 5", contextWindow: 1000000},
    "claude-haiku-4-5": {name: "Claude Haiku 4.5", contextWindow: 200000},
  },
  "openai": {
    "gpt-5.6-sol": {name: "GPT 5.6 Sol", contextWindow: 1050000, outputLimit: 128000},
    "gpt-5.6-luna": {name: "GPT 5.6 Luna", contextWindow: 1050000, outputLimit: 128000},
    "gpt-5.6-terra": {name: "GPT 5.6 Terra", contextWindow: 1050000, outputLimit: 128000},
  },
  "google": {
    "gemini-3.6-flash": {name: "Gemini 3.6 Flash", contextWindow: 1048576},
  },
  "deepseek": {
    // DeepSeek's official API (OpenAI Chat-Completions compatible). Both models carry a 1M-token
    // window. `outputLimit` is a deliberate cap below pi's catalog max (384k): it is both the
    // response cap and the slice reserved from the prompt budget, so 64k caps responses at a
    // practical size while leaving ~936k as prompt budget -- long chats rarely compact. Raise it
    // for bigger single responses (at the cost of a smaller prompt budget), or lower it to compact
    // even later.
    "deepseek-v4-flash": {
      name: "DeepSeek V4 Flash", contextWindow: 1_000_000, outputLimit: 64_000,
    },
    "deepseek-v4-pro": {
      name: "DeepSeek V4 Pro", contextWindow: 1_000_000, outputLimit: 64_000,
    },
  },
  "ollama": {
  },
};

/**
 * Metadata about a workspace (one Overseer DO and everything in it). Includes everything needed
 * to render the workspace list on the front page.
 *
 * TODO(multi-gadget): Rename `WorkspaceMetadata`.
 */
export type GadgetMetadata = {
  /**
   * Unique ID for this workspace, used with `openGadget()`. This is a url-safe base64 value
   * chosen randomly when the workspace is created.
   */
  id: string;

  /**
   * Human-readable workspace title. Can be modified. (Per-gadget titles live on the gadget
   * workpieces themselves; see WorkpieceSummary.)
   */
  title: string;

  /** Total cost of AI inference in dollars, if known. */
  totalCost?: number;

  /** Whether the user has pinned this gadget to the top of their list. */
  pinned?: boolean;

  /**
   * Set when the gadget is not owned by the current user. Presence of this field indicates the
   * user is a collaborator, not the owner.
   */
  owner?: AiChatAuthorInfo;

  /**
   * The viewing user's effective role for this gadget. The owner is always "build". Used by the
   * frontend to decide whether to render the full editor ("build") or the UI-only shell ("use").
   * Absent implies "build" for backwards compatibility.
   */
  role?: CollaboratorRole;

  /**
   * True when the gadget has observed data marked as share-prohibited. Such gadgets can no longer
   * be shared with additional users or links.
   */
  sharingProhibited?: boolean;

  /**
   * Various objects in the API specify a gadgetId, but make the property optional. When omitted,
   * the default gadget ID should be assumed. This is largely for backwards compatibility with
   * records that were stored before workspaces could have multiple gadgets.
   *
   * TODO(multi-gadget): Do a migration to backfill all gadget IDs, then eliminate the concept of
   * a default gadget from the API.
   */
  defaultGadgetId?: WorkpieceId;

  // TODO:
  // - created / modified / activity times
  // - icon? thumbnail?
}

/**
 * GadgetMetadata extended with timestamps. These are available when listing gadgets from the
 * user's collection, but not from the Overseer (which doesn't track them).
 */
export type GadgetMetadataWithTimestamps = GadgetMetadata & {
  created: Date;
  lastActive: Date;
}

/**
 * The icons an output format may be drawn with. A closed set because we want them to look consistent.
 * The glyphs themselves live in the frontend, so only these keys ever cross the wire.
 */
export const OUTPUT_ICONS = ["fileText", "gridNine", "presentation", "appWindow", "flowArrow",
    "kanban", "chartBar", "table", "notebook", "listChecks"] as const;

/** One of `OUTPUT_ICONS`, naming a glyph the frontend knows how to draw. */
export type OutputIcon = typeof OUTPUT_ICONS[number];

/**
 * Whether an unknown value names one of the icons this deployment can draw. Used wherever an icon
 * arrives from outside the kernel: a published blueprint, an admin override, or the browser.
 */
export function isOutputIcon(value: unknown): value is OutputIcon {
  return typeof value === "string" && (OUTPUT_ICONS as readonly string[]).includes(value);
}

/**
 * What instantiating a blueprint produces: a Document, a Spreadsheet, a Workflow, etc. Declared
 * by the blueprint's author (see `BlueprintMetadata.output`), inherited by every gadget instantiated
 * from it, and used wherever that gadget is shown in place of generic gadget.
 *
 * Declaring this is presentation only. Any user can publish a blueprint calling itself a
 * Document; that must be harmless. Being offered as one of the deployment's standard formats (in
 * the New menu, or the agent's preferred list) is a separate, admin-curated decision.
 */
export type BlueprintOutput = {
  /**
   * Stable grouping slug, e.g. "document". Outputs sharing an id are grouped together on the
   * outputs page.
   */
  id: string;

  noun: string;
  plural: string;

  icon: OutputIcon;
};

/**
 * One entry of the "New ..." menu, as returned by `listOutputFormats()`. This names a blueprint the
 * deployment has promoted, instantiated with `newGadgetFromBlueprint(blueprintId, ...)` like any other.
 */
export type OutputFormatOffer = {
  blueprintId: string;

  /**
   * How to name and draw it: the blueprint's own declaration with any deployment override
   * applied. Also what the created gadget inherits.
   */
  output: BlueprintOutput;

  /** The blueprint's description. */
  description: string;

  /** The blueprint needs bindings wired up before it can run. */
  requiresSetup: boolean;
};

/** The result of `AuthenticatedApi.listOutputs()`. */
export type ListOutputsResult = {
  /** Every output indexed so far. */
  outputs: OutputSummary[];

  /**
   * Set while workspaces predating the index are still being swept into it, which happens once per
   * user after a deployment upgrades. Each call sweeps a bounded number of them, so a caller that
   * wants the rest calls again until this is false.
   *
   * False means stop asking, not that the index is complete. A workspace that couldn't be reached
   * is passed over rather than retried forever, and a sweep that reached none of them gives up for
   * now instead of spinning. Either way the gap closes when the workspace is next opened, and the
   * next call to this method resumes any sweep that was left unfinished.
   */
  catchingUp: boolean;
};

/**
 * One entry in the user's output index: something a workspace produced that the user can open
 * directly.
 */
export type OutputSummary = {
  /** The workspace that contains this output (an `openGadget()` id). */
  workspaceId: string;

  /**
   * The workpiece within that workspace. `(workspaceId, workpieceId)` uniquely identifies an
   * output.
   */
  workpieceId: WorkpieceId;

  /**
   * The format this output was built as, if it came from a blueprint declaring one. Absent for a
   * gadget built from scratch, which displays as a generic app.
   */
  output?: BlueprintOutput;

  title: string;
  workspaceTitle: string;
  created: Date;

  /**
   * When the containing workspace was last active. Outputs have no activity timestamp of their
   * own yet, so all outputs of a workspace share this value.
   */
  lastActive: Date;

  /**
   * Set when the containing workspace is owned by someone else (i.e. it was shared with the
   * caller).
   */
  owner?: AiChatAuthorInfo;

  /**
   * The caller's role, cached on their last open and refreshed when a revocation downgrades them,
   * so a listing can offer only the actions it permits; the workspace still authorizes each one
   * when attempted. Absent for the caller's own workspaces, and for a shared one whose last open
   * predates this field.
   */
  role?: CollaboratorRole;
}

/**
 * Describes the client-side UI code for a Gadget. Such code is intended to run inside an iframe
 * sandbox with no access to the outside world except through an RPC interface to the Workshop
 * and to the Gadget's server.
 */
export type UiBundle = {
  // URL from which the main bundle of UI code can be downloaded. This download contains all the
  // Gadget's client-side assets. The URL is content-addressed to make it highly cacheable, even
  // across multiple Gadgets sharing the same implementation (blueprint).
  //
  // TODO: Specify the format of what this URL returns. A raw HTML page doesn't quite work because
  //   the client needs to initialize the sandbox with some platform libraries before loading the
  //   Gadget itself.
//  url: string;

  /**
   * Returns the raw JS code to execute in the Gadget iframe.
   * TODO: For now we just return the code but we should switch to serving over HTTP as described
   *   above, for caching. Or... maybe we should actually serve over RPC, but also employ the
   *   Cache API in the browser? Or some other local storage?
   */
  jsCode: string;

  // Other metadata could be placed here in the future, e.g. to specify what version of support
  // libraries should be loaded.
};

/** Represents an incremental update to the code. */
export type CodeUpdate = {
  /** Version number of the code AFTER this update has been applied. */
  version: number;

  /** Original timestamp of this update. */
  timestamp: Date;

  /**
   * Yjs encoded update blob, encoding at least all changes since the previous version that the
   * client is known to already have.
   *
   * All encoded updates use V2 format.
   */
  update: Uint8Array;
}

/** Callback interface used to receive code updates from the server. */
export interface CodeSubscriber {
  /**
   * Called any time the version on the server is newer than what the subscriber has.
   *
   * When the subscriber is multiple versions behind, the server may choose to send multiple
   * incremental updates or one big update. The server may make several calls in rapid succession
   * without waiting for previous calls to return. Cap'n Web guarantees that the calls will be
   * delivered in order, but it is important that the subscriber either applies the updates or
   * places them in some sort of queue synchronously to maintain ordering.
   */
  update(up: CodeUpdate): void;

  /**
   * Called the first time the subscriber is up-to-date with the latest version known to the
   * server.
   */
  ready(): void;
}

/** Durable state of one Action, observation, or hook audit entry. */
export type ActionState =
  | "pending"
  | "applying"
  | "accepted"
  | "failed-before-execution"
  | "unknown"
  | "rejected"
  | "reverted";

export type ActionLogEntry = {
  /** Sequential ID number for the action. Counts up from when the workspace was created. */
  id: number;

  /**
   * Which gatekeeper produced this action? Omitted if the log entry came from a non-gatekeeper
   * source (e.g. webFetch tool).
   */
  gatekeeperId?: WorkpieceId;

  resourceTitle: string;
  resourceUrl?: string;

  createdAt: Date;
  /** Time approval was durably claimed, before any Billable API Operation began. */
  approvedAt?: Date;
  appliedAt?: Date;

  state: ActionState;
} & ({
  type: "action";
  description: ActionDescription;
  /**
   * Who resolved the approval gate. Set when the Action leaves `pending`; absent while pending or
   * for legacy records resolved before this was tracked. For an auto-approved Action this is the
   * user who enabled the rule.
   */
  resolvedBy?: AiChatAuthorInfo;

  /**
   * True when approval was claimed automatically rather than by a human clicking Approve.
   */
  autoApproved?: boolean;
} | {
  type: "observation";
  description: ObservationDescription;
} | {
  type: "bindHook";

  description: HookDescription;

  /** Hook that was created by this action. `undefined` if it was later deleted. */
  hookId?: number;

  /** Is the hook currently enabled? */
  enabled: boolean;

  // Note that `state` is not meaningful for hooks. Instead of being "accepted" or "rejected", they
  // are enabled/disabled, which the user can freely toggle as often as they want.
});

export type BoundHookInfo = {
  id: number;

  /** The gatekeeper that delivers this hook. */
  gatekeeperId: WorkpieceId;

  /** The gadget whose code this hook wakes. */
  gadgetId: WorkpieceId;

  resourceTitle?: string;
  resourceUrl?: string;
  description: HookDescription;
  enabled: boolean;
};

/**
 * Configuration for an AI spawner binding. This binding allows the gadget to programmatically
 * create new agents, that is, start new agent chat threads, which appear in the gadget's agent
 * chat UI as new conversations. Agents created this way don't typically edit the gadget code, but
 * rather use the `executeCode` tool to directly invoke the gadget's bindings to perform tasks.
 * Each agent can additionally be provide "props" which may include additional RPC stubs
 * representing specific resources or callbacks relevant to that agent session.
 *
 * For example, a gadget that responds to emails might invoke an agent for each email message that
 * arrives, with an RPC stub that allows it to reply to that email -- but prohibits the agent from
 * seeing or replying to any other email, to guard against prompt injection or information leakage
 * between email threads.
 */
export type AgentSpawnerConfig = {
  /** Display name for the binding, shown in the binding list. */
  displayName: string,

  /**
   * Model ID to run, of the gadget owner's available models. Can be `null` to just create a chat
   * that doesn't actually run an agent -- the chat will be notified that the chat needs attention,
   * same as for an agent chat where the agent fails to mark the task complete.
   */
  modelId: string | null,

  /**
   * The bindings available to agents spawned by this spawner: binding name (as it appears as
   * `env.NAME` in the spawned agent's executeCode environment) -> target workpiece. When an agent
   * is spawned, this map is snapshotted into the spawned chat's seed binding layer (entries whose
   * targets no longer exist are dropped); the spawned agent sees only these bindings, never the
   * workspace's default binding list.
   *
   * The entries are deliberately not limited to bindings held by the gadget that owns the
   * spawner: a spawner may define bindings of its own, with its own names and targets.
   */
  env: Record<string, WorkpieceId>,
};

/**
 * Interface to a workspace's Overseer, used to display the Gadget Workshop shell UI around that
 * workspace. Workspace-level concerns live here: the gadget registry, code sync (one Yjs doc for
 * the whole workspace), chats, actions/hooks, sharing, and blueprint listing. Per-gadget
 * operations live on the GadgetClient sub-capability (see createGadget()/getGadget()).
 */
export interface Overseer extends RpcTarget {
  /** Get metadata describing this workspace. */
  getMetadata(): Promise<GadgetMetadata>;

  /**
   * Get metadata describing this workspace and subscribe to changes.
   *
   * `callback` will be called once immediately with the current metadata, then again any time it
   * changes.
   *
   * Disposing the returned `RpcStub` will cancel the subscription.
   */
  subscribeToMetadata(
      callback: RpcStub<(metadata: GadgetMetadata) => void>)
      : Promise<RpcStub<{}>>;

  /**
   * Receive the current viewer roster, then incremental updates as viewers come and go.
   * A viewer is present for the lifetime of the openGadget() session.
   */
  subscribeToPresence(subscriber: RpcStub<PresenceSubscriber>): Promise<RpcStub<{}>>;

  /** Change the workspace title. */
  setTitle(title: string): Promise<void>;

  /** Pin or unpin this workspace in the user's list. */
  setPinned(pinned: boolean): Promise<void>;

  /**
   * Instruct the workspace to delete itself, removing it from the User's workspace list and
   * deleting all data. Further method calls will fail.
   *
   * TODO: Implement undelete, maybe using PITR...
   */
  deleteSelf(): Promise<void>;

  /**
   * Subscribe to the workspace's workpiece list.
   *
   * The subscriber receives one entry() per existing workpiece, followed by ready(), then
   * incremental entry()/removed() calls as workpieces are created, renamed, or deleted. In v1
   * only gadget-type workpieces are delivered (see WorkpieceSummary).
   *
   * Disposing the returned `RpcStub` will cancel the subscription.
   */
  subscribeToWorkpieces(subscriber: RpcStub<WorkpiecesSubscriber>): Promise<RpcStub<{}>>;

  /**
   * Create a new gadget workpiece in this workspace. `title` is required -- gadgets have no
   * default title. The new gadget starts with no files and no bindings.
   *
   * If `chatId` is provided, the creation is provisional to that chat, exactly like code edits
   * made with a chat open: a `changes` message records it in the chat log (see
   * `createdGadgets`), and the gadget remains pending (see WorkpieceSummary.chatId) until
   * the user accepts the chat's changes through that message (merging deletes the pending marker;
   * reverting deletes the gadget). Without `chatId` the gadget is created permanently.
   *
   * `bindingName` is the name under which the gadget appears in chat envs and the workspace
   * default binding list (see validateBindingName()). When absent, the server chooses one from
   * the title (via the quick model when configured, else a generic fallback). Gadget binding
   * names are unique within the workspace: throws if the name is already taken by another
   * gadget -- including one still pending in another chat (retry after that chat's changes are
   * accepted or reverted).
   */
  createGadget(title: string, chatId?: number, bindingName?: string)
      : Promise<RpcStub<GadgetClient>>;

  /**
   * Get the gadget with the given workpiece ID. To allow for pipelining, this throws an
   * exception if there is no such gadget.
   */
  getGadget(id: WorkpieceId): Promise<RpcStub<GadgetClient>>;

  /**
   * Subscribe to code updates.
   *
   * Code is represented as a single Yjs doc shared by the whole workspace. Each workpiece that
   * owns files has its own root Y.Map (mapping file names to Y.Text instances) within the doc,
   * named per WorkpieceSummary.filesRoot. Updates are whole-doc and may span workpieces.
   *
   * `subscriber` will receive updates whenever it becomes out-of-date. `fromVersion` is the
   * version the subscriber already has before the subscription starts. To download the code from
   * scratch, omit the version (or pass zero).
   *
   * Disposing the returned `RpcStub` will cancel the subscription.
   */
  subscribeToCode(subscriber: RpcStub<CodeSubscriber>, fromVersion?: number): Promise<RpcStub<{}>>;

  /**
   * Send a Yjs update to the server.
   *
   * If `chatId` is omitted, the update applies to the committed mainline code. If `chatId`
   * is provided, the update is recorded as a live draft edit for that chat's branch.
   */
  updateCode(update: Uint8Array, chatId?: number): Promise<void>;

  /** Get an existing gatekeeper by workpiece ID. Throws if the ID doesn't exist. */
  getGatekeeperById(id: WorkpieceId): Promise<GatekeeperClient<any>>;

  /**
   * Try to create a new gatekeeper for this URL.
   *
   * `accountId` is the user's connected account to use to access this resource. To determine an
   * appropriate account, use `subscribeConnectedAccounts()` with a `filter` for this URL, then
   * let the user choose one.
   *
   * The new gatekeeper is a workspace-level workpiece; it is not bound into any gadget's `env` by
   * default. Use GadgetClient.bind() / bindWithSuggestedName() to expose it to a gadget.
   */
  newGatekeeper(accountId: number, resourceUrl: string): Promise<GatekeeperClient<any> | null>;

  /**
   * Create a new gatekeeper for an AI model binding. The model can be any returned by
   * listModels().
   */
  newAiModelGatekeeper(modelId: string): Promise<GatekeeperClient<any>>;

  /**
   * Create a new gatekeeper for an agent spawner binding. This allows the gadget to
   * programmatically spawn AI agents to complete tasks.
   */
  newAgentSpawnerGatekeeper(config: AgentSpawnerConfig): Promise<GatekeeperClient<any>>;

  /**
   * List history of actions.
   * TODO: This should be paginated.
   */
  listActions(): Promise<ActionLogEntry[]>;

  /**
   * Approve an action that is currently in the "pending" state. The action will be performed on
   * approval. Returns its durable execution outcome so the caller does not infer success from the
   * approval RPC completing.
   */
  approveAction(id: number): Promise<Extract<
    ActionState,
    "accepted" | "failed-before-execution" | "unknown" | "reverted"
  >>;

  /**
   * Reject an action that is in the "pending" state. This notifies the gatekeeper that it will not
   * be approved in the future.
   */
  rejectAction(id: number): Promise<"rejected">;

  /**
   * Revert an accepted Action through its Gatekeeper. This never starts a Billable API Operation
   * and never changes or reverses the original Usage Charge.
   */
  revertAction(id: number): Promise<void>;

  /**
   * List information about bound hooks (which could wake up a gadget asynchronously).
   *
   * The list spans the whole workspace; each entry names the gadget it wakes (see
   * BoundHookInfo.gadgetId), so a per-gadget view must filter on that.
   */
  listHooks(): Promise<BoundHookInfo[]>;

  /** Enable the hook with the given ID. Callbacks will begin flowing. */
  enableHook(id: number): Promise<void>;

  /** Disable the hook with the given ID. Callbacks will stop. */
  disableHook(id: number): Promise<void>;

  /** Permanently delete the hook. Implies disabling it. */
  deleteHook(id: number): Promise<void>;

  /**
   * Enable auto-approval of actions carrying the given `actionKind` (the
   * ActionDescription.actionKind) on the gatekeeper identified by `gatekeeperId`. Future actions
   * with that kind's tag whose author marked them `autoApprovable` are then applied automatically
   * without manual approval, and any matching action(s) already pending are applied immediately.
   *
   * Auto-approval rules are workspace-wide per gatekeeper: approving an action kind approves it
   * no matter which gadget invokes it.
   */
  setAutoApprovedActionKind(gatekeeperId: WorkpieceId, actionKind: ActionKind): Promise<void>;

  /**
   * Remove the auto-approval rule for `tag` on the given gatekeeper; matching actions then
   * require manual approval again.
   */
  removeAutoApprovedActionKind(gatekeeperId: WorkpieceId, tag: string): Promise<void>;

  /** List the currently-enabled auto-approval rules. */
  listAutoApprovedActionKinds(): Promise<Array<{ gatekeeperId: WorkpieceId; actionKind: ActionKind }>>;

  /**
   * List the auto-approvable action kinds offered by gatekeepers bound in this workspace. Each
   * entry identifies its connection and reports whether a matching auto-approval rule is enabled.
   */
  listPreApprovableActions(): Promise<PreApprovableAction[]>;

  /**
   * Accept an agent's pending connection request (a "connectionRequest" chat message). The caller
   * is responsible for having actually created the gatekeeper (via newGatekeeper()) and passes the
   * resulting gatekeeper id. The gatekeeper is surfaced to the agent as a named binding in the
   * chat's env, under the name the agent chose when it made the request (see
   * `connectionRequest.bindingName`). This marks the request accepted, updates the inline card,
   * and resumes the agent so it can use the resource.
   */
  acceptConnectionRequest(requestId: string, result: {gatekeeperId: WorkpieceId}): Promise<void>;

  /**
   * Deny an agent's pending connection request. Updates the inline card. Does NOT resume the agent:
   * the turn stays ended so the user can decide what to tell the agent to do instead.
   */
  denyConnectionRequest(requestId: string): Promise<void>;

  /**
   * Subscribe to action adds/updates. Dispose the returned stub to unsubscribe.
   * If `startAfter` is set, replay actions changed after that timestamp.
   */
  subscribeToActions(subscriber: RpcStub<ActionsSubscriber>, startAfter?: Date): Promise<RpcStub<{}>>;

  /** List past AI chats. */
  listChats(): Promise<AiChatMetadata[]>;

  /**
   * List available models. The first listed model should be the default, unless the user has
   * chosen something else.
   */
  listModels(): Promise<AiChatAuthorInfo[]>;

  /**
   * Fetch one page of messages in the chat history for the given chat thread. If `beforeSequence`
   * is absent, fetch the current tail. Otherwise, fetch messages before that sequence.
   *
   * Note that if you plan to subscribe to updates, you should initiate the subscription first,
   * before fetching history. Otherwise, you could theoretically miss a message that is sent
   * between when you fetch the history and when you subscribe.
   *
   * In typical usage, the client subscribes to all chat activity upfront, but only fetches
   * histories if and when the user opens a specific.
   */
  getChatHistory(chatId: number, beforeSequence?: number): Promise<AiChatHistoryPage>;

  /** Fetch a single message from a chat thread. */
  getChatMessage(chatId: number, sequence: number): Promise<AiChatMessage | undefined>;

  /**
   * Subscribe to all new chat messages (across all threads).
   *
   * If `startAt` is given, it must be a date in the past. All messages starting from that date
   * will be sent upfront. This is intended to allow resubscribing after being disconnected. If
   * `startAt` is omitted, only new messages will be sent.
   *
   * Generally, a client should subscribe to chats immediately on loading the gadget editor. If
   * the client needs to call any methods like `listChats()` to backfill content, it should make
   * these calls after `subscribeToChat()`, so that there's no chance of missing a message. (It is
   * not necessary to wait for `subscribeToChat()` to return -- only to initiate the call before
   * other read calls.)
   */
  subscribeToChat(subscriber: RpcStub<AiChatSubscriber>, startAfter?: Date): Promise<RpcStub<{}>>;

  /**
   * Lists slash commands available from Gatekeepers currently attached to this Gadget, including
   * ambient ones.
   */
  listSlashCommands(): Promise<SlashCommandChoice[]>;

  /**
   * Starts a new chat with the given initial message or slash-command request. A slash command
   * always creates a visible chat event, even when it does not produce a message for the agent.
   * Slash-command requests cannot include capsules or attachments.
   *
   * `modelId` is one of the IDs in the result of `listModels()`, or null to inhibit AI response
   * (useful when using chat to talk between humans).
   *
   * `formats` records where the message names one of the deployment's standard output formats, so
   * the transcript can draw it as a chip. Display only -- what the agent reads is the noun, which
   * is already in the text.
   */
  newChat(initialMessage: string | SlashCommandRequest, modelId: string | null,
          capsules?: CapsuleSpecifier[], attachments?: ChatAttachmentHandle[],
          formats?: MessageFormatRef[]): Promise<number>;

  /**
   * Send a message to the chat from this client. Sending a message causes the LLM to start
   * running if it isn't already.
   * If a slash command produces no message, only its visible invocation event is committed and the
   * agent does not run.
   * Slash-command requests cannot include capsules or attachments.
   *
   * `modelId` is one of the IDs in the result of `listModels()`, or null to inhibit AI response
   * (useful when using chat to talk between humans).
   *
   */
  sendChatMessage(chatId: number, message: string | SlashCommandRequest, modelId: string | null,
                  capsules?: CapsuleSpecifier[], attachments?: ChatAttachmentHandle[],
                  formats?: MessageFormatRef[]): Promise<void>;

  /**
   * Upload an attachment for use in a future chat message. This way by the time the user wants to
   * send the message, likely uploading is complete. `modelId` determines whether the
   * selected provider can receive a raw file attachment.
   *
   * Pass the returned handle to newChat() or sendChatMessage() to commit the attachment into chat history.
   */
  uploadChatAttachment(attachment: ChatAttachmentUpload, modelId: string | null): Promise<ChatAttachmentHandle>;

  /**
   * Fetch the bytes of a committed chat attachment over RPC. The canonical metadata is already
   * present in the message's ChatAttachmentRef. Images are inlined there, so this is normally used
   * only to download non-image attachments on demand.
   */
  getChatAttachmentContent(chatId: number, id: string): Promise<Uint8Array>;

  /** Delete an uploaded attachment that the user explicitly removed before sending the message. */
  deleteChatAttachment(id: string): Promise<void>;

  /**
   * Update the title of a chat. Usually not needed as a title is generated automatically from
   * the first message.
   */
  setChatTitle(chatId: number, title: string): Promise<void>;

  /**
   * Indicates that the user has requested that proposed changes through the given sequence number
   * in the chat thread be merged into the mainline.
   *
   * If `options.includeDraft` is true, any current live draft for the chat is first materialized
   * into one durable `changes` message and included in the merge.
   */
  mergeChanges(
      chatId: number, mergeThrough: number | null,
      options?: { includeDraft?: boolean }): Promise<void>;

  /**
   * Indicates that the user has requested that proposed changes starting from the given sequence
   * number in the chat thread be reverted.
   */
  revertChanges(chatId: number, revertFrom: number): Promise<void>;

  /**
   * Materialize the current live draft for the chat into one durable `changes` message without
   * merging it into the mainline.
   */
  finalizeChatDraft(chatId: number): Promise<void>;

  /** Discard the current live draft for the chat without affecting any durable `changes` messages. */
  discardChatDraftChanges(chatId: number): Promise<void>;

  /** Delete a chat thread. */
  deleteChat(chatId: number): Promise<void>;

  /**
   * Request that any ongoing LLM session in the given chat immediately stop.
   *
   * If an LLM is running, the session is canceled subscribers will receive a metadata update
   * reflecting this before `stop()` returns.
   *
   * If no LLM is running, `stop()` does nothing and returns immediately.
   */
  stopAgent(chatId: number): Promise<void>;

  /**
   * Retry the agent on the given chat. This starts the agent without adding a new user message.
   * The agent will re-process the existing chat history using the specified model.
   *
   * If an agent is already running, this does nothing.
   */
  retryAgent(chatId: number, modelId: string): Promise<void>;

  /**
   * Subscribe to the gadget worker's console logs. This allows the user to observe console logs
   * being produced by the gadget.
   *
   * At present, logs are not stored, so the only way to see them is to be subscribed when they
   * happen.
   *
   * To unsubscribe, dispose the returned stub.
   */
  subscribeToConsoleLogs(subscriber: RpcStub<ConsoleLogSubscriber>): Promise<RpcStub<{}>>;

  // --- Blueprint management ---
  //
  // Blueprint listing and maintenance are workspace-level (each blueprint record remembers which
  // gadget it exports). Creating a blueprint is per-gadget: see GadgetClient.createBlueprint().

  /** List blueprints created from this workspace's gadgets. */
  listBlueprints(): Promise<BlueprintGadgetSummary[]>;

  /**
   * Update an existing blueprint. Any combination of metadata and code can be updated
   * atomically in a single call with one propagation pass.
   *
   * - `title` / `description`: if provided, update the respective field.
   * - `updateCode`: if true, snapshot the source gadget's current committed code into the
   *   blueprint and increment the blueprint version.
   * - `updateBindings`: if true, refresh the blueprint's connection annotations from
   *   the source gadget's current bindings without changing the code snapshot.
   *
   * At least one option must be provided.
   */
  updateBlueprint(blueprintId: string, options: {
    title?: string;
    description?: string;
    updateCode?: boolean;
    updateBindings?: boolean;
    screenshot?: BlueprintScreenshotUpload | null;
  }): Promise<void>;

  /** Delete a blueprint. Cleans up KV, R2, User DO, and local storage. */
  deleteBlueprint(blueprintId: string): Promise<void>;

  /**
   * Retry publishing a blueprint whose `dirty` flag is set (meaning a previous propagation
   * to User DO / KV / R2 failed).
   */
  retryBlueprintPublish(blueprintId: string): Promise<void>;

  // --- Collaborator management ---

  /**
   * List the connections a recipient with `role` must verify before opening this workspace, in
   * the order the connections were created. Reports what sharing will cost the recipient; it
   * grants nothing and mints no capability.
   */
  listObserverRequirements(role: CollaboratorRole): Promise<ObserverBindingNeed[]>;

  /** List all collaborators. Available to owner and all collaborators. */
  listCollaborators(): Promise<CollaboratorInfo[]>;

  /**
   * Add a collaborator by username/email. The caller must be the owner or an existing
   * collaborator. `role` is the access level to grant; the caller may not grant a role higher
   * than their own effective role. Returns the new collaborator's info, or null if the username
   * doesn't correspond to an existing account.
   */
  addCollaborator(username: string, role: CollaboratorRole,
                  note?: string): Promise<CollaboratorInfo | null>;

  /**
   * Remove a collaborator (identified by profile.id).
   *
   * Owner can remove anyone. A non-owner collaborator can only remove their own edge(s)
   * from the target. If the target still has edges from other sources, they keep access
   * and the return is an empty array. If no edges remain, the target is fully removed.
   *
   * When a target is fully removed, `keepUsers` lists the profile.ids of users who would
   * lose access transitively but should be retained. Their PermissionEdges through the
   * removed user are replaced with new edges from the caller. Users reachable only through
   * the removed user who are NOT in `keepUsers` are also removed.
   *
   * Returns the list of users whose access actually changed (removed or downgraded), including
   * the primary target. An empty array means the caller's edge was removed but no one's effective
   * access changed (the target retained their role through other edges).
   */
  removeCollaborator(profileId: string, keepUsers: string[]): Promise<AffectedCollaborator[]>;

  /**
   * Preview what would happen if a collaborator were removed. For a non-owner caller,
   * if the target has edges from other sources that would survive, returns an empty array
   * (the target would not actually be affected). Otherwise, returns the list of users whose
   * access would change (lose access or be downgraded to a lower role) as a consequence, so the
   * caller can present checkboxes for which to keep vs. remove.
   */
  previewRemoveCollaborator(profileId: string): Promise<AffectedCollaborator[]>;

  // --- Share link management ---
  //
  // A share *link* may back several keys: `createShareLink` mints the first and `newShareLinkKey`
  // mints more on demand. Renaming, revoking, and grants apply to the link.

  /**
   * Create a share link. The server generates a random 128-bit key, stores its HMAC-SHA-256
   * hash, and returns the raw key (hex-encoded) along with the id of the link it created. The
   * caller constructs a URL from the key. The raw key is never stored server-side. `role` is the
   * access level granted to anyone who redeems the link; the caller may not grant a role higher
   * than their own effective role.
   */
  createShareLink(role: CollaboratorRole, note?: string)
      : Promise<{ key: string; linkId: string }>;

  /**
   * Mint a fresh secret for an existing link so the user can copy a new URL without creating a
   * whole new link. The old secrets remain valid, and revoking the link revokes them all together.
   */
  newShareLinkKey(linkId: string): Promise<{ key: string }>;

  /** List active share links (for management UI). */
  listShareLinks(): Promise<ShareLinkInfo[]>;

  /**
   * Update a share link's management metadata. The raw secrets are not available after creation;
   * this only edits the stored note used by the management UI.
   */
  updateShareLink(linkId: string, note?: string): Promise<void>;

  /**
   * Revoke a share link by its `linkId`, which revokes every secret ever minted for it. Users who
   * gained access through the link may be transitively removed or downgraded. `keepUsers` lists
   * profile.ids of users who should be retained at their prior role with fresh edges from the
   * caller. Returns the list of users whose access actually changed (removed or downgraded).
   */
  revokeShareLink(linkId: string, keepUsers: string[]): Promise<AffectedCollaborator[]>;

  /**
   * Preview what would happen if a share link were revoked. Returns the list of users whose access
   * would change (lose access or be downgraded to a lower role) as a consequence, so the caller
   * can present checkboxes for which to keep vs. remove.
   */
  previewRevokeShareLink(linkId: string): Promise<AffectedCollaborator[]>;
}

export type AiChatMetadata = {
  id: number,
  title: string,
  started: Date,
  lastActive: Date,

  /**
   * If present, an LLM (described by the author info) is currently actively responding to the
   * chat.
   */
  activeAgent?: AiChatAuthorInfo,

  /**
   * If true, this chat thread has proposed changes which have not been accepted yet,
   * including any live draft edits that have not yet been materialized into a durable
   * `changes` message.
   */
  hasProposedChanges?: boolean;

  /** If this was started from an agent spawner, the spawner's display name. */
  spawnerName?: string;

  /**
   * Tokens the model reported for this conversation's last step, if known. Cleared when compaction
   * changes what the next prompt will contain, until a step measures it again.
   */
  totalTokens?: number;

  /** Total cost of this conversation so far, in dollars, if known. */
  totalCost?: number;

  /**
   * First sequence this chat still replays. Everything before it is covered by a compaction
   * checkpoint; those messages remain in canonical history but no longer drive current-state reads.
   */
  compactedTo?: number;
};

/**
 * One page of a chat's history, bounded below by a compaction checkpoint. Compaction doesn't delete
 * messages, so a long thread is read one checkpoint-delimited page at a time.
 */
export type AiChatHistoryPage = {
  /** The page's messages, ascending by sequence. */
  messages: AiChatMessage[];

  /** The checkpoint bounding this page below, absent once the page reaches the thread's start. */
  compacted?: {
    /** First sequence in this page. Pass as `getChatHistory`'s `beforeSequence` for the page before. */
    to: number;

    /**
     * Summary that replaces the messages before `to` in subsequent model prompts, exposed so the
     * user can inspect the context kept across the boundary.
     */
    summary: string;

    /**
     * Changes still proposed before `to`, merged into one update, so the client can show pending
     * changes without loading the messages that recorded them.
     */
    proposedChanges?: Uint8Array;
  };
};

export type AiChatAuthorInfo = {
  /**
   * Is the author a human, AI, or Gadget?
   *
   * "gadget" means this is a prompt sent to an agent spawner -- i.e. a gadget spawned an
   * agent programmatically. In this case `id` is the gadget's owner's ID (for accounting purposes)
   * and `name` is the gadget title.
   */
  type: "user" | "agent" | "gadget";

  /** Unique user identifier, e.g. "kenton@cloudflare.com" or "gpt-5.1-pro". */
  id: string;

  /** Display name for author, e.g. "Kenton Varda" or "GPT" */
  name: string;

  // Note: the avatar is intentionally not included here to keep this type lightweight (it's
  // embedded in every chat message). Fetch user avatars separately via
  // `AuthenticatedApi.getAvatar(userId)`.
};

export type AiChatMessage = {
  chatId: number;
  sequence: number;
  timestamp: Date;
  author: AiChatAuthorInfo;
} & AiChatMessageBody;

export type AiChatMessageBody = {
  /** A regular chat message. */
  type: "message";
  message: string;

  /**
   * The message may contain "capsules", which are embedded capabilities that reference external
   * resources. See `CapsuleSpecifier` for more.
   */
  capsules?: CapsuleSpecifier[];

  /**
   * Standard output formats the message names, e.g. "create a Doc for homework and Slides for the
   * presentation". See `MessageFormatRef`.
   */
  formats?: MessageFormatRef[];

  /**
   * If the AI produces any thinking/reasoning text, this is it. This should be hidden by default
   * but the user should have the option to expand it.
   */
  reasoning?: string;

  /** Messages from an AI agent can invoke tools. */
  toolCalls?: AiToolCall[];

  /** Attachments that were sent with this message. Actual bytes stored separately. */
  attachments?: ChatAttachmentRef[];

  /**
   * Sequence of the visible slash-command event that generated this agent-visible message.
   * Clients use this to group the two records for display.
   */
  generatedBySlashCommandSequence?: number;
} | {
  /**
   * A slash command exactly as requested by the client, retained for display and never included in
   * model context. A gatekeeper command does not itself start an agent turn -- the prompt it expands
   * to arrives as a separate `message`. A built-in command is handled by the Workshop, and this
   * record is what drives the turn it runs.
   */
  type: "slashCommand";
  request: SlashCommandRequest;

  /** Provider-supplied skill name for the display badge. Commands without one show no badge. */
  skillName?: string;
} | {
  /**
   * Represents changes made to the code by an agent tool call or by a collaborating user as part
   * of a chat. These changes are provisional until they are accepted.
   */
  type: "changes";

  /**
   * The code changes themselves, as a Yjs-encoded (V2) update against the workspace code Y.Doc.
   * Absent when the batch records only gadget creations and/or binding additions with no
   * accompanying code edits.
   */
  update?: Uint8Array;

  /**
   * The workspace code version that `update` was built against. Once an agent session observes
   * the code at some version, the chat stays locked to that version (see
   * AiToolCall.observedCodeVersion), so history replay must learn each update's base version
   * *before* it reconstructs the session's code state. Present whenever `update` is, except in
   * messages persisted before this field existed. For user-authored batches this records the
   * mainline base at the time the user's edits were captured, which may legitimately differ
   * from the version an agent session is locked to (the user can accept changes -- advancing
   * mainline -- and keep editing); such stamps seed a session's version lock but are never
   * checked against it.
   */
  observedCodeVersion?: number;

  /**
   * Gadgets created as part of this batch of changes (by the agent's `createGadget` tool, or by
   * the user via Overseer.createGadget() with a chat open -- in the latter case `update` is
   * omitted). Like the code changes themselves, the creations are provisional: a merge
   * through this message makes them permanent, and a revert covering it deletes them. Titles are
   * denormalized for display, since a reverted creation's registry record is gone. `bindingName`
   * is the name under which the gadget appears in the creating chat's env (and, once merged, the
   * workspace default binding list); recording it here lets the creating chat pick the name back
   * up on replay.
   */
  createdGadgets?: {gadgetId: WorkpieceId, title: string, bindingName: string}[];

  /**
   * Binding edges added to gadgets as part of this batch of changes (by the agent's
   * setGadgetBinding tool, or by the user binding a connection with a chat open -- in the latter
   * case `update` is omitted). Like `createdGadgets`, the additions are
   * provisional: the edge is visible only from this chat until a merge through this message
   * makes it permanent, and a revert covering it deletes the edge. `name` is the binding's name
   * within the gadget identified by `gadgetId`; `target` is the bound workpiece.
   */
  addedBindings?: {gadgetId: WorkpieceId, name: string, target: WorkpieceId}[];
} | {
  /**
   * Indicates that at this point in the chat, the user chose to merge all (non-reverted) changes
   * in this chat up to and including the given sequence number.
   */
  type: "merge";
  mergeThrough: number;

  /**
   * Code version at which the merge was applied. (A merge covering only gadget creations /
   * binding additions writes no new code version; this then records the bumped version counter.)
   */
  version: number;
} | {
  /**
   * Indicates that at this point in the chat, the user chose to revert all changes starting at the
   * given sequence number through the end of the chat as of that time. These changes are
   * completely erased from the Yjs history. Subsequent changes will be based only on what existed
   * before this point, and any later merge will not include the reverted changes.
   */
  type: "revert";
  revertFrom: number;
} | {
  /** Indicates that the agent in this chat performed an action. */
  type: "action",
  actionId: number;

  /**
   * Denormalized description of the action.
   *
   * This is inlined into the message at the time of query, so it is always present and always
   * current in messages delivered to the client. It is marked optional only because it is not
   * present in messages stored in the chat table on the server side.
   */
  actionLog?: ActionLogEntry;
} | {
  /**
   * Indicates that the AI agent accessed the gadget one or more times. This is logged in order
   * to track whether information known to the gadget may have tainted the agent session.
   */
  type: "useGadget";
} | {
  /**
   * Indicates that the agent run ended with an error (e.g. LLM API failure, abort, server
   * restart). This is displayed to the user with a "retry" button, but is NOT included in the
   * chat log sent to the LLM so the agent does not react to it.
   */
  type: "error";
  message: string;
  /** Optional machine-readable code for presenting a stable category of error. */
  code?: string;
} | {
  /**
   * Indicates that a callback was received on the agent's `self` object. When the agent uses
   * `executeCode`, the executed code receives a `self` parameter. Calling any method on `self`
   * (e.g., `self.onUpdate(data)`) delivers a callback message back to this chat thread and
   * activates the agent to respond.
   */
  type: "agentCallback";

  /** The method name that was called on `self`. */
  methodName: string;

  /** A depth-limited summary string of the arguments for the agent's context window. */
  argsSummary: string;
} | {
  /**
   * A system-generated nudge message sent to the agent when it tries to end its turn while
   * agent callbacks are still unresolved. This is displayed as a user message to the LLM
   * so it can be prompted to continue.
   */
  type: "agentNudge";
  text: string;
} | {
  /**
   * The agent requested that the user connect a gatekeeper (e.g. "I need ClickHouse cluster X").
   * Rendered inline in the chat as an accept/deny card. State is mutated in-place when the user
   * accepts or denies; the message is re-delivered to subscribers so the card updates. On accept the
   * agent is resumed with the outcome (see the history builder in agent.ts); on deny the agent is
   * not resumed (the user drives what happens next).
   */
  type: "connectionRequest";

  /** Unique id used by acceptConnectionRequest()/denyConnectionRequest(). */
  requestId: string;

  /** The gatekeeper vendor the agent is requesting (id + denormalized display name). */
  vendorId: string;
  vendorName: string;

  /** Denormalized vendor logo URL, for the connection card icon. */
  vendorLogoUrl?: string;

  /**
   * Denormalized human-readable resource type/scope being requested (e.g. "Home Assistant
   * Instance", "Gmail Mailbox"), resolved from the vendor's supported resources at request time.
   */
  resourceTitle?: string;

  /**
   * A fully- or partially-specified resource URL, if the agent could infer one. When absent (or
   * incomplete) the accept flow opens the vendor's resource configurator to fill in the gaps.
   */
  resourceUrl?: string;

  /**
   * The urlPattern of the supported resource this request resolved to at request time (one of the
   * vendor's SupportedResource.urlPattern values, e.g. "https://github.com/:owner/:repo" or the
   * whole-instance "https://*"). The backend guarantees every connection request resolves to a
   * concrete resource (see resolveRequestedResource), and the accept modal pre-selects exactly this
   * resource — so accepting never opens a blank "create new connection" picker.
   */
  resourceUrlPattern?: string;

  /** Why the agent wants this connection. Shown to the user to inform their decision. */
  reason: string;

  /** Lifecycle state. Starts "pending"; set by the user's accept/deny. */
  state: "pending" | "accepted" | "denied";

  /**
   * Once accepted, the id of the created gatekeeper. The resource is surfaced to the agent as a
   * named binding in the chat's env; the agent can additionally bind it into a gadget via
   * setGadgetBinding if its gadget code needs it.
   */
  gatekeeperId?: WorkpieceId;

  /**
   * The name under which the resource will appear in the chat's env (`env.NAME` in executeCode)
   * once the request is accepted. Supplied by the agent as a required parameter of the
   * requestConnection tool -- the agent knows why it is requesting the resource, so it picks the
   * name itself -- and recorded here at request time. The name is claimed in the chat's scope
   * from that moment until the request is denied. Optional only because messages persisted
   * before named chat bindings existed lack it; those are named and stamped lazily at the
   * turn-start naming chokepoint.
   */
  bindingName?: string;
};

/**
 * Bytes to upload as a chat attachment.
 *
 * The server stores the bytes and returns the handle to pass when sending the message.
 */
export type ChatAttachmentUpload = {
  mimeType: string;
  content: Uint8Array;
  name?: string;
};

/**
 * Handle for an attachment that has been uploaded but not yet sent as part of a message.
 *
 * Pass this back unchanged when sending the chat message.
 */
export type ChatAttachmentHandle = {
  /** Clients must not infer storage paths from this ID or construct handles by hand. */
  id: string;
};

/**
 * Attachment metadata returned to clients.
 *
 * For image attachments, `content` carries the full image bytes inline so the client can render
 * them in the chat without an extra round trip. For other attachments, fetch the bytes on demand
 * via `Overseer.getChatAttachmentContent()`.
 */
export type ChatAttachmentRef = ChatAttachmentHandle & {
  mimeType: string;
  name?: string;
  size: number;

  /** Inlined bytes for small image attachments. Present only for images. */
  content?: Uint8Array;
};

/** Whether attachment bytes can be decoded and inlined into the agent's prompt as text. */
export function isTextLikeAttachmentMimeType(mimeType: string): boolean {
  if (mimeType.startsWith("image/")) return false;
  return mimeType.startsWith("text/") ||
      /\b(json|javascript|typescript|xml|yaml|csv|markdown)\b/.test(mimeType);
}

/**
 * Describes a tool call performed by an AI agent as part of a message.
 *
 * The agent addresses workpieces by their chat binding name (the `gadget`/`workpiece` parameters
 * on several variants), never by workpiece ID. Logs persisted before multi-gadget workspaces lack
 * these names; when a name is absent, the workspace's `defaultGadgetId` (from `GadgetMetadata`)
 * is assumed, and it is an error for it to be omitted when there is no default.
 */
export type AiToolCall = {
  /** ID of the original tool call, useful to reproduce the model messages. */
  toolCallId: string;

  /**
   * If present, this tool observed the code at the given version number.
   *
   * Note that generally once the agent observes code at a particular version, the server tries
   * to stay at that version for the rest of the thread, to avoid confusing the agent. ("changes"
   * messages record the base version of their code updates the same way; see AiChatMessageBody.)
   */
  observedCodeVersion?: number;

  /** If the tool failed, the error. */
  error?: string;
} & ({
  /**
   * Any workpiece can potentially export files. Gadgets, in particular, export their source code
   * as files, but other workpieces may export other filesystems. Hence, a file is identified by
   * the pair of a workpiece reference (the `workpiece` chat binding name) and `filename`.
   */
  toolName: "readFile";
  input: {workpiece?: string, filename: string};
} | {
  toolName: "writeFile";
  input: {
    workpiece?: string;
    filename: string;
    content: string;
  };
} | {
  toolName: "editFile";
  input: {
    workpiece?: string;
    filename: string;
    textToReplace: string;
    replacement: string;
  };
} | {
  /**
   * Describe one of the chat's bindings by name. Numeric names appear only in logs persisted
   * before named chat bindings (they were capsule indices).
   */
  toolName: "describeBinding";
  input: {
    name: string | number;
  };
} | {
  toolName: "setBindingHook";
  input: {
    bindingName: string;
    entrypoint: string | null;
  };
} | {
  /**
   * Wire one of the chat's bindings into a gadget's own binding list. The addition is provisional
   * to the chat, recorded by a "changes" message (see `addedBindings`).
   */
  toolName: "setGadgetBinding";
  input: {
    /** Chat binding name of the target gadget. */
    gadget: string;
    /** Chat binding name of the resource to wire into the gadget. */
    source: string;
    /** Name to bind the resource under within the gadget; defaults to `source`. */
    name?: string;
  };

  /**
   * The added binding edge as resolved when the tool ran, recorded so crash recovery can re-adopt
   * an addition whose "changes" message never flushed (see `addedBindings`), mirroring
   * createGadget's recorded output. `changeId` is the change number of the batch that records the
   * addition. Absent only when the call failed (`error` is set).
   */
  output?: {gadgetId: WorkpieceId, name: string, target: WorkpieceId, changeId: number};
} | {
  /**
   * Obsolete predecessor of `setGadgetBinding`, from before named chat bindings; appears only in
   * old chat logs. Its additions were immediate and permanent (nothing provisional to recover),
   * so replay is a recorded no-op.
   */
  toolName: "saveCapsuleAsBinding";
  input: {
    capsuleId: number;
    bindingName: string;
  };
} | {
  /** Create a new gadget workpiece in the workspace, either empty or instantiated from a blueprint. */
  toolName: "createGadget";
  input: {
    /** Human-readable title for the new gadget. Required: the agent always names its creations. */
    title: string;

    /**
     * Name under which the gadget appears in the chat's env and, once merged, the workspace
     * default binding list (see validateBindingName()).
     */
    bindingName: string;

    /**
     * If present, the new gadget starts with the named blueprint's files (copied into the chat's
     * proposed changes) instead of empty.
     */
    blueprintId?: string;
  };

  /**
   * The created gadget's workpiece ID, recorded when the gadget was actually created. History
   * replay reconstructs tool outputs by re-running persisted calls, but a creation tool can't be
   * re-run; replay returns this recorded result without creating anything.
   *
   * `changeId` is the change number of the "changes" batch that records the creation (see
   * `createdGadgets` on the "changes" message body), reported like writeFile/editFile report
   * theirs so reverts can be referred to precisely.
   *
   * `blueprintNotes` is present for blueprint instantiations: formatted text describing the files
   * copied in and the bindings the blueprint expects the agent to wire up. Recorded so replay
   * doesn't have to re-fetch the blueprint (whose content may have changed since).
   */
  output?: {gadgetId: WorkpieceId, changeId?: number, blueprintNotes?: string};
} | {
  toolName: "executeCode";
  input: {
    code: string;
  };

  /** Output, if the code actually ran. (Otherwise, `error` should be present.) */
  output?: string;
} | {
  toolName: "giveUp";
  input: {
    error: string;
  };
} | {
  toolName: "webFetch";
  input: {
    url: string;
    /** If true, return the raw response body without Markdown conversion. */
    raw?: boolean;
  };

  /**
   * Output, if the fetch actually completed. (Otherwise, `error` should be present.) This is
   * stored so that the agent's chat history can be replayed without re-issuing the fetch.
   * Formatted as a YAML-frontmatter header followed by the body (see formatWebFetchResult).
   */
  output?: string;
} | {
  /** This actually shouldn't ever appear in logs unless the agent misunderstands the tool. */
  toolName: "observeUserChanges";
  input: {};
} | {
  /**
   * List the blueprints the workspace owner could instantiate (their own blueprints, their
   * library, and the deployment's featured blueprints), so the agent can pass a blueprintId to
   * createGadget. The formatted text output is recorded so replay doesn't re-list.
   */
  toolName: "listBlueprints";
  input: {};
  output?: string;
} | {
  /**
   * List the resource types a gatekeeper vendor offers, so the agent can construct a resourceUrl
   * for requestConnection. Resource patterns are only surfaced on demand (not in the system prompt).
   */
  toolName: "listConnectableResources";
  input: {
    vendorId: string;
  };
  output?: string;
} | {
  /**
   * Ask the user to connect a gatekeeper, pre-configured as much as the agent can manage. Renders
   * an accept/deny card in the chat; non-blocking (the turn ends, and the agent is resumed if the
   * user accepts; on deny the agent is not resumed).
   */
  toolName: "requestConnection";
  input: {
    vendorId: string;
    resourceUrl?: string;
    reason: string;

    /**
     * Name under which the resource will appear in the chat's env once accepted (see
     * `connectionRequest.bindingName`). Optional only because logs persisted before named chat
     * bindings lack it.
     */
    bindingName?: string;
  };
  output?: string;
});

// TODO: Extend AiToolCall for code-mode tool calls.
// - Includes inline audit logs from the action.
// - Actions can be approved or rejected inline.

/**
 * A standard output format named inline in a chat message, recorded so the message can be redrawn
 * the way it was composed. Display only: the agent reads the noun as ordinary text and resolves it
 * against the deployment's live catalog, so no blueprint id is carried here.
 *
 * Shaped like `CapsuleSpecifier`, but carries no authority: naming a format grants nothing, so
 * there is no workpiece behind it.
 */
export type MessageFormatRef = {
  /**
   * Position and length of the format's name within the message text. Exists so we can render as
   * format with icon in chat UI.
   */
  position: number;
  length: number;

  /** Denormalized so an old message still displays after the format is renamed or un-promoted. */
  noun: string;
  icon: OutputIcon;
};

/**
 * Capsules are resource references that are embedded inline in a chat message. The name comes
 * from the fact that they are represented as a pill-shaped inline element, and that they represent
 * a capability (in the capability-based security sense).
 *
 * When the user is typing a chat message and inserts a link into the message, they will be
 * prompted to turn the link into a capsule. Doing so implicitly creates a gatekeeper and grants
 * the agent permission to use it.
 */
export type CapsuleSpecifier = {
  /**
   * Position and length of the text within the chat message which should be replaced by the
   * capsule. The chat message contains some placeholder text which the capsule replaces. This
   * placeholder text exists mostly for ease of debugging -- it is never actually displayed to
   * the user nor the agent. Typically, the placeholder text should be an integer in square
   * brackets, where the integer is the position of the capsule within the message's capsule
   * list, e.g. `[0]`, `[1]`, etc. However, nothing should actually depend on the placeholder
   * text's content; the CapsuleSpecifier itself is all that matters.
   */
  position: number;
  length: number;

  /**
   * ID of the workpiece, which should have been created using newGatekeeper() or similar.
   *
   * This can reference any workpiece, including gadgets. It should be called `workpieceId`, but
   * when it was introduced it could only point to gatekeepers, and a name change would break
   * existing storage.
   */
  gatekeeperId: WorkpieceId;

  /**
   * Denormalized resource description from calling GatekeeperClient.describe() at the time of
   * insertion. We store this in the chat message to avoid the need to start up the gatekeeper
   * to ask for it again every time the message is displayed.
   */
  description: ResourceDescription;

  /**
   * Vendor whose gatekeeper the resource came from, denormalized at insertion like `description`
   * and trusted no more than it is, so the message can show the vendor's logo without starting the
   * gatekeeper. Display metadata only, never authority.
   */
  vendorId?: string;

  /**
   * The name under which the pasted resource appears in the chat's env (`env.NAME` in
   * executeCode). Stamped onto the persisted message at the turn-start naming chokepoint; absent
   * until then. Messages from before named chat bindings existed are stamped lazily the same
   * way. If the same workpiece already has a name in the chat's scope, that name is reused
   * rather than minting a new one.
   */
  bindingName?: string;
};

/** Identifies a Gatekeeper slash command or the built-in `/compact` command. */
export type SlashCommandId = {
  gatekeeperId: WorkpieceId;
  commandId: string;
  builtin?: never;
} | {
  builtin: true;
  commandId: "compact";
};

/** A slash command invocation parsed by the client. */
export type SlashCommandRequest = {
  id: SlashCommandId;

  /**
   * Unparsed natural-language arguments surrounding the command, with the command itself removed.
   * The provider may consume or transform these into an agent-visible message.
   */
  args: string;

  /**
   * Index in `args` where the user typed the command, so a transcript can show it where they put it
   * rather than implying it led the line. Display only.
   */
  commandPosition?: number;
};

/** One slash command as shown in the Workshop picker. */
export type SlashCommandChoice = {
  /** Selection to pass back when invoking this command. */
  selection: SlashCommandId;

  /** Name shown after `/`. */
  name: string;

  /** Short description shown in the picker. */
  description: string;

  /**
   * Name of the command's provider: the offering Gatekeeper's title, or the Workshop itself for a
   * built-in command.
   */
  providerLabel: string;

  /** Optional resource label used when multiple commands share a name. */
  resourceLabel?: string;

};

/**
 * One provisional streaming event emitted while an agent step is still in progress.
 *
 * At most one provisional stream is active per chat at a time. The client should not persist
 * these events. Instead, it should display them temporarily and discard them as soon as the
 * corresponding durable `message()` and/or `changes` message arrives, or when the agent stops
 * running (`activeAgent` becomes unset in the chat metadata).
 */
export type AiChatStreamEvent = {
  /** The turn is summarizing older context before it can continue, or before `/compact` ends. */
  type: "compacting";
} | {
  /**
   * The compaction attempt ended, whether it compacted, failed, was cancelled, or found nothing to
   * do.
   */
  type: "compacted";

  /**
   * Set when the attempt made no checkpoint because nothing precedes the newest message to
   * summarize. Only `/compact` reports this, since an explicit command is otherwise silent.
   */
  nothingToCompact?: boolean;
} | {
  type: "textDelta";
  delta: string;
} | {
  type: "reasoningDelta";
  delta: string;
} | {
  type: "toolCallStarted";
  toolCallId: string;
  toolName: AiToolCall["toolName"];
} | {
  /**
   * For the executeCode tool specifically, we stream the code as the AI writes it. (For all other
   * tool calls, the tool inputs are not streamed -- though writeFile and editFile separately
   * stream codeUpdate messages.)
   */
  type: "toolCodeDelta";
  toolCallId: string;
  delta: string;
} | {
  /**
   * This is a provisional UI lifecycle event. For most tools it means the full tool call input has
   * been received, so the tool is no longer visually "in progress". executeCode does not emit this
   * during streaming; its provisional card is cleared when the final durable message arrives.
   */
  type: "toolCallFinished";
  toolCallId: string;
} | {
  /**
   * Indicates which file the agent is currently editing, if any. This is emitted while a
   * writeFile/editFile call is streaming, and set to null when a non-edit tool becomes active.
   */
  type: "setActiveFile";
  file: { workpieceId: WorkpieceId, filename: string } | null;
} | {
  /** Streaming write/edit target file, used by the UI before the finalized tool call arrives. */
  type: "toolCallTarget";
  toolCallId: string;
  file: { workpieceId: WorkpieceId, filename: string };
} | {
  /**
   * Streaming createGadget output format, used by the UI before the finalized tool call arrives.
   * Has the deployment's overrides applied, so it matches what the gadget is stamped with.
   */
  type: "toolCallOutputFormat";
  toolCallId: string;
  output: BlueprintOutput;
} | {
  type: "toolOutputDelta";
  toolCallId: string;
  delta: string;
} | {
  type: "codeReset";
} | {
  type: "codeUpdate";
  update: Uint8Array;
};

/** Interface implemented by the client to receive action-log upserts. */
export interface ActionsSubscriber {
  entry(record: ActionLogEntry): void;
  ready(): void;
}

/**
 * Interface implemented by the client to receive callback notifications whenever there is new
 * chat activity. Use Overseer.subscribeToChat() to register a subscriber.
 */
export interface AiChatSubscriber {
  /**
   * Sent exactly once, at the start of a subscription, before any other callbacks. Carries an
   * opaque value identifying the current server (Overseer DO) instance. If a resubscribing client
   * sees a different value than on its previous subscription, the DO has fully restarted since
   * then, meaning any in-flight provisional stream content was lost and will be re-streamed from
   * scratch; the client should discard its provisional streaming state. An unchanged value (a
   * plain network reconnect to the same live instance) means provisional state should be kept.
   */
  streamGeneration(generation: number): void;

  /** Metadata for the given chat thread has changed, or a new chat thread was created. */
  metadata(chat: AiChatMetadata): void;

  /** Indicates the chat thread was deleted. */
  deleted(chatId: number): void;

  /** Adds a message to the chat. */
  message(msg: AiChatMessage): void;

  /**
   * Delivers one persisted live-draft update for a chat branch. Subscriptions replay all currently
   * stored draft updates for a chat so newly-joined clients can reconstruct the editable branch
   * state without a separate fetch.
   */
  draftUpdate(chatId: number, timestamp: Date, author: AiChatAuthorInfo, update: Uint8Array): void;

  /** Indicates that all persisted live-draft updates for the given chat were cleared. */
  draftCleared(chatId: number): void;

  /** Delivers one provisional streaming event. Clients may ignore event types they don't support. */
  stream(chatId: number, event: AiChatStreamEvent): void;
}

/**
 * Interface implemented by the client to receive callback notifications about console logs written
 * by the gadget.
 */
export interface ConsoleLogSubscriber {
  /**
   * Deliver a batch of logs. Often just one log is delivered at a time, but for efficiency they
   * may be batched.
   *
   * If `chatId` is non-null, then the logs were generated while running the version of the gadget
   * code including the changes in the given chat. This can be used to associate the logs with
   * an ongoing agent session and report them to that session.
   */
  event(chatId: number | null, logs: ConsoleLogEvent[]): Promise<void>;
}

export type ConsoleLogEvent = {
  timestamp: Date;

  level: "debug" | "info" | "log" | "warn" | "error";

  /**
   * The parameters that were passed to the log function, represented as an array of serializable
   * values.
   */
  message: any[];
}

/**
 * Summary of one workpiece, delivered via Overseer.subscribeToWorkpieces(). In v1 only
 * gadget-type workpieces are published (gatekeeper workpieces -- chat capsules, ambient
 * singletons, connections -- are not listed); `type` discriminates for future workpiece types.
 */
export type WorkpieceSummary = {
  id: WorkpieceId;
  type: "gadget";

  /** Display title. (For a gadget, its user-renamable title.) */
  title: string;

  /**
   * The format this workpiece was built as, inherited from the blueprint it was instantiated
   * from. Absent means a generic app. The UI names and draws the workpiece from this.
   */
  output?: BlueprintOutput;

  /**
   * The name of the Y.Doc root map that holds this workpiece's files, if it owns files (see
   * Overseer.subscribeToCode). For most gadgets this is the decimal workpiece ID; the gadget
   * migrated from before multi-gadget support keeps the legacy unnamed root "".
   */
  filesRoot?: string;

  /**
   * If present, this workpiece exists only in the context of the given chat. The UI should display
   * it only while the given chat is open.
   *
   * For gadgets, this means the gadget is still provisional: it becomes permanent when the user
   * accepts the chat's changes through its creation message, and is deleted if those changes are
   * reverted (or the chat is deleted).
   */
  chatId?: number;
};

/** Callback interface used to receive workpiece-list updates. See Overseer.subscribeToWorkpieces(). */
export interface WorkpiecesSubscriber {
  /**
   * Upsert: called once per existing workpiece when the subscription starts, then again whenever
   * a workpiece is created or its summary changes (e.g. it is renamed).
   */
  entry(summary: WorkpieceSummary): void;

  /** The workpiece was deleted. */
  removed(id: WorkpieceId): void;

  /** Called after entry() has been called for all workpieces known so far. */
  ready(): void;
}

/**
 * Information about one of a gadget's bindings, for display in the Connections tab. Returned by
 * GadgetClient.listBindings().
 */
export type GadgetBindingInfo = {
  /** The binding name, as it appears in the gadget worker's `env`. */
  name: string;

  /** The workpiece that the binding points at. */
  target: WorkpieceId;

  /** Denormalized display info about the target. */
  resourceTitle: string;
  vendorId?: string;

  /** Deployment Model status for model-backed bindings. Absent for other binding kinds. */
  model?: {
    /** Whether the binding provides a model directly or through an Agent Spawner. */
    type: "aiModel" | "agentSpawner";
    /** Stable Deployment Model reference, or null for an Agent Spawner that runs no model. */
    modelId: string | null;
    /** False when the referenced Deployment Model has been revoked. */
    available: boolean;
  };

  /**
   * If present, this binding is still provisional to the given chat (which is necessarily the
   * `chatId` passed to listBindings(); edges pending in other chats are never listed). It becomes
   * permanent when the user accepts that chat's changes through the message that recorded it, and
   * is deleted if those changes are reverted.
   */
  chatId?: number;
};

/**
 * An auto-approvable action kind offered by a specific connection. Aggregated from each bound
 * gatekeeper's getAutoApprovableActions(); `alreadyEnabled` reports whether a matching rule exists.
 */
export type PreApprovableAction = {
  gatekeeperId: WorkpieceId;
  resourceTitle: string;
  actionKind: ActionKind;
  alreadyEnabled: boolean;

  /** Vendor of the gatekeeper holding this connection. Absent for vendorless gatekeepers. */
  vendorId?: string;
};

// =======================================================================================
// Blueprint types
// =======================================================================================

/**
 * Describes how a gatekeeper was originally created. Stored on each GatekeeperRecord so that
 * bindings can be recreated and blueprint metadata can be derived.
 */
export type GatekeeperCreationSpec = {
  type: "gatekeeper";
  vendorId: string;        // identifies the gatekeeper adapter (e.g. "google")
  resourceUrl: string;
  typeUrlPattern: string;  // URL pattern from the vendor's SupportedResource (not the specific URL)
} | {
  type: "aiModel";
  /** Stable public Deployment Model reference. */
  modelId: string;
} | {
  type: "agentSpawner";
  config: AgentSpawnerConfig;
} | {
  /**
   * A singleton gatekeeper account (e.g. the Context Library) auto-provided to every gadget as an
   * unnamed capsule so the agent can read/search it in code. Not user-configured, so excluded from
   * blueprints; re-added automatically if missing.
   */
  type: "ambient";
  vendorId: string;        // the singleton gatekeeper's id (GATEKEEPER_<ID> suffix, lowercased)
  accountId: number;       // the owner's connected-account id for this singleton (in their user DO)
};

/**
 * User-provided metadata controlling how a gatekeeper binding should appear in blueprints.
 * Stored on the binding edge (a gadget's binding-name -> gatekeeper mapping), not on the
 * gatekeeper itself: two gadgets binding the same gatekeeper can annotate it differently for
 * their respective blueprints. Optional: when absent, the binding is included in the blueprint
 * with a generated title, empty description, and no resource suggestion.
 *
 * Legacy field `included` may still be present on records written by older versions of
 * the workshop. The backend still honors `included: false`, but new writes omit it.
 */
export type BlueprintBindingAnnotation = {
  title: string;           // friendly name shown to people using the blueprint
  description: string;     // explains what resource to connect (may be empty)
  suggestValue?: boolean;  // include the specific URL/model as a suggestion
};

/**
 * Symbolic target of one agent-spawner env entry in a blueprint. Workpiece IDs are
 * workspace-local, so a spawner's `env` (see AgentSpawnerConfig.env) can't transfer into a
 * blueprint as-is; instead each entry references either one of the blueprint's own bindings by
 * name -- the user fills it at instantiation time like any other binding, and the spawner env
 * entry resolves to the gatekeeper created for it -- or the blueprint's gadget itself, resolving
 * to the newly instantiated gadget.
 */
export type SpawnerEnvTarget = {
  type: "binding";

  /**
   * Key into BlueprintMetadata.bindings. May reference a binding that is also bound into the
   * gadget, or one synthesized purely to feed this spawner (see BlueprintBinding.spawnerOnly).
   */
  name: string;
} | {
  /**
   * This spawner binding refers back to the gadget itself (the one instantiated from the
   * blueprint).
   */
  type: "gadget";
};

/**
 * Describes one binding required by a blueprint. Stored in BlueprintMetadata.bindings as a
 * Record keyed by binding name. Consumers identify bindings by their key (the binding name)
 * while `title` and `description` provide user-facing text.
 */
export type BlueprintBinding = {
  title: string;        // friendly name shown to people using the blueprint
  description: string;  // explains what resource to connect here (may be empty)

  /**
   * If true, this binding exists only to satisfy an agent spawner's env (it is referenced by
   * some spawner's `env` entry as a SpawnerEnvTarget). The user fills it at instantiation time
   * like any other binding, but the created gatekeeper is fed only to the spawner(s) referencing
   * it -- it is not bound into the gadget itself.
   */
  spawnerOnly?: true;
} & ({
  /** A regular external-resource gatekeeper binding. */
  type: "gatekeeper";

  /**
   * Identifies the gatekeeper adapter (currently mapped to the workshop's
   * GATEKEEPER_<name> service binding).
   */
  gatekeeperName: string;

  /** URL pattern describing the type of resource this binding accepts. */
  typeUrlPattern: string;

  /** The specific resource URL from the source gadget (suggestion only). */
  resourceUrl?: string;
} | {
  /**
   * An AI model binding. The user instantiating the blueprint picks an available Deployment Model.
   */
  type: "aiModel";

  /**
   * The blueprint creator may suggest a particular model to use, or omit this to leave
   * it up to the recipient.
   */
  suggestedModel?: {provider: string, modelName: string};
} | {
  /** An agent spawner binding. */
  type: "agentSpawner";

  /**
   * The blueprint creator may suggest a particular model to use, or omit this. (The
   * value is `null` if the suggestion is that AgentSpawnerConfig.modelId should be
   * configured as `null`. This is different from `undefined`, which means no suggestion.)
   */
  suggestedModel?: {provider: string, modelName: string} | null;

  /**
   * Symbolic form of AgentSpawnerConfig.env: env name -> target, resolved to concrete workpiece
   * IDs at instantiation time (see SpawnerEnvTarget).
   */
  env: Record<string, SpawnerEnvTarget>;
});

export type BlueprintScreenshotUpload = {
  mimeType: "image/jpeg" | "image/png";
  content: Uint8Array;
};

export const BLUEPRINT_SCREENSHOT_R2_PREFIX = 'screenshots/';
export const BLUEPRINT_SCREENSHOT_PATH_PREFIX = '/blueprint-screenshot/';

export function blueprintScreenshotUrl(id: string, metadata: { screenshot?: true, lastUpdated: Date }): string | undefined {
  return metadata.screenshot ?
      `${BLUEPRINT_SCREENSHOT_PATH_PREFIX}${id}?v=${metadata.lastUpdated.valueOf()}` : undefined;
}

/**
 * General metadata about a blueprint. Stored (in slightly different wrapper records) in
 * three locations: Gadget DO, User DO, and KV.
 */
export type BlueprintMetadata = {
  title: string;
  description: string;  // longer-form description of what the blueprint does
  author: AiChatAuthorInfo;
  created: Date;

  version: number;       // increments every time the blueprint is updated
  lastUpdated: Date;

  /**
   * If present, a screenshot is stored separately from the metadata. The server uses this
   * to decide when to include a derived screenshotUrl.
   */
  screenshot?: true;

  /**
   * What instantiating this blueprint produces. Absent means a generic app. Inherited by gadgets
   * created from this blueprint, and preserved when such a gadget is republished as a blueprint.
   */
  output?: BlueprintOutput;

  /** Key = binding name. */
  bindings: Record<string, BlueprintBinding>;
};

/** Public view (returned by PublicApi.getBlueprint). */
export type BlueprintPublicInfo = {
  id: string;
  metadata: BlueprintMetadata;

  /** If present, browser-loadable URL for the public screenshot. */
  screenshotUrl?: string;
};

/** Gadget-side summary (returned by Overseer.listBlueprints). */
export type BlueprintGadgetSummary = {
  id: string;
  title: string;
  description: string;
  version: number;
  codeVersionDate: Date;  // timestamp of the exported code version
  screenshotUrl?: string;
  dirty?: boolean;        // true if last publish failed and needs retry
};

/**
 * Where a blueprint the user owns came from. This distinguishes the case the UI cares about — the
 * source workspace still exists, so it can be opened and it owns deletion of the blueprint — from
 * the two cases where it does not, so no caller has to infer that from display text. `workspaceId`
 * is reachable only in the case where opening it is meaningful.
 */
export type BlueprintSource =
    // Published from a workspace that still exists. `workspaceTitle` is its current title.
    { type: "workspace"; workspaceId: string; workspaceTitle: string }
    // Published from a workspace that has since been deleted.
  | { type: "deletedWorkspace" }
    // Added to the user's library rather than published from one of their workspaces.
  | { type: "imported" };

/** User-side summary (returned by AuthenticatedApi.listOwnBlueprints and getOwnBlueprint). */
export type BlueprintUserSummary = {
  id: string;
  title: string;
  description: string;
  /** Where this blueprint came from, and whether that origin is still openable. */
  source: BlueprintSource;
  version: number;
  lastUpdated: Date;
  pinned?: boolean;
};

/** User-side library summary (returned by AuthenticatedApi.listLibraryBlueprints). */
export type BlueprintLibrarySummary = {
  id: string;
  metadata: BlueprintMetadata;
  addedAt: Date;
  uploaded: boolean;
  pinned?: boolean;
};

/**
 * Binding assignment (input to newGadgetFromBlueprint).
 * When instantiating a blueprint, the user provides a Record mapping binding name ->
 * assignment. Every required binding in the blueprint must have a corresponding entry.
 */
export type BlueprintBindingAssignment = {
  type: "gatekeeper";
  accountId: number;      // user's connected account ID
  resourceUrl: string;
} | {
  type: "aiModel";
  /** Available Deployment Model selected for the new gadget. */
  modelId: string;
} | {
  type: "agentSpawner";
  modelId: string | null; // model to run, or null for no agent
};

/**
 * Common base interface for per-workpiece capabilities. Each workpiece type has its own
 * subinterface (GadgetClient, GatekeeperClient<T>) for type-specific operations; this base holds
 * the shared identity/lifecycle surface.
 */
export interface WorkpieceClient extends RpcTarget {
  /** Get the workpiece's ID, unique among all workpieces in the workspace (of any type). */
  getId(): Promise<WorkpieceId>;

  /**
   * Human-readable title, for display. For a gadget this is its user-renamable title; for a
   * gatekeeper it is the connected resource's title.
   */
  getTitle(): Promise<string>;

  /**
   * Change the workpiece's title.
   *
   * (Note gatekeeper titles are initially based on the title of the underlying resource, but this
   * method does not change the remote resource, only the display name used locally within this
   * workspace.)
   */
  setTitle(title: string): Promise<void>;

  /**
   * Permanently remove this workpiece from the workspace.
   *
   * For a gadget, this deletes its registry entry (including its binding map) and hooks and
   * clears its files; gatekeepers it bound survive, possibly no longer bound by any gadget. For
   * a gatekeeper, this destroys the connection itself -- distinct from merely unbinding it from
   * one gadget (GadgetClient.unbind()).
   */
  remove(): Promise<void>;
}

/**
 * Capability representing one gadget workpiece within a workspace. Obtained from
 * Overseer.createGadget() or Overseer.getGadget(). Workspace-level concerns (code sync, chats,
 * sharing, actions, blueprint listing) stay on Overseer; this covers the per-gadget surface.
 */
export interface GadgetClient extends WorkpieceClient {
  /**
   * Get the gadget's deployed UI code, to be run inside an iframe sandbox.
   *
   * Returns null if the gadget has no deployed UI code (e.g. if it's new, or if it's just an AI
   * agent with no code).
   */
  getUiBundle(chatId?: number): Promise<UiBundle | null>;

  // Open an RPC interface to the gadget's server-side Durable Object facet. The frontend may pass
  // this stub into the gadget's iframe sandbox, so that the gadget UI can communicate with its
  // server side. It can also permit the coding agent to make direct calls.
  //
  // If `chatId` is specified, then the gadget will include changes currently proposed in the given
  // chat.
  //
  // @ts-ignore - TODO: Fix type instantiation issue
  connectToGadget(chatId?: number): Promise<RpcStub<any>>;

  /**
   * Renders the Gadget's UI as a PDF. If `chatId` is specified, the PDF includes changes currently
   * proposed in that chat.
   */
  exportPdf(chatId?: number): Promise<ReadableStream<Uint8Array>>;

  /**
   * Exports the Gadget's visible print content as an editable Word document. If `chatId` is
   * specified, the document includes changes currently proposed in that chat.
   */
  exportDocx(chatId?: number): Promise<ReadableStream<Uint8Array>>;

  // --- Binding management ---
  //
  // A gadget's bindings are edges mapping a name (as it appears in the gadget worker's `env`) to
  // a target workpiece -- today always a gatekeeper. The same gatekeeper may be bound multiple
  // times in one gadget or by several gadgets, under independent names.

  /**
   * List this gadget's bindings.
   *
   * If `chatId` is specified, bindings which have been proposed but not yet accepted in the given
   * chat thread will be included.
   */
  listBindings(chatId?: number): Promise<GadgetBindingInfo[]>;

  /** Get the gatekeeper bound under the given name, or null if there is no such binding. */
  getBinding(name: string): Promise<GatekeeperClient<any> | null>;

  /**
   * Bind the given workpiece (a gatekeeper) into this gadget's `env` under `name`. Throws if the
   * name is invalid (see validateBindingName()), reserved, or already bound in this gadget
   * (including bound provisionally by another chat).
   *
   * If `chatId` is provided, the binding is treated like an edit made in the given chat -- it is
   * proposed, but someone needs to click "accept changes" (call `mergeChanges()`) to make it
   * final. Until then it exists only in the given chat.
   */
  bind(name: string, target: WorkpieceId, chatId?: number): Promise<void>;

  /**
   * Like bind(), but if the target isn't already bound in this gadget, choose a name based on the
   * resource's own suggestion (deduplicated against this gadget's existing binding names). If the
   * target is already bound, does nothing. Either way, returns the target's binding name.
   */
  bindWithSuggestedName(target: WorkpieceId, chatId?: number): Promise<string>;

  /**
   * Remove the binding with the given name. This only removes the edge from this gadget -- the
   * target gatekeeper itself survives (possibly no longer bound by any gadget); use
   * GatekeeperClient.remove() to destroy the connection itself.
   */
  unbind(name: string): Promise<void>;

  /**
   * Rename a binding while preserving its target and blueprint annotation. Throws if `oldName`
   * does not exist or `newName` is reserved or already bound in this gadget.
   */
  renameBinding(oldName: string, newName: string): Promise<void>;

  /**
   * Replace the revoked Deployment Model used by one model-backed binding. The binding name and
   * target workpiece stay unchanged. Only the workspace owner may call this method.
   */
  replaceUnavailableModelBinding(name: string, modelId: string): Promise<void>;

  /**
   * Get the blueprint annotation for the named binding, if one has been set. Annotations live on
   * the binding edge, not on the target gatekeeper (see BlueprintBindingAnnotation).
   */
  getBlueprintAnnotation(name: string): Promise<BlueprintBindingAnnotation | null>;

  /** Set the blueprint annotation for the named binding. */
  setBlueprintAnnotation(name: string, annotation: BlueprintBindingAnnotation): Promise<void>;

  /**
   * Create a new blueprint from this gadget's current committed code.
   * `title` defaults to the gadget's title if omitted.
   *
   * The blueprint is always owned by the workspace owner, regardless of who calls this method.
   *
   * Steps: generate ID, snapshot code, collect binding metadata, store locally, propagate
   * to User DO + KV + R2. Maintenance of existing blueprints stays on Overseer (see
   * Overseer.updateBlueprint() etc.).
   */
  createBlueprint(title?: string, description?: string, screenshot?: BlueprintScreenshotUpload): Promise<BlueprintGadgetSummary>;
}

/**
 * Capability representing one gatekeeper (connection) workpiece. Note that binding-edge
 * operations -- binding names and blueprint annotations -- live on GadgetClient, since a
 * gatekeeper may be bound by several gadgets under different names.
 */
export interface GatekeeperClient<Session extends RpcCompatible<Session>> extends WorkpieceClient {
  /** Get the resource description, including the schema of its RPC interface. */
  describe(): Promise<ResourceDescription>;

  /**
   * Open a direct session to this gatekeeper. Particularly useful when using the AI agent to talk
   * to the resource directly.
   */
  openSession(): Promise<RpcStub<Session>>;

  /** Get the creation spec describing how this gatekeeper was originally created. */
  getCreationSpec(): Promise<GatekeeperCreationSpec>;

  // TODO: Get/set permissions.
}

/**
 * The level of access a collaborator (or share key) grants.
 *
 * - "build": full access -- edit code, use and participate in chats, manage bindings, etc. (the
 *   same access the owner has, modulo the owner-only exceptions documented in sharing.md).
 * - "use": may only render, interact with, and export the gadget's deployed UI (getUiBundle(),
 *   connectToGadget(), exportPdf(), and exportDocx()), plus read basic metadata.
 *
 * Roles are ordered build > use. A collaborator's effective role is the maximum role reachable
 * from the owner through their valid permission edges, where each edge grants
 * min(edge role, sharer's effective role). The owner is the implicit root at "build".
 */
export type CollaboratorRole = "build" | "use";

/** One person currently connected to a gadget. */
export type PresenceParticipant = {
  /** Opaque key matching this participant across add/remove events. */
  key: string;
  user: AiChatAuthorInfo;
  role: CollaboratorRole;
};

/**
 * `init` delivers the full roster once on subscribe.
 * `add`/`remove` (keyed by `key`) report changes thereafter.
 */
export interface PresenceSubscriber {
  init(participants: PresenceParticipant[]): void;
  add(participant: PresenceParticipant): void;
  remove(key: string): void;
}

/** Describes how one user came to have collaborator access. */
export type PermissionEdge = {
  created: Date;

  /**
   * The role granted by this edge. Absent on edges created before roles were introduced; such
   * edges are treated as "build" for backwards compatibility.
   */
  role?: CollaboratorRole;
} & ({
  /** Granted directly by another user. */
  type: "user";
  sharer: string;  // profile.id of the person who shared
  note?: string;
} | {
  /** Gained by redeeming a share key. */
  type: "shareKey";

  /**
   * The id of the share link that was redeemed (the hash of its first key). Every key of the link
   * resolves to this id, so redeeming any of them yields this one edge.
   */
  keyId: string;
});

/** Information about a single collaborator, returned by list/add operations. */
export type CollaboratorInfo = {
  profile: AiChatAuthorInfo;
  addedBy: PermissionEdge[];

  /**
   * The collaborator's effective role (the maximum role reachable from the owner). Absent implies
   * "build" for backwards compatibility.
   */
  role?: CollaboratorRole;
};

/**
 * Describes a collaborator whose access would change (or did change) as a result of a removal or
 * share key revocation. Used by the preview/confirm flow, which must surface not only users who
 * lose access entirely but also users who would be downgraded to a lower role.
 */
export type AffectedCollaborator = {
  profile: AiChatAuthorInfo;
  addedBy: PermissionEdge[];

  /** The effective role before the change. */
  oldRole: CollaboratorRole;

  /** The effective role after the change, or null if the user loses access entirely. */
  newRole: CollaboratorRole | null;
};

/**
 * Information about a share link, for the management UI. Each link may have one or more keys.
 * When users "copy" an existing link, they are getting a new key.
 */
export type ShareLinkInfo = {
  linkId: string;
  note?: string;
  created: Date;
  createdBy: AiChatAuthorInfo;

  /**
   * The role granted to anyone who redeems this link. Absent implies "build" for links created
   * before roles were introduced.
   */
  role?: CollaboratorRole;
};
