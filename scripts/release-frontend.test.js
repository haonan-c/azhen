import { test } from "node:test";
import assert from "node:assert/strict";
import { FRONTEND_VARIANTS } from "./release/build-release.mjs";

test("release build defines explicit public and Access frontend variants", () => {
  assert.deepEqual(FRONTEND_VARIANTS, [
    { name: "public", env: { VITE_CF_ACCESS_MODE: "false" } },
    { name: "access", env: { VITE_CF_ACCESS_MODE: "true" } },
  ]);
});
