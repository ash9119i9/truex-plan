# Prompt-cache pre-push review — 2026-10-02

## Decision and scope

**BLOCKED for checklist-based readiness certification.** The workspace's
`PRE_PUSH_CHECKLIST.md` could not be found in this repository or its ancestors,
and the platform dependency audit has two existing high-severity package findings.
This report does not certify merge or production release readiness.

The user explicitly requested preserving the current implementation and test
notes, committing and pushing the feature branch, and retesting later with a new
model provider. Feature-branch publication does not enable cache options, modify
stored provider configuration, merge or deploy this change. Provider verification
remains pending in [the retest note](../docs/PROMPT_CACHE_RETEST.md).

Repository: `/Users/ashok/truex-plan`. Branch: `feat/application-prompt-caching`.
Baseline and verified remote main: `2417dff195b22f19b3dc5c29a48d6a30d3c02354`.
The reviewed candidate is the uncommitted snapshot identified below; the report
itself is excluded from its own digest manifest. Unrelated dirty `.claude/worktrees`
entries are excluded from this change and left intact.

## Findings

1. **Required checklist unavailable — UNVERIFIED.** Searched the workspace and
   `/Users/ashok`, `/Users`, `/`. Do not substitute another project's checklist.
2. **Existing dependency findings — high.** `npm --prefix platform audit --json`
   returned exit 1 with two high-severity package findings in
   `@nestjs/platform-express` / `multer` (installed versions 11.2.5 / 2.2.0).
   All three service lockfiles are byte-identical to the baseline; this change
   introduces no dependency updates. Remediation needs a separate scoped dependency
   change and validation. Gateway and agent-core audits reported zero findings.
3. **Live cache savings and full quality equivalence remain unverified.** Existing
   live evidence is preserved; no paid provider benchmark was rerun during this
   review because the user deferred it until a new provider is available.
4. **Scanner coverage limited.** No dedicated secret scanner was installed.
   Manual source/report review and a local credential-pattern/sensitive-JSON-field
   scan found no credentials in candidate files; this is not comprehensive scanner
   certification. Reports contain synthetic answers, counts, ids and hashes.
5. **Validation hardening incorporated.** Enum fields now require literal strings;
   arrays and objects cannot pass by string coercion. Regression cases pass in
   the gateway suite. This validation-only fix postdates the saved live snapshots
   and does not change valid-policy request content or generation settings.

## Verification matrix

Environment: Node v24.21.0, npm 11.19.0. Commands run from the repository root
unless noted. Current code builds and the gateway checks ran on 2026-10-02 UTC;
previous full platform results are identified separately rather than presented as
new executions.

| Gate                              | Command / evidence                                                                                                                                                                                 | Result                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Gateway build                     | `npm --prefix model-gateway run build`; start 13:36:49 UTC, exit 0                                                                                                                                 | PASS                                            |
| Gateway suite                     | `npm --prefix model-gateway test`; start 13:36:50 UTC, exit 0; 64 passed, none skipped                                                                                                             | PASS                                            |
| Platform build                    | `npm --prefix platform run build`; start 13:36:51 UTC, exit 0                                                                                                                                      | PASS                                            |
| Agent-core build                  | `npm --prefix agent-core run build`; start 13:36:52 UTC, exit 0                                                                                                                                    | PASS                                            |
| Pinned source                     | `npm run codex:verify`; start 13:36:54 UTC, exit 0; unchanged pin `4a942885c8b4745757a9f86ad2075e16c42483c5`                                                                                       | PASS                                            |
| Runtime gateway compatibility     | `./node_modules/.bin/tsx --test test/gateway-anthropic-runtime.test.ts test/gateway-runtime.test.ts test/gateway-gemini-runtime.test.ts` in `agent-core`; 3 passed, none skipped                   | PASS                                            |
| Platform full suite               | Earlier same-session `npm --prefix platform test`, exit 0; 142 passed, none skipped; platform source unchanged since that run                                                                      | PASS, prior evidence reused                     |
| Benchmark script types            | Gateway TypeScript CLI with `--noEmit --target es2022 --module commonjs --moduleResolution node --esModuleInterop --skipLibCheck --strict model-gateway/scripts/benchmark-prompt-cache.ts`; exit 0 | PASS                                            |
| Formatting                        | Root Prettier CLI `--check` for changed code, configuration and notes; exit 0                                                                                                                      | PASS                                            |
| Links                             | All local links in the caching guide, results and retest note resolve                                                                                                                              | PASS                                            |
| Gateway dependency audit          | `npm --prefix model-gateway audit --json`, npm 11.19.0 / registry advisory database; exit 0, zero findings                                                                                         | PASS                                            |
| Agent-core dependency audit       | `npm --prefix agent-core audit --json`; exit 0, zero findings                                                                                                                                      | PASS                                            |
| Platform dependency audit         | `npm --prefix platform audit --json`; exit 1, two high findings                                                                                                                                    | FAIL, pre-existing                              |
| Manual secret review / local scan | 26 candidate files; credential patterns and sensitive report JSON fields; zero findings                                                                                                            | PASS within stated limits                       |
| Dedicated secret scanner          | Neither `gitleaks` nor `trufflehog` installed                                                                                                                                                      | UNVERIFIED                                      |
| Workspace checklist               | No applicable `PRE_PUSH_CHECKLIST.md` found                                                                                                                                                        | UNVERIFIED                                      |
| Workspace integration script      | No `verify-integration.mjs` present; gateway runtime integration exercised instead                                                                                                                 | UNVERIFIED for missing checklist's requirements |
| Frontend                          | No UI or public thread-contract changes                                                                                                                                                            | N/A                                             |
| Dependency install                | Existing dependencies present; all lockfiles unchanged                                                                                                                                             | N/A, no reinstall                               |
| Remote CI and review              | No PR created; no `.github/workflows` in this repository; no remote CI or review result claimed                                                                                                    | UNVERIFIED                                      |
| New provider benchmark            | Explicitly deferred until provider configuration is available                                                                                                                                      | PENDING                                         |

Runtime integration uses the real pinned binary with simulated local upstreams;
it verifies compatibility, not real provider pricing/performance. Teardown warnings
were not test failures. Temporary runtime test services were closed.

## Source review and snapshot identity

Reviewed provider-specific configuration validation, authenticated tenant-derived
cache key scopes, absence of cache settings on unconfigured Chat profiles,
unchanged Anthropic defaults, prompt/tool content equivalence, usage translation,
log sanitation, request cancellation/timeouts and benchmark lifecycle cleanup.
Public thread contracts and the pinned runtime source were not changed.

Snapshot manifest SHA-256: `12d39beb819a47f5c8bb1d87c629022b184acbef763c9ebee53e27a40036609a`.
Review recorded: `2026-10-02T13:40:59.120384+00:00`.

```json
{
  "README.md": "1eccbae9130bda012c707b319c4343913ddcf0e180ec39c431c5bce8e9e68fe2",
  "benchmark-reports/PROMPT_CACHE_RESULTS.md": "f82f4fbdf62c427a7bc034df3172362882b9ea98562bda37e27286f7f2c2564f",
  "benchmark-reports/prompt-cache-controlled-live-2026-10-02.json": "c78dc3eb6bf1b786b9fdd817f2b1871b05526211aefd9be11757e3d708aa182c",
  "benchmark-reports/prompt-cache-controlled-live-2026-10-02.md": "c09075842d8303c7a53dcd7a9655871bf75c3b04843741a0c0d4fbafb7c416fe",
  "benchmark-reports/prompt-cache-controlled-retry-live-2026-10-02.json": "cd3376b32b13d8ca69cf95267d515cfc769e232e2f0d115babd5563511f6a5fe",
  "benchmark-reports/prompt-cache-controlled-retry-live-2026-10-02.md": "109a4cb0d109755b21957a8a8d386f47c61a44292774b5ed6266468f34e21bee",
  "benchmark-reports/prompt-cache-defaults-live-2026-10-02.json": "132e63c43903f854234f2e9805dc8833ab7ded710934b7e1d87858d34a75bd95",
  "benchmark-reports/prompt-cache-defaults-live-2026-10-02.md": "68f728144043000d396d2bbddb8e49cf12749154de00562c79074c939cd8bef7",
  "benchmark-reports/prompt-cache-live-2026-10-02.json": "eae4be135407413746f5d4f17227be4d9bcf229519565fd85c95448acc8e4ad2",
  "benchmark-reports/prompt-cache-live-2026-10-02.md": "b0ac8364184f09da8addd54bfecd71f4f376abf91893f42bee52d0232173a00b",
  "docs/PROMPT_CACHE_RETEST.md": "3e4032deb1af1538786ba86d990449833b823f3e11eb4070f6264f9a953605c4",
  "docs/PROMPT_CACHING.md": "20663ce2150fc98952509b6207f6664ff170a35de121d187f7b2e6c8cb3a0104",
  "model-gateway/package.json": "31f3e33348bfcdaaec921c8fcf939f1c5912951b8f649b4e3acfaafc4285b36b",
  "model-gateway/scripts/benchmark-prompt-cache.ts": "2c41d149c8765746ca858a45d559a8a07c40bc9c0da91f7b3f567ebcc666f307",
  "model-gateway/src/adapter.ts": "c07297a5b40961e69e2d4fdd9a33856efe61aa8647c271e31f337ac5fb2c055c",
  "model-gateway/src/adapters/anthropic.ts": "524e3b05488cf6dfc89442b4edb36720758c0073835fa176845a643468eef437",
  "model-gateway/src/adapters/chat.ts": "ef6f6d2f874484e89380b2ab9c3206675ae8344c09471198da51633f0ba364f4",
  "model-gateway/src/logging.ts": "3dde2585ca7b03190b5947e2ef839a0415fee011ddc47d0dde86673564863ddf",
  "model-gateway/src/prompt-cache.ts": "64d5c64d3dfe86710fe7d3f8699fd930cbe7a5084a92d7f215804947450b1311",
  "model-gateway/src/responses.ts": "364d00da06cb05bc56b72f114000bbe8f1c9f3d596a14f0e7e5a6673394f441e",
  "model-gateway/src/server.ts": "816b8c254f3ae4270e5704ab63378abb755a01ac544fb3babd0c8c1129deef86",
  "model-gateway/test/anthropic.test.ts": "5d264c3fc5cbab4b42b333e088ab067dc4261f5e1b096212c8da65c4daa8a607",
  "model-gateway/test/observability.test.ts": "e1493bf3af9032c26df661b81d1b615939ed192288844bf92f9f0cb70c2b63ee",
  "model-gateway/test/prompt-cache.test.ts": "d1deca16c27aa368f7330de0a4a38baf164a5483de99ab9c6047ea18de2949d5",
  "platform/src/documents.ts": "6dfdba2ae47474d64683107e00cd7fd02a565febbd1e7d52dd0b0acd79288f42",
  "shared/prompt-cache.ts": "1db9f21daa3e91201fedfc627f4c8bb1e915d303aa31b357a65c460172fe8f87"
}
```

## Pending work

Retest with the new provider using actual cache counters and billing policy,
verify quality/final-answer behavior, and record the enablement decision. The
existing proxy results do not establish savings. Restore the workspace checklist
and resolve the existing platform audit findings before declaring checklist-based
readiness. Nothing in this report grants production release certification.
