import {cloudflareTest} from "@cloudflare/vitest-plugin";
import {defineConfig} from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({
    main: "./src/homeassistant.ts",
    wrangler: {configPath: "./wrangler.jsonc"},
  })],
});
