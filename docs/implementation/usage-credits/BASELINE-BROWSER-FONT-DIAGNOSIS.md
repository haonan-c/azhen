# Browser font export timeout diagnosis — 2026-08-19

## Scope and conclusion

This document diagnoses the existing timeout in
`packages/workshop-backend/__integration__/browser-export-fonts.test.ts`. It does not change
application code, test code, dependency versions, deadlines, assertions, or the lockfile.

The confirmed trigger is shared-host CPU scheduling contention against the product's 30,000 ms
Browser export deadline. The failure is not the Vitest 60,000 ms test timeout. It is also not
evidence of an Issue #43 regression. A separate Miniflare WebSocket forwarding race produces
`Can't call WebSocket send() after close()` on both passing and failing runs. That dependency log
is not a sufficient cause of the timeout.

The exact slow post-launch substage was not isolated. Dynamic instrumentation stopped when the
stress probe interfered with other verification on the shared host. The remaining localization
boundary is `browser.newPage()` through DOM settlement, font preparation, and PDF stream creation.

## Repository and toolchain

- Source baseline: `29cfcf62856dee50ed2d681a1e2d137062f2d09c`
- Diagnostic worktree: `.codex-worktrees/usage-credits`
- Node.js: `24.19.0`
- pnpm: `11.17.0`
- `@cloudflare/vitest-pool-workers`: `0.20.3`
- Miniflare: `5.20260801.1-alpha`
- workerd: `1.20260801.1`
- No source or dependency file changed during this diagnosis.

## Red-capable feedback loop

The real one-file integration test is the smallest valid seam. It starts the configured Browser
Run binding, renders the Gadget, consumes the PDF stream, extracts text, and checks the CJK text.
Removing Browser Run or PDF rendering would stop testing the reported failure.

The normal focused command was:

```sh
source /Users/admin/.nvm/nvm.sh
nvm use 24.19.0 >/dev/null
/usr/bin/time -lp pnpm exec vitest run \
  --config vitest.integration.config.ts \
  __integration__/browser-export-fonts.test.ts
```

Working directory:
`/Users/admin/chenhaonan/haonan-c/azhen/.codex-worktrees/usage-credits/packages/workshop-backend`

Observed green result:

- Vitest: 1 file and 1 test passed.
- Test body: 7.75 seconds.
- Vitest duration: 15.02 seconds.
- Process wall time: 22.47 seconds.
- The Miniflare WebSocket-after-close message still appeared.

A second low-priority run also passed. Its test body was 6.87 seconds, Vitest duration was 12.71
seconds, and process wall time was 18.53 seconds. It had the same WebSocket-after-close message.

The diagnostic stress command below is recorded for audit only. **Do not run it again on a shared
host.** It created 24 `yes` processes and lowered the test process priority. This was an unsafe
attempt to increase the intermittent failure rate:

```sh
source /Users/admin/.nvm/nvm.sh
nvm use 24.19.0 >/dev/null
hog_pids=()
for i in {1..24}; do yes > /dev/null & hog_pids+=($!); done
cleanup_hogs() {
  kill $hog_pids 2>/dev/null || true
  wait $hog_pids 2>/dev/null || true
}
trap cleanup_hogs EXIT INT TERM
/usr/bin/time -lp nice -n 20 pnpm exec vitest run \
  --config vitest.integration.config.ts \
  __integration__/browser-export-fonts.test.ts
```

Observed red result:

- Vitest: 1 file failed and 1 test failed.
- Test case: 30.041 seconds.
- Test file: 30.045 seconds.
- Failure: `Error: Browser export timed out.`
- Vitest duration: 49.56 seconds.
- Process wall time, including starved shutdown: 102.80 seconds.
- The application log event was `gadget.export.render.failed`, not
  `gadget.export.browser.launch.failed`.
- Miniflare also printed the same WebSocket-after-close message seen on green runs.

One further 24-process stress probe, without `nice`, passed the test body in 20.24 seconds but still
caused unacceptable system load. The probes raised the shared host load to about 237 and caused an
unrelated Usage Account RPC check to time out at 60 seconds. This interference was a diagnostic
error, not valid test evidence. The probes stopped, their exit traps ran, and a process-table check
found no remaining `yes`, Vitest, workerd, or diagnostic Chromium process from this diagnosis.

The safe loop is therefore the real focused command on a quiet host. The stress form is
red-capable but is neither safe nor suitable for routine regression testing. The product deadline
also makes any exact red loop take at least 30 seconds.

## Ranked hypotheses and checks

| Rank | Falsifiable hypothesis | Prediction | Evidence and disposition |
| --- | --- | --- | --- |
| 1 | Shared-host CPU contention delays the post-launch Browser work beyond 30 seconds. | The real test passes when scheduled normally and reaches the exact product deadline under severe scheduling contention. | Supported. Normal runs completed the test body in 6.87–7.75 seconds. The stressed run failed in 30.041 seconds. The two earlier complete baseline failures also ended in 30.017 and 30.014 seconds while the host was busy. |
| 2 | Browser module or RPC initialization hangs in `waitForDomSettled()`. | Browser launch completes, but a tagged stage trace would not reach the DOM-settled marker. | Not isolated. The `gadget.export.render.failed` event proves launch completed, but dynamic stage instrumentation was not justified after the shared-host interference. |
| 3 | `createPDFStream({ waitForFonts: true })` waits indefinitely for the local CJK fallback. | A tagged trace reaches DOM settlement and font fallback but not PDF stream creation. | Not isolated. This is a possible slow substage, but it does not contradict the confirmed scheduling trigger. |
| 4 | The Miniflare WebSocket close race directly causes the timeout. | The close error must correlate with red runs and disappear on green runs. | Rejected as the primary cause. The exact same error appeared on every recorded green run. |
| 5 | Earlier repository tests leave Browser Run state that poisons this file. | A fresh process should pass, while a fixed predecessor sequence should fail at a high rate. | Disfavored. Commit `2449a80` already gives each Browser integration file its own Vitest process and sets root Vite+ test concurrency to 1. The exact `open-gadget-rpc -> browser-export-fonts` sequence also passed in prior focused verification. |

## Static source and dependency evidence

### The 30-second failure is a product deadline

`packages/workshop-backend/src/browser-export.ts` defines
`MAX_EXPORT_DURATION_MS = 30_000`. `renderGadgetStream()` starts that deadline before Browser launch
and races launch, page setup, DOM settlement, rendering, and stream delivery against it.

`packages/workshop-backend/vitest.integration.config.ts` sets `testTimeout: 60_000`. The observed
30.041-second failure therefore comes from `createDeadline()`, not Vitest.

The launch catch logs `gadget.export.browser.launch.failed`. The later render catch logs
`gadget.export.render.failed`. The red run emitted the render event. Browser launch therefore
finished before the deadline; the remaining delay was in the post-launch Browser pipeline.

Existing unit coverage in `packages/workshop-backend/__tests__/browser-export.test.ts` already pins
the 30-second deadline and verifies that a timed-out export releases the Browser and Gadget.

### The WebSocket error is a Miniflare close race

The installed
`miniflare/dist/src/workers/browser-rendering/binding.worker.js` forwards both WebSocket directions
at line 194 with direct `server.send(m.data)` and `chrome.send(m.data)` calls. Those message handlers
do not check `readyState`. The helper that checks closed state is used for close forwarding, not for
message forwarding.

The installed `@cloudflare/puppeteer` `WorkersWebSocketTransport` also registers an `async` message
listener and forwards protocol messages with a direct `this.ws.send(message)`. This explains the
paired runtime warning that an event handler returned a Promise and the late send after one side
closed.

This behavior is inside installed dependencies. Filtering the exception in Vitest would hide a
real dependency defect. It would not make Browser export faster or repair the 30-second timeout.

### Repository test isolation is already present

Commit `2449a801ef15c15782083dc916a9a5149086b822` changed the root test task to
`--concurrency-limit 1` and runs `open-gadget-rpc`, `browser-export-fonts`, and
`browser-export-docx` in separate Vitest processes. Increasing isolation again is not supported by
the current evidence.

## Why no source fix was made

- Increasing `MAX_EXPORT_DURATION_MS` changes a production safety limit and hides the measured
  resource problem.
- Increasing Vitest's timeout cannot help because Vitest already allows 60 seconds and the product
  code rejects at 30 seconds.
- Adding a sleep would make timing less deterministic.
- Weakening the CJK assertion would stop testing the original PDF regression.
- Suppressing the Miniflare exception would hide dependency behavior and would not address the
  timeout.
- Application code cannot make a heavily oversubscribed shared host provide CPU time.
- The code already has deadline and cleanup unit tests, separate Browser test processes, and root
  test concurrency 1.

The minimum valid remedy is operational: run the quality gate without competing compilation,
workerd, Chromium, or synthetic load. Use a dedicated CI runner if a shared desktop cannot provide
a quiet window. A dependency update may later repair the Miniflare close race, but it is a separate
change and requires its own upstream evidence and full lockfile verification.

## Regression and Issue-closing gate

The focused integration test remains the correct feature regression test. It must pass, but it
cannot replace the root gate.

Issue #43 must remain open until this exact quiet-host gate completes in one uninterrupted run with
exit code 0:

```sh
source /Users/admin/.nvm/nvm.sh
nvm use 24.19.0 >/dev/null
node -v
pnpm -v
pnpm exec node -v
pnpm test
```

Expected version output is Node.js `v24.19.0` and pnpm `11.17.0`. The final record must preserve the
full root command exit code and must not replace a root failure with focused retries. A local pass
is not production validation. Linux CI remains the environment-equivalent gate because CI also
installs the CJK font package before testing.

If the exact root command still fails while the runner is demonstrably quiet, do not change the
deadline. Create an isolated diagnostic patch with tagged timestamps around `launch`, `newPage`,
`goto`, DOM settlement, font fallback, and PDF stream creation. Reproduce before making a source
change, then remove all diagnostic tags.
