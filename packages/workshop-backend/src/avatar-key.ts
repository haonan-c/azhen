const MAX_AVATAR_KEY_BYTES = 512;

/** Return whether a User identity is a valid Cloudflare KV key for AVATAR storage. */
export function isAvatarStorageKey(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value !== "." && value !== ".." &&
    new TextEncoder().encode(value).byteLength <= MAX_AVATAR_KEY_BYTES;
}
