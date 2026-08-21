# Issue #43 ChatGPT Pro corrective delivery audit

Date: 2026-08-19

## Conversation and input baseline

- Conversation: <https://chatgpt.com/c/6a85ece0-cd48-83e8-a6cf-cf01383965d7>
- Source commit: `29cfcf62856dee50ed2d681a1e2d137062f2d09c`
- Input source archive: `issue-43-final-source-29cfcf6-20260819.zip`
- Input archive bytes: 5,296,513
- Input archive SHA-256:
  `121a34e70c0aaa94f5f958a2efe5e457b5777d16a441d57862f4285209ee5eb8`

## Corrective delivery identity

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `azhen-issue-43-pro-corrective-review.zip` | 112,522 | `4e35d1ebe49a7c210bdd11bbdcc1afdde7daf4c9bb5a42822c7b8d01bf719ac5` |
| `issue-43-pro-corrective-review.patch` | 15,046 | `edfbe2548ff8682247ecf464579745bbd517152cdcd84f7837aac09d3ced9657` |
| `ISSUE-43-PRO-CORRECTIVE-REVIEW.md` | 23,435 | `863dd772401f062e77030caffd7778feb7b18acbfb0274e2ed6b27fca0e5757f` |

The extracted delivery is preserved at
`.codex-artifacts/usage-credits/pro-issue43-corrective-review-20260819/` relative to the main
repository root.

## Independent integrity and safety checks

- The original source ZIP contained 1,022 safe entries, including 24 safe relative symlinks. Path,
  traversal, and archive-integrity checks passed.
- The corrective ZIP contained 206 safe regular files. Its internal manifest covered the other 205
  files, and every size and SHA-256 matched.
- In a disposable `/tmp` copy, the patch passed `git apply --check`, applied successfully, and
  passed reverse-check. All four patched post-images were byte-identical to the four replacement
  files in the ZIP.
- Gitleaks 8.30.1 scanned the extracted corrective delivery with exit 0 and no finding.
- The delivery did not include the adjacent outer `.sha256`, `.bytes`, or JSON metadata sidecars
  described in its report. The independently computed outer values above are authoritative for this
  audit. This is a delivery-completeness gap, not a patch-integrity failure.

## Engineering review and disposition

ChatGPT Pro rated the original candidate `NEEDS_CORRECTION`. It reported two Medium defects:

1. Reservation/Ledger reconciliation did not fully enforce one-to-one Charge linkage, including
   zero-value settlements and replay after storage inconsistency.
2. The balance card could retain a previous authenticated capability's balance or error during a
   capability replacement.

After its proposed correction, Pro rated the source `PASS_WITH_RISKS`. Pro could not run repository
quality gates: its environment had Node 22.16 and no working pnpm, so command failures or omissions
from that environment were not accepted as validation.

Codex did not apply the patch blindly. By delivery time the local candidate had additional
same-transaction initial-grant and reserved-operation-ID corrections. Directly replacing all four
files would have regressed that newer behavior. Instead, Codex independently reproduced both Pro
findings, implemented the minimum compatible fixes, strengthened real-workerd and React regression
tests, and then ran the full Node 24.19 gate set.

No commit, push, pull request, deployment, production migration, GitHub Issue mutation, or real
User-data operation occurred during this audit.
