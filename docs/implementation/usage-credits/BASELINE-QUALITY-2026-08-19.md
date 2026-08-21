# Usage Credits baseline quality evidence — 2026-08-19

This baseline predates every #43 source change. It was run in the isolated
`codex/usage-credits-43-66` worktree at commit
`29cfcf62856dee50ed2d681a1e2d137062f2d09c`.

## Toolchain used

- Node: 24.11.0
- pnpm: 11.17.0
- Wrangler: 4.119.0
- `@cloudflare/vitest-pool-workers`: 0.20.3
- workerd: 1.20260801.1
- Miniflare under the pool: 5.20260801.1-alpha

CI fixes Node at 24.19.0. That exact version was installed with nvm after this run and must be used
for the implementation gates. The baseline result below is not claimed to be CI-equivalent.

## Results

| Command | Result | Evidence |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | Passed | Exit 0, about 1m23s; lockfile unchanged. Workspace `.bin` creation warnings did not prevent later commands. |
| `pnpm lint:check` | Passed | Exit 0, about 19.25s; warnings only, no error. |
| `pnpm build` | Passed | Exit 0; 50 tasks, 0 cache hits; TypeScript, code generation and three SPA production bundles completed. Only existing Vite chunk/dynamic-import warnings. |
| First `pnpm test` | Failed | Exit 1 at `browser-export-fonts.test.ts`: 1 failed after 30.017s, `Error: Browser export timed out`, plus Miniflare `Can't call WebSocket send() after close()`. |
| Focused font-test retry | Passed with runtime log | Exit 0, 1/1 in 4.10s, but the WebSocket-after-close log remained. |
| Second complete `pnpm test` | Failed | Exit 1 at the same test after 30.014s with the same timeout and WebSocket-after-close log. |

Before the first full failure, the command had passed the root Node tests (95), integration-tests
(21), frontend (346), MCP (244), ordinary workshop-backend workerd suite (316), backend RPC test
(1), and backend integration set reported as 6 passed/4 skipped. Because Vite+ stops at the failing
backend package, packages ordered after it were not proven by either complete command.

## Interpretation

The baseline is **not green**. The font-export integration test passes in isolation but fails
reproducibly in the complete package sequence, so the focused pass cannot substitute for the root
gate. This is currently evidence of a suite-order or browser-harness timing defect, not evidence of
a #43 regression. It remains a blocking quality condition until an exact Node 24.19.0 run passes or
the baseline defect is diagnosed and fixed with its own evidence.

No source, lockfile, remote Git state, deployment, production configuration or credentials were
changed by these commands.

## Follow-up diagnosis with CI Node

Node 24.19.0 was activated and verified both as `node -v` and `pnpm exec node -v`. Under lower
machine load:

- the font test passed, 1/1, with 7.119s test time, 12.39s Vitest time and 18.90s command time;
- the sequence `open-gadget-rpc -> browser-export-fonts` passed, with the first process reporting
  6 passed/4 skipped and the font process reporting 1 passed in 6.828s;
- the Miniflare `WebSocket send() after close()` message still appeared on green runs.

Both original failures landed at 30.017s/30.014s, matching the product's 30,000ms export deadline
rather than the Vitest configuration's 60,000ms timeout. At failure time this 12-core host had a
load average of 33.73 and two unrelated TypeScript compilers used about 250 percent CPU. When load
fell to about 14, the same local path completed in about seven seconds.

The leading explanation is therefore local resource contention against a real product deadline.
The persistent WebSocket-after-close log proves a separate Miniflare browser-rendering shutdown
race, but it also occurs on passes and is not sufficient to explain the timeout. Commit `2449a80`
already isolates the three browser integration files into separate Vitest processes; the exact
CI-Node sequence did not reproduce cross-process pollution.

This follow-up does not turn the two failed root commands into passes. Before any Issue closes, the
affected package and root gates must be rerun with Node 24.19.0 on a quiet host. Do not increase the
production export deadline or patch `node_modules` to hide this baseline signal. Linux CI remains
the final environment-equivalent check because it also installs `fonts-noto-cjk`.
