# Issue #43 final security diff scan

Date: 2026-08-19

## Result

The app-backed Codex Security diff scan completed with **zero reportable findings** and complete
coverage of the executable/configuration change inventory. The scan reviewed all 17 items prepared
by the scanner and manually added `AGENTS.md`, because that changed document controls executable
test coverage. Non-executable domain and evidence documents were explicitly excluded from code
vulnerability discovery.

This was a local source and test-evidence review. It was not a deployment, production-data review,
or real-provider validation.

## Identity

- Scan ID: `15b702a6-30c9-469a-9efe-fcf99406400f`
- Baseline commit: `29cfcf62856dee50ed2d681a1e2d137062f2d09c`
- Target: working-tree diff from the same fixed baseline
- Snapshot:
  `codex-security-snapshot/v1:sha256:266dea3b7d171d40c8c18e32c214324d76f62c5ba911392f1586654b0dab9398`
- Coverage: 18/18 assigned review items closed; no deferred surface
- Preflight: `ready`; 3/3 checks passed
- TAC advisory: unavailable because the Codex Security Access connector was not connected. TAC is
  advisory and did not gate or authorize the scan.
- Measured scan usage: 13,672,304 total tokens; 13,605,326 input; 13,083,136 cached input; 66,978
  output; coverage reported complete by the workbench.

## Security boundaries reviewed

- Authenticated capability to the current User Durable Object; no caller-selected User ID.
- Public balance-only RPC versus internal reserve, settle, and release methods.
- Exact `bigint` arithmetic and lossless Cap'n Web transport beyond `Number.MAX_SAFE_INTEGER`.
- One-transaction grant, reservation, terminal transition, Ledger, and aggregate updates.
- Concurrent delivery, lost-response replay, terminal conflict, reserved-ID, and zero-Charge rules.
- React text rendering, capability replacement, callable-stub rules, and stale result suppression.
- Root/backend/frontend test discovery, workerd assertion, and cache/selector behavior.

## Candidate validation

Two private-storage-corruption candidates entered validation. Both mechanical observations are true,
but neither has an attacker-controlled producer in the current repository:

1. Structurally valid but relationally corrupted cached totals could misstate balance or reserve
   admission. The only current writer updates facts and totals in one transaction; no public raw
   totals writer or production paid-work mutator exists.
2. A falsy non-`undefined` corrupted Reservation value would bypass a truthiness presence check.
   Every current writer stores a structured truthy Reservation; no public or internal competing
   writer exists.

Both candidates were recorded as `suppressed` in validation and projected as `Rejected` coverage
surfaces. They remain future migration/import/repair hardening conditions. No candidate survived to
attack-path analysis.

## Persistent artifacts

Persistent directory, relative to the main repository root:
`.codex-artifacts/usage-credits/issue-43-security-scan-15b702a6/`

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `report.md` | 8,726 | `942bd52e74cc1893d9ee5962cdfc7d625fdb60cc8ba82dd82f7930f1ac5715e8` |
| `scan-manifest.json` | 6,364 | `ff3200d47634e3e29e223f760c13e84a86d600a7fcb1e6015b18d6e87dd1d276` |
| `findings.json` | 144 | `63dfe3387e45079f48aeeada9a153bf322c6d5f040b842d0feebf7019ee6d5d6` |
| `coverage.json` | 4,976 | `8179317722016b37bc6c10ac0d638eb108f6bb8d025e039451956d6c9e936412` |
| `exports/results.sarif` | 529 | `3ec71ceca401980f9618f680fea42fb44a2af242f186011fb8bfccb3b676636f` |
| `threat_model.md` | 3,488 | `cfb7fbf4ce935026578583fee0cd8fcad2ff2bbae5b7d77ebd328f2476aa6768` |
| candidate ledger | 7,991 | `78ce944aa05b5f27fb623451c4fdb25c97f6772dc46f2c94cb66321ac859eb16` |

## Limitations

- No production deployment, Cloudflare account, real User data, or real provider credential was used.
- Local workerd and Cap'n Web tests use production code paths but do not validate production network
  or production data.
- Repository-external operator writes and future migration or repair writers are outside the current
  source proof boundary.
