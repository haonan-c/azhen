// Intercepts the Workers' outbound fetch() so the tests never touch a real server.
//
// createTestHarness routes a Worker's outbound fetch() back through the Node process, so patching
// globalThis.fetch is enough -- no interception library needed. Requests to the harness itself
// (localhost) pass through; anything else that isn't matched by a handler throws, so an unmocked
// call fails the test instead of silently reaching the internet.
//
// This file is mechanism only. What a given vendor's endpoints return lives in a handler module, so a
// suite for another gatekeeper is a new handler module rather than a fork of this one.

/**
 * Answers one request, or returns null to decline it and let the next handler try.
 *
 * Handlers may be async. That is load-bearing rather than a convenience: a handler sometimes has to
 * wait for the test to say what to answer with, because the thing that identifies the request only
 * comes into existence once the Worker has started making it.
 */
export type Handler =
    (url: URL, method: string, headers: Headers, request: Request) =>
      Response | null | Promise<Response | null>;

const MAX_INSPECTED_BODY_BYTES = 1024 * 1024;

async function readBoundedBody(request: Request): Promise<Uint8Array | undefined> {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_INSPECTED_BODY_BYTES) {
        await reader.cancel();
        throw new Error(
          `Outbound request body exceeds the ${MAX_INSPECTED_BODY_BYTES} byte inspection limit`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function inspectedRequest(request: Request, body: Uint8Array | undefined): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    redirect: request.redirect,
    signal: request.signal,
  });
}

export class NetworkInterceptor {
  readonly #handlers: readonly Handler[];
  #realFetch: typeof globalThis.fetch | null = null;
  #unmockedCalls: string[] = [];

  constructor(handlers: Handler[] = []) {
    this.#handlers = [...handlers];
  }

  install(): void {
    if (this.#realFetch) return;
    const realFetch = this.#realFetch = globalThis.fetch;

    type FetchInput = Parameters<typeof globalThis.fetch>[0];
    type FetchInit = Parameters<typeof globalThis.fetch>[1];

    globalThis.fetch = (async (input: FetchInput, init?: FetchInit) => {
      const raw = typeof input === "string" ? input
        : input instanceof URL ? input.toString()
        : input.url;
      const url = new URL(raw);

      // The harness dispatches its own traffic over loopback; let that through untouched.
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") {
        return realFetch(input, init);
      }

      // Let Request work out how input and init combine into a method and headers. Constructing one
      // can transfer the body's stream, so it has to happen after the loopback return above -- past
      // this point `input` is never forwarded anywhere, so disturbing it costs nothing. The
      // toUpperCase() stays: Request normalises only the methods the fetch spec lists, so `patch`
      // would otherwise reach handlers lowercased.
      const request = new Request(input, init);
      const { method: rawMethod, headers } = request;
      const method = rawMethod.toUpperCase();
      let body: Uint8Array | undefined;
      try {
        body = await readBoundedBody(request);
      } catch (error) {
        this.#unmockedCalls.push(
          `${method} ${raw} (body exceeds ${MAX_INSPECTED_BODY_BYTES} bytes)`,
        );
        throw error;
      }

      for (const handler of this.#handlers) {
        // Rebuild the request from bounded bytes so one declining handler can inspect the body
        // without consuming it for the next handler. The original request is never sent onward.
        const response = await handler(url, method, headers, inspectedRequest(request, body));
        if (response) return response;
      }

      this.#unmockedCalls.push(`${method} ${raw}`);
      throw new Error(`Unmocked outbound request: ${method} ${raw}`);
    }) as typeof globalThis.fetch;
  }

  uninstall(): void {
    if (this.#realFetch) {
      globalThis.fetch = this.#realFetch;
      this.#realFetch = null;
    }
  }

  /** URLs that were neither handled nor local, for asserting nothing escaped. */
  getUnmockedCalls(): string[] {
    return [...this.#unmockedCalls];
  }

  /**
   * Remove and return the recorded unmocked calls containing `substring`.
   *
   * For the one test that provokes an unmocked request deliberately. Taking just its own entry rather
   * than resetting means a concurrently running sibling's escape is still caught.
   */
  takeUnmockedCalls(substring: string): string[] {
    const taken = this.#unmockedCalls.filter(call => call.includes(substring));
    this.#unmockedCalls = this.#unmockedCalls.filter(call => !call.includes(substring));
    return taken;
  }

  reset(): void {
    this.#unmockedCalls = [];
  }
}
