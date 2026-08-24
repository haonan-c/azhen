import { createObservabilityContext } from "@gadgets/backend-utils/observability-context";

/** Observability fields emitted by the Context gatekeeper. */
export type ContextObservabilityFields = {
  bodyBytes: number;
  collectionId: string;
  maxBodyBytes: number;
  maxGitDirBytes: number;
  operation: string;
  sizeBytes: number;
  vendorId: string;
};

/** Create a privacy-safe error for logs without copying caught error details. */
export function privacySafeError(caught: unknown, operation: string): Error {
  const kind = caught instanceof Error ? "error" : "non-error";
  return new Error(`${operation} failed (${kind}).`);
}

/** Ambient observability fields for one Context gatekeeper operation. */
export const obsContext = createObservabilityContext<ContextObservabilityFields>();
