import { launch } from "@cloudflare/puppeteer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderImage } from "../src/render";

vi.mock("@cloudflare/puppeteer", () => ({ launch: vi.fn() }));

type RequestListener = (request: {
  url(): string;
  abort(): Promise<void>;
  continue(): Promise<void>;
}) => void;

describe("renderImage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("disables JavaScript before loading static HTML and still returns a PNG", async () => {
    let operations: string[] = [];
    let requestListener: RequestListener | undefined;
    let page = {
      setViewport: vi.fn(async () => { operations.push("viewport"); }),
      setJavaScriptEnabled: vi.fn(async (enabled: boolean) => {
        operations.push(`javascript:${enabled}`);
      }),
      setRequestInterception: vi.fn(async () => { operations.push("interception"); }),
      on: vi.fn((_event: string, listener: RequestListener) => { requestListener = listener; }),
      setContent: vi.fn(async () => { operations.push("content"); }),
      screenshot: vi.fn(async () => "encoded-png"),
    };
    let browser = {
      newPage: vi.fn(async () => page),
      close: vi.fn(async () => {}),
    };
    vi.mocked(launch).mockResolvedValue(browser as never);

    let result = await renderImage({} as BrowserRun, "<main>safe</main>", {
      width: 800,
      height: 600,
    });

    expect(operations).toEqual([
      "viewport",
      "javascript:false",
      "interception",
      "content",
    ]);
    expect(result).toEqual({ dataUri: "data:image/png;base64,encoded-png" });
    expect(page.screenshot).toHaveBeenCalledWith({
      type: "png",
      encoding: "base64",
      clip: { x: 0, y: 0, width: 800, height: 600 },
    });
    expect(page.setContent).toHaveBeenCalledWith("<main>safe</main>", { waitUntil: "load" });
    expect(browser.close).toHaveBeenCalledOnce();

    let abort = vi.fn(async () => {});
    let continueRequest = vi.fn(async () => {});
    requestListener?.({
      url: () => "https://example.com/tracker.js",
      abort,
      continue: continueRequest,
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(continueRequest).not.toHaveBeenCalled();

    abort.mockClear();
    requestListener?.({
      url: () => "data:image/png;base64,AA==",
      abort,
      continue: continueRequest,
    });
    expect(abort).not.toHaveBeenCalled();
    expect(continueRequest).toHaveBeenCalledOnce();
  });
});
