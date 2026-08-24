import { expect, it } from "vitest";
import { CLOUDFLARE_BILLING_METHODS } from "../src/billing-methods.js";

it("declares an explicit zero business-operation billing surface", () => {
  expect(CLOUDFLARE_BILLING_METHODS).toEqual({});
});
