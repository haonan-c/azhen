import { env } from "cloudflare:workers";
import { RpcTarget, type RpcStub } from "capnweb";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { renderGadgetDocx } from "../src/browser-export";

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

class EmptyGadget extends RpcTarget {
  [Symbol.dispose](): void {}
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function renderDocxArchive(html: string, title: string): Promise<JSZip> {
  let browser = env.BROWSER;
  if (!browser) throw new Error("Browser Run is not configured for this test.");
  let clientCode = `document.body.innerHTML = ${JSON.stringify(html)};`;
  let gadget = new EmptyGadget() as unknown as RpcStub<EmptyGadget>;
  let stream = await renderGadgetDocx(browser, clientCode, title, gadget);
  return JSZip.loadAsync(await readStream(stream));
}

function mediaFiles(archive: JSZip) {
  return Object.values(archive.files)
    .filter(file => !file.dir && file.name.startsWith("word/media/"));
}

describe("Gadget DOCX export", () => {
  it("exports visible document structure as an editable Word file", async () => {
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
    let archive = await renderDocxArchive(html, "产品发布说明");
    let documentXml = await archive.file("word/document.xml")?.async("string");

    expect(archive.file("[Content_Types].xml")).not.toBeNull();
    expect(documentXml).toContain("产品发布说明");
    expect(documentXml).toContain("中文内容");
    expect(documentXml).toContain("<w:pStyle w:val=\"Heading1\"");
    expect(documentXml).toContain("<w:numPr>");
    expect(documentXml).toContain("<w:tbl>");
    expect(documentXml).not.toContain("Toolbar command");
  });

  it("embeds visible images in the Word file", async () => {
    let html = `<p>产品图片<img
      src="${PNG_DATA_URL}"
      alt="产品图片"
      style="width: 120px; height: 80px"
    ></p>`;
    let archive = await renderDocxArchive(html, "产品图片");
    let documentXml = await archive.file("word/document.xml")?.async("string");
    let relationshipsXml = await archive.file("word/_rels/document.xml.rels")?.async("string");

    expect(mediaFiles(archive)).toHaveLength(1);
    expect(documentXml).toContain("<w:drawing>");
    expect(relationshipsXml).toContain(
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
    );
  });

  it("uses alternative text when an image cannot be decoded", async () => {
    let html = `<p><img
      src="data:image/png;base64,invalid"
      alt="图片无法显示"
      style="width: 120px; height: 80px"
    ></p>`;
    let archive = await renderDocxArchive(html, "图片替代文字");
    let documentXml = await archive.file("word/document.xml")?.async("string");

    expect(documentXml).toContain("[图片无法显示]");
  });

  it("embeds an image outside a semantic text block", async () => {
    let html = `<main><img
      src="${PNG_DATA_URL}"
      alt="独立图片"
      style="width: 120px; height: 80px"
    ></main>`;
    let archive = await renderDocxArchive(html, "独立图片");

    expect(mediaFiles(archive)).toHaveLength(1);
  });
});
