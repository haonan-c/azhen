import { DurableObject } from "cloudflare:workers";
import {
  createOpenGadgetError,
  OBSERVER_BINDING_FAILURE_CODES,
  OPEN_GADGET_ERROR_CODES,
} from "@gadgets/workshop-shared/api";

/** Test-only Durable Object that emits the structured error used by `openGadget()`. */
export class OpenGadgetErrorDurableObject extends DurableObject {
  fail(): string {
    throw createOpenGadgetError(
        OPEN_GADGET_ERROR_CODES.observerVerificationFailed,
        [{
          resourceTitle: "Quarterly plan",
          accountLabel: "person@example.com",
          reasonCode: OBSERVER_BINDING_FAILURE_CODES.accountDisconnected,
        }]);
  }
}

export default {
  fetch(): Response {
    return new Response("Not Found", {status: 404});
  },
} satisfies ExportedHandler;
