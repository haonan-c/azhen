import { env } from "cloudflare:workers";
import { RpcTarget, type RpcStub } from "capnweb";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { renderGadgetDocx } from "../src/browser-export";

class EmptyGadget extends RpcTarget {
  [Symbol.dispose](): void {}
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("Gadget DOCX export", () => {
  it("exports visible document structure as an editable Word file", async () => {
    let browser = env.BROWSER;
    if (!browser) throw new Error("Browser Run is not configured for this test.");

    let html = `
      <style>@media print { .toolbar { display: none; } }</style>
      <p class="toolbar">Toolbar command</p>
      <main>
        <h1>产品发布说明</h1>
        <p>版本 <strong>v1.0</strong></p>
        <ul><li>中文内容</li></ul>
        <table><tr><th>项目</th><th>状态</th></tr><tr><td>导出</td><td>完成</td></tr></table>
      </main>
    `;
    let clientCode = `document.body.innerHTML = ${JSON.stringify(html)};`;
    let gadget = new EmptyGadget() as unknown as RpcStub<EmptyGadget>;
    let stream = await renderGadgetDocx(browser, clientCode, "产品发布说明", gadget);
    let archive = await JSZip.loadAsync(await readStream(stream));
    let documentXml = await archive.file("word/document.xml")?.async("string");

    expect(archive.file("[Content_Types].xml")).not.toBeNull();
    expect(documentXml).toContain("产品发布说明");
    expect(documentXml).toContain("中文内容");
    expect(documentXml).toContain("<w:pStyle w:val=\"Heading1\"");
    expect(documentXml).toContain("<w:numPr>");
    expect(documentXml).toContain("<w:tbl>");
    expect(documentXml).not.toContain("Toolbar command");
  });
});
