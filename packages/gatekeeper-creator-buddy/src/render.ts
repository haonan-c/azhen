// Renders a self-contained HTML string to a PNG image via Cloudflare Browser Rendering. Used by
// CreatorBuddySession.renderImage() in place of the vendored skills' local ffmpeg/image-gen
// scripts, which don't exist in this runtime -- see e.g. vendor/space-video-cover/SKILL.md and
// vendor/space-text-logic-diagram/SKILL.md. Much simpler than workshop-backend's Gadget PDF export
// (packages/workshop-backend/src/browser-export.ts): there is no live RPC bridge to a running
// Gadget UI here, just a static HTML string in and image bytes out.

import { launch } from "@cloudflare/puppeteer";

/** Wall-clock budget covering launch, rendering, and screenshot capture. */
const MAX_RENDER_DURATION_MS = 20_000;
/** Refuse to render implausibly large input HTML (the vendored templates are a few KB). */
const MAX_HTML_BYTES = 1024 * 1024;
const DEFAULT_WIDTH = 1080;
const DEFAULT_HEIGHT = 1440;
const MAX_DIMENSION = 4096;

function clampDimension(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) return fallback;
  return Math.min(Math.floor(value), MAX_DIMENSION);
}

function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  let timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Renders `html` (a complete, self-contained document -- inline styles/fonts, no external
 * resources) to a PNG and returns it as a `data:` URI. Blocks all network requests the page makes
 * except `data:`/`blob:` (the vendored templates never need more than that); anything else aborts.
 */
export async function renderImage(
    browserBinding: BrowserRun, html: string,
    opts: { width?: number; height?: number } = {}): Promise<{ dataUri: string }> {
  if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) {
    throw new Error(`renderImage HTML exceeds the ${MAX_HTML_BYTES}-byte limit.`);
  }
  let width = clampDimension(opts.width, DEFAULT_WIDTH);
  let height = clampDimension(opts.height, DEFAULT_HEIGHT);

  let browser = await withDeadline(
      launch(browserBinding), MAX_RENDER_DURATION_MS, "Browser launch timed out.");
  try {
    return await withDeadline((async () => {
      let page = await browser.newPage();
      await page.setViewport({ width, height });
      await page.setRequestInterception(true);
      page.on("request", request => {
        let url = request.url();
        if (url.startsWith("data:") || url.startsWith("blob:") || url === "about:blank") {
          void request.continue();
        } else {
          void request.abort();
        }
      });
      await page.setContent(html, { waitUntil: "networkidle0" });
      let base64 = await page.screenshot({
        type: "png", encoding: "base64", clip: { x: 0, y: 0, width, height },
      });
      return { dataUri: `data:image/png;base64,${base64}` };
    })(), MAX_RENDER_DURATION_MS, "Rendering timed out.");
  } finally {
    await browser.close().catch(() => {});
  }
}
