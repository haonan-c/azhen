import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RpcStub } from "capnweb";
import type { PublicApi } from "@gadgets/workshop-shared/api";
import { startHarness, type Harness } from "../src/harness.js";
import { connect, nextUsernames, signUp } from "../src/rpc-client.js";

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness({
    gatekeepers: [],
    patchWorkshop(config) {
      config.worker_loaders = [{ binding: "LOADER" }];
    },
  });
});

afterAll(async () => {
  await harness?.server.close();
});

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function withSession<T>(body: (api: RpcStub<PublicApi>) => Promise<T>): Promise<T> {
  const publicApi = connect(harness.url);
  try {
    return await body(publicApi);
  } finally {
    publicApi[Symbol.dispose]();
  }
}

describe("document export", () => {
  it("downloads valid Word and PDF files through the public WebSocket API", async () => {
    await withSession(async publicApi => {
      const [username] = nextUsernames("exporter");
      using api = await signUp(publicApi, username);
      using workspace = await api.newGadgetFromBlueprint("format.document", {});
      const metadata = await workspace.getMetadata();
      if (metadata.defaultGadgetId === undefined) {
        throw new Error("The document blueprint did not create a default Gadget.");
      }

      using gadget = await workspace.getGadget(metadata.defaultGadgetId);
      await gadget.setTitle("端到端导出测试");

      const docx = await readStream(await gadget.exportDocx());
      expect(new TextDecoder().decode(docx.subarray(0, 2))).toBe("PK");
      expect(docx.byteLength).toBeGreaterThan(1_000);

      const pdf = await readStream(await gadget.exportPdf());
      expect(new TextDecoder().decode(pdf.subarray(0, 5))).toBe("%PDF-");
      expect(pdf.byteLength).toBeGreaterThan(1_000);
    });
  });
});
