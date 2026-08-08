import { env } from "cloudflare:workers";
import { RpcTarget, type RpcStub } from "capnweb";
import { extractText } from "unpdf";
import { describe, expect, it } from "vitest";
import { renderGadgetPdf } from "../src/browser-export";

class EmptyGadget extends RpcTarget {
  [Symbol.dispose](): void {}
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  let response = new Response(stream);
  return new Uint8Array(await response.arrayBuffer());
}

describe("Gadget PDF fonts", () => {
  it("retains Chinese text when the Gadget uses BlinkMacSystemFont", async () => {
    let browser = env.BROWSER;
    if (!browser) throw new Error("Browser Run is not configured for this test.");

    let html = "<style>body { font-family: BlinkMacSystemFont; }</style><p>中文A</p>";
    let clientCode = `document.body.innerHTML = ${JSON.stringify(html)};`;
    let gadget = new EmptyGadget() as unknown as RpcStub<EmptyGadget>;
    let stream = await renderGadgetPdf(browser, clientCode, "font-test", gadget);
    let pdf = await readStream(stream);
    let { text } = await extractText(pdf, { mergePages: true });

    // Chromium 126 can encode some CJK glyphs as Unicode compatibility characters.
    expect(text.normalize("NFKC")).toContain("中文A");
  });
});
