import { fileURLToPath } from "node:url";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [capnwebValidate()],
  test: {
    include: ["__tests__/*.test.ts"],
    environment: "node",
    alias: {
      // Lets modules that declare a Durable Object or an `RpcTarget` be imported at all. See the
      // stub for what it does and does not provide.
      "cloudflare:workers": fileURLToPath(
        new URL("./__tests__/stubs/cloudflare-workers.ts", import.meta.url)),
    },
  },
});
