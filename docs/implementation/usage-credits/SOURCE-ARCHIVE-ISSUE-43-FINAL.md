# Issue #43 post-Pro final source archive evidence

Created: 2026-08-19

## Archive identity

- Baseline and current HEAD: `29cfcf62856dee50ed2d681a1e2d137062f2d09c`
- Local branch: `codex/usage-credits-43-66`
- Worktree state: dirty and uncommitted; the archive contains the final local Issue #43 source and
  supporting task documents after ChatGPT Pro correction and Codex revalidation.
- Included source entries: 1,025
- Archive entries including the internal manifest: 1,026
- Safe relative symlinks: 24
- Included source bytes before compression: 20,528,189
- ZIP bytes: 5,347,001
- ZIP SHA-256:
  `5892b636109040f3424a6e2c651d2d7e82da22d9866a2ccc1649bcc05b9316f4`
- ZIP location, relative to the main repository root:
  `.codex-artifacts/usage-credits/issue-43-post-pro-final-source-29cfcf6-20260819.zip`
- External and internal manifest bytes: 134,067
- Manifest SHA-256:
  `a80b609d4ccfd52a056d4c7bbc07b446c2caf6f5c9ca0f0dc4b275d36de3216b`
- Tracked binary-diff SHA-256:
  `92728a8369b3387509c1a5f952f8b4c897472f4c0a9595ec437b42d5b611470b`

The archive excludes this metadata document itself to avoid a circular self-hash. The external
manifest is preserved beside the ZIP as `issue-43-post-pro-final-source-manifest.txt`; the exact same
bytes are the ZIP's `SOURCE-MANIFEST.sha256` entry.

## Inclusion and rejection policy

The candidate list came only from `git ls-files -co --exclude-standard`, sorted deterministically.
The packer then rejected Git metadata, `node_modules`, generated build output, coverage, caches,
Wrangler state, browser/test state, databases, logs, `.env`/`.dev.vars` variants, deployment-local
Wrangler/site configuration, credential stores, cookies, secrets, and private-key formats.

The only candidate rejected from this worktree was the self-referential archive metadata document.
No ignored path was walked or inspected. ZIP path validation rejected absolute paths, parent
traversal, backslash paths, escaping symlinks, unsupported entry types, and duplicate names.

- `unzip -t`: passed; no compressed-data error.
- Fresh extraction: all 1,025 manifest entries matched exact size and SHA-256.
- Archive path and symlink safety: passed.

## Secret scan

- Scanner: Gitleaks 8.30.1
- Scan target: a fresh extraction of this exact final ZIP
- Raw default scan: exit 1 with five findings, all at previously reviewed public test-fixture or
  localization paths
- Reviewed constrained scan: exit 0 with zero remaining findings
- Allowlist configuration SHA-256:
  `d300e27e942b18976a3801d19e7972fc85e4582886615d249a2b4867ef9b5ddb`
- Raw redacted report: 3,879 bytes, SHA-256
  `22b2a4fd853e79a14fd7026d51d7d281ba6e23ec7480766e5adb1d446f0dbec1`
- Reviewed report: 3 bytes, SHA-256
  `37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570`

The five raw paths were:

- `packages/mcp-shared/__tests__/client-pagination.test.ts`
- `packages/mcp-shared/__tests__/credential-rejection.test.ts`
- `packages/workshop-backend/__tests__/sharing.test.ts`
- `packages/workshop-frontend/src/messages.test.ts`
- `packages/workshop-frontend/messages/en.json`

The allowlist is limited by exact Gitleaks rule and path. This result means the configured scanner
found no unreviewed secret; it is not a mathematical proof that no sensitive value can exist under
every detector.

## Relationship to earlier archives

The 5,296,513-byte archive with SHA-256
`121a34e70c0aaa94f5f958a2efe5e457b5777d16a441d57862f4285209ee5eb8` is the source snapshot sent to
ChatGPT Pro. It remains immutable input evidence. This post-Pro archive is the authoritative final
local #43 source snapshot after correction, dual-axis review, full gates, security scan, and evidence
updates.
