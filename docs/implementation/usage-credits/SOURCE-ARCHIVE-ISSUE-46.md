# Issue #46 Source Archive

This record identifies the exact local source snapshot supplied to ChatGPT Pro for the Issue #46 review. The archive was created from the current working tree. It contains tracked and non-ignored untracked source files, including the accepted local work for Issues #43 through #45.

## Baseline

- Repository: `haonan-c/azhen`
- Branch: `codex/usage-credits-43-66`
- Git HEAD: `29cfcf62856dee50ed2d681a1e2d137062f2d09c`
- Working tree: dirty by design; no commit, push, PR, deploy, migration, or production-data operation was performed.
- Archive name: `issue-46-source-29cfcf6-20260820.zip`
- Archive entries: 1,041, including the internal manifest
- Source entries in the manifest: 1,040
- Regular files: 1,016
- Repository-relative symbolic links: 24
- Uncompressed source bytes: 20,828,984
- ZIP bytes: 5,427,171
- ZIP SHA-256: `c23e54d63e60357fc317cfe66b373c3ddf80cae9de236c26a5463fd833631668`
- Internal and external manifest bytes: 136,118
- Manifest SHA-256: `9f7a6eef8f43ad0081d4e0914bb40168b773a1315368d6bdb8e1d4342aa16ee3`

The archive was built from `git ls-files -co --exclude-standard`. It did not traverse ignored state. The packer rejected Git metadata, dependencies, build output, cache, database, runtime/browser state, credential files, unsafe paths, and links outside the repository. The earlier self-referential `SOURCE-ARCHIVE-ISSUE-43-FINAL.md` was also excluded by the existing deterministic packer.

## Integrity verification

- `unzip -t`: passed for every member.
- The archive's `SOURCE-MANIFEST.sha256` is byte-identical to the external manifest.
- A fresh extraction independently checked every manifest entry's type, byte count, and SHA-256: 1,040 of 1,040 passed.
- The verified totals were 1,016 files, 24 symbolic links, and 20,828,984 source bytes.
- A filename audit found no `.env`, `.dev.vars`, `.npmrc`, `.netrc`, private-key container, database, cookie store, browser state, or `wrangler.dev.jsonc` member.

## Secret scan

Gitleaks 8.30.1 scanned the fresh extraction with redaction enabled.

- Default rules found nine known synthetic test/localization fixtures: seven `generic-api-key` matches and two `cloudflare-api-key` text matches.
- Each match was manually classified by rule, exact repository path, and line. The values are fake billing method identifiers, deliberate credential-rejection fixtures, or UI copy that names a token field. They are not usable credentials.
- The reviewed scan used only the existing narrow rule-and-path allowlist in `gitleaks-issue-44.toml`.
- Reviewed result: zero findings, exit code 0.
- A separate high-confidence pattern check found one already-reviewed fake `sk-live-...` credential-rejection fixture and no private key, AWS access key, Slack token, or OpenAI-style live credential.

Redacted scan reports and the deterministic external manifest are stored under `.codex-artifacts/usage-credits/` outside the source archive.

## Scope note

This is a local, uncommitted snapshot for external engineering review. It is not proof that GitHub Issue #46, its blockers, or parent Issue #42 is complete. ChatGPT Pro cannot infer repository access, production state, deployment, or provider validation from this archive.
