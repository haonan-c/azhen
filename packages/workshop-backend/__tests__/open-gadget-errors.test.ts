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

  it.each([
    ["no reason", { resourceTitle: "Quarterly plan" }],
    ["both reason forms", {
      resourceTitle: "Quarterly plan",
      reason: "Vendor denied access.",
      reasonCode: OBSERVER_BINDING_FAILURE_CODES.accountDisconnected,
    }],
    ["an unknown reason code", {
      resourceTitle: "Quarterly plan",
      reasonCode: "UNKNOWN_REASON",
    }],
    ["an empty reason", { resourceTitle: "Quarterly plan", reason: "" }],
    ["a blank reason", { resourceTitle: "Quarterly plan", reason: " \n " }],
    ["an invalid resource title", { resourceTitle: 42, reason: "Vendor denied access." }],
    ["an invalid account label", {
      resourceTitle: "Quarterly plan",
      accountLabel: 42,
      reason: "Vendor denied access.",
    }],
    ["an invalid reason", { resourceTitle: "Quarterly plan", reason: 42 }],
    ["an invalid reason code", { resourceTitle: "Quarterly plan", reasonCode: 42 }],
  ])("rejects a structured observer failure with %s", (_description, failure) => {
    let error = Object.assign(new Error("Observer verification failed."), {
      code: OPEN_GADGET_ERROR_CODES.observerVerificationFailed,
      observerFailures: [failure],
    });

    expect(getOpenGadgetObserverFailures(error)).toBeUndefined();
  });

});
