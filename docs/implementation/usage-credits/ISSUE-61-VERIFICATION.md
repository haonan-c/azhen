# Issue #61 verification

## Evidence boundary

This report verifies the repository closure contract for GitHub Issue #61. Production Worker
tracers use shipping Gatekeeper, Workshop, Cap'n Web, Durable Object, and Usage Credit code paths.
Provider calls use strict mocks or local test Workers. No production SaaS credentials or live
provider accounts are used. This is production-Worker evidence with mock providers, not live
provider validation.

The transport gate is a shipping-repository constraint. It detects direct fetch, WebSocket,
Browser, Hook, and service-binding calls, including computed properties, destructuring, class
fields, later assignments, and fixed-point capability aliases. It does not claim to be a network
sandbox against deliberately malicious Worker code.

## Closed contracts

- `ActionDescription.billing` and the host-issued `ActionExecution` are required. Approval reuses
  the submitter's trusted Principal and operation identity. Legacy unbilled pending Actions remain
  pending and fail closed; legacy applying Actions terminate as unknown instead of redispatching.
- Release discovery finds every deployable `gatekeeper-*` package. The consolidated test requires
  exactly one static, dynamic MCP, or explicit-zero billing contract for each shipping package.
- TypeScript AST checks compare static public interfaces, nested return capabilities, callback/Hook
  parameter capabilities, generated Context/UGC surfaces, and real management RPC classes with
  their package registries. Extra methods, missing methods, ghost entries, continuation omissions,
  and duplicate method keys fail the gate.
- MCP and MCP Portal use the shared bounded dynamic namespace validator. Cloudflare has an explicit
  zero-business-method surface. Catalog and slash-command provider surfaces have one billed or
  reasoned control classification.
- Context catalog and slash-command catalog reads begin and durably start before collection/skill
  storage reads. They complete before observation authorization. Withheld private slash metadata is
  not returned, its Usage remains settled, and observer exclusions are preserved. The new slash
  list key is visible Unpriced Use until an administrator configures a rate.
- GitHub provider adapters require a started operation activity. OAuth, configuration, verifier,
  compensation, and cold `describe()` metadata use explicit control transport paths.
- The exact transport allowlist records each direct call site and its reason. Alias collection runs
  to a fixed point, so declaration order cannot hide a service capability call.

## Focused evidence

| Check | Result |
| --- | --- |
| Root deployable Gatekeeper inventory and exact transport allowlist | Passed: 20/20 |
| Shared AST parser regressions | Passed: interface inheritance, callable properties, nested return capabilities, and Hook parameters |
| Context package | Passed: 44/44 Node tests and 25/25 production workerd tests |
| Scheduler package | Passed: 119 tests, 2 skipped; management app 18/18 |
| UGC Ads package | Passed: 71 Node tests; production workerd 1/1 |
| Workshop slash-command helper | Passed: 5/5 |
| GitHub production billing boundary | Passed: cold control metadata and started-operation provider checks |
| Production integration package | Passed after final Harness isolation: 13 files and 115/115 tests, including complete first-party, DeepSeek, UGC Ads, Action, GitHub, Home Assistant, Spotify, restart paths, and binding isolation |
| Shared/backend/Context/Scheduler/UGC builds | Passed |
| `pnpm lint:check` | Passed; warnings only |
| Independent spec review | Passed: no findings |
| Independent quality review | Passed: no findings |

The targeted failures found during review were treated as real regressions. They included stale
read-only Action calls, a scoped AST type that failed package build, implementation-class and slash
surface inventory gaps, incomplete transport alias propagation, and missing Context slash catalog
authorization. The first complete test run also exposed a missing Action-provider response in the
DeepSeek tracer and local `.dev.vars` overriding deterministic integration credentials. The tracer
now handles the required billable Action request. The test harness disables undeclared development
secrets, replays every declared JSON value through test-only vars, and gives configured strings
test-secret precedence. Each regression received focused verification before the final gates.

## Final gates

| Command | Result |
| --- | --- |
| `pnpm lint` | Passed; lint warnings only, full build and typecheck passed |
| `git diff --check` | Passed |
| `node --test scripts/release-manifest.test.js` | Passed: 4/4 |
| `pnpm test` | Passed after the regression fixes: root 117/117, Workshop backend 444/444 plus all dedicated groups, production integration 114/114, and all remaining workspace package tasks |
| `pnpm --filter @gadgets/integration-tests test` | Passed after final test-Harness isolation hardening: 13 files, 115/115 |

The complete repository suite ran after the production implementation and its regression fixes.
The later review changed only the test Harness isolation and its regression test; `pnpm lint`, the
integration package's full 115-test suite, and the two affected real-Harness paths then passed again.
This report was updated afterward with those results.
