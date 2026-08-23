import { MAX_DOCUMENT_BODY_BYTES } from "./context-types.js";

const MAX_DOCUMENT_PATH_LENGTH = 1024;

/** Validate one caller-supplied Context document path before storage or billing dispatch. */
export function validateContextDocumentPath(path: string): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("Document path is required.");
  }
  if (path.length > MAX_DOCUMENT_PATH_LENGTH) {
    throw new Error(`Document path is too long (max ${MAX_DOCUMENT_PATH_LENGTH} characters).`);
  }
  if (path.startsWith("/")) {
    throw new Error("Document path must be relative (no leading '/').");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error("Document path must not contain control characters.");
  }
  for (let segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error("Document path must not contain empty, '.', or '..' segments.");
    }
  }
}

/** Validate one caller-supplied Context document write before storage or billing dispatch. */
export function validateContextDocumentWrite(path: string, body: string): void {
  validateContextDocumentPath(path);
  const byteLength = new TextEncoder().encode(body).length;
  if (byteLength > MAX_DOCUMENT_BODY_BYTES) {
    throw new Error(
      `Document is too large (${byteLength} bytes; max ${MAX_DOCUMENT_BODY_BYTES}).`,
    );
  }
}
