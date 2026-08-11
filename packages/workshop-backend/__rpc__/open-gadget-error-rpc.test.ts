import { env } from "cloudflare:workers";
import { newMessagePortRpcSession, RpcTarget, type RpcStub } from "capnweb";
import {
  getOpenGadgetErrorCode,
  getOpenGadgetObserverFailures,
  OBSERVER_BINDING_FAILURE_CODES,
  OPEN_GADGET_ERROR_CODES,
} from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";
import type { OpenGadgetErrorDurableObject } from "./worker";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    OPEN_GADGET_ERROR_TEST: DurableObjectNamespace<OpenGadgetErrorDurableObject>;
  }
}

class ErrorBridge extends RpcTarget {
  constructor(private durableObject: DurableObjectStub<OpenGadgetErrorDurableObject>) {
    super();
  }

  async fail(): Promise<string> {
    return await this.durableObject.fail();
  }
}

async function rejection(value: PromiseLike<unknown>): Promise<Error> {
  try {
    await value;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new TypeError("Expected RPC to reject with an Error.", {cause: error});
  }
  throw new Error("Expected RPC to reject.");
}

describe("openGadget structured errors across RPC boundaries", () => {
  it("retains observer failure details across native Durable Object and Cap'n Web RPC", async () => {
    let channel = new MessageChannel();
    let durableObject = env.OPEN_GADGET_ERROR_TEST.getByName("observer-failure");
    using _server = newMessagePortRpcSession(channel.port1, new ErrorBridge(durableObject));
    using client: RpcStub<ErrorBridge> = newMessagePortRpcSession<ErrorBridge>(channel.port2);

    let error = await rejection(client.fail());

    expect(getOpenGadgetErrorCode(error)).toBe(
        OPEN_GADGET_ERROR_CODES.observerVerificationFailed);
    expect(Object.keys(error)).toContain("observerFailures");
    expect(getOpenGadgetObserverFailures(error)).toEqual([{
      resourceTitle: "Quarterly plan",
      accountLabel: "person@example.com",
      reasonCode: OBSERVER_BINDING_FAILURE_CODES.accountDisconnected,
    }]);
  });
});
