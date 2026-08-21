# Issue #43 source archive evidence

Created: 2026-08-19

- Baseline commit: `29cfcf62856dee50ed2d681a1e2d137062f2d09c`
- Local branch: `codex/usage-credits-43-66`
- Included files: 984
- ZIP bytes: 5,161,866
- ZIP SHA-256: `3ccdc8471b4036f91a625890868f4dcc82b0ac33a985be12d8d8c7cd54e5bd1a`
- ZIP location: `.codex-artifacts/usage-credits/issue-43-source-29cfcf6-20260819.zip`
- Tracked-diff SHA-256 at packaging: `fbf40ed975709e425db497c273c80c127b5dd731d7498e4161f0643dbace30b5`
- Scanner: Gitleaks 8.30.1
- Scan target: a fresh extraction of the final ZIP
- Remaining findings after reviewed allowlist: 0
- Allowlist configuration SHA-256:
  `d300e27e942b18976a3801d19e7972fc85e4582886615d249a2b4867ef9b5ddb`

The archive was built from `git ls-files -co --exclude-standard` plus explicit rejection rules.
It excludes Git metadata, node_modules, build output, caches, coverage, Wrangler state, databases,
browser state, site configuration, .env variants, .dev.vars variants, credentials, cookies, private
key formats, and deployment-specific Wrangler files. The ZIP integrity test and prohibited-path
check passed.

The first unconfigured Gitleaks scan reported five findings. They were reviewed without copying
their values. Each is a public tracked test fixture or localization key, and each source and archive
blob was pinned before allowlisting:

- `packages/mcp-shared/__tests__/client-pagination.test.ts`:
  `8f40ccbe84381c210e7e0811932bbc605cdf5765`
- `packages/mcp-shared/__tests__/credential-rejection.test.ts`:
  `4cc958e74c998808b0a1259682d61449565f5f3e`
- `packages/workshop-backend/__tests__/sharing.test.ts`:
  `720908f02953c8d03e965e6934f7d7deb8358172`
- `packages/workshop-frontend/src/messages.test.ts`:
  `a95cba0506623d3590d996fb2c533a6a9a3a498c`
- `packages/workshop-frontend/messages/en.json`:
  `362b766c1ecae432340c00f700f156d40f0f1e6d`

The reviewed allowlist applies only to the matching Gitleaks rule and file path. All other default
Gitleaks rules remain enabled. This evidence records a credential scan, not proof that the source is
free of every possible sensitive value.
