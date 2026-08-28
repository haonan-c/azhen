import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// `@cloudflare/vitest-pool-workers` wraps every Durable Object class so unknown prototype keys can
// be reported helpfully. Up to 0.20.3 it re-wrapped the prototype in a new Proxy on *every*
// construction, so a property lookup cost one stack frame per past construction. A workload that
// constructs a few thousand Durable Objects in one isolate then dies with "Maximum call stack size
// exceeded" inside the constructor, which is what the usage-capacity-v1 profile does at 10,000
// registered Users. `patches/@cloudflare__vitest-pool-workers@0.20.3.patch` wraps once.
//
// The failure takes twelve minutes to appear and looks like a product bug, so losing the patch
// silently is expensive. This asserts it is still declared and still applied.
test("the vitest-pool-workers prototype patch is declared", () => {
  const workspace = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  assert.match(
    workspace,
    /patchedDependencies:[\s\S]*'@cloudflare\/vitest-pool-workers@0\.20\.3'/,
    "the pool-workers patch must stay declared in pnpm-workspace.yaml",
  );
});

test("the vitest-pool-workers prototype is wrapped once, not per construction", () => {
  const patch = readFileSync(
    join(ROOT, "patches/@cloudflare__vitest-pool-workers@0.20.3.patch"), "utf8",
  );
  assert.match(patch, /\+\s*let prototypeWrapped = false;/);
  assert.match(patch, /-\s*Class\.prototype = new Proxy\(Class\.prototype/);
});
