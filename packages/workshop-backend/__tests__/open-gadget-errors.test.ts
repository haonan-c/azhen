import { describe, expect, it } from "vitest";
import {
  createOpenGadgetError,
  getOpenGadgetErrorCode,
  getOpenGadgetObserverFailures,
  OBSERVER_BINDING_FAILURE_CODES,
  OPEN_GADGET_ERROR_CODES,
} from "@gadgets/workshop-shared/api";

describe("open gadget errors", () => {
  it.each([
    [OPEN_GADGET_ERROR_CODES.workspaceNotFound, "Workspace not found."],
    [OPEN_GADGET_ERROR_CODES.workspaceAccessDenied, "You don't have access to this workspace."],
    [OPEN_GADGET_ERROR_CODES.observerAccountsRequired, "Observer accounts are required."],
    [OPEN_GADGET_ERROR_CODES.observerVerificationFailed, "Observer verification failed."],
  ] as const)(
    "creates an enumerable %s code with a readable message",
    (code, message) => {
      let error = createOpenGadgetError(code);

      expect(error.message).toBe(message);
      expect(error.code).toBe(code);
      expect(Object.keys(error)).toContain("code");
      expect(getOpenGadgetErrorCode(error)).toBe(code);
    },
  );

  it.each(Object.values(OPEN_GADGET_ERROR_CODES))(
    "does not infer %s from an error message",
    (code) => {
      expect(getOpenGadgetErrorCode(new Error(code))).toBeUndefined();
    },
  );

  it("does not classify unexpected errors", () => {
    expect(getOpenGadgetErrorCode(new Error("storage unavailable"))).toBeUndefined();
    expect(getOpenGadgetErrorCode({ code: "UNKNOWN" })).toBeUndefined();
  });

  it("attaches structured observer failures without mixing them into the error message", () => {
    let failures = [{
      resourceTitle: "Quarterly plan",
      accountLabel: "person@example.com",
      reasonCode: OBSERVER_BINDING_FAILURE_CODES.accountDisconnected,
    }];
    let error = createOpenGadgetError(
        OPEN_GADGET_ERROR_CODES.observerVerificationFailed, failures);

    expect(error.message).toBe("Observer verification failed.");
    expect(error.observerFailures).toEqual(failures);
    expect(Object.keys(error)).toContain("observerFailures");
    expect(getOpenGadgetObserverFailures(error)).toEqual(failures);
    expect(getOpenGadgetObserverFailures(new Error("failure"))).toBeUndefined();
  });

});
