# Combined restructuring verification — 2026-10-14

## Scope and acceptance criteria

Merge `platform-restructure` (`4333e3f247f3f93e41e2b9f50a13fc2a6070a415`) into `agent-core-restructure` (previous tip `5c150fc`). Both branches started from `e84a2e4d3f23d572569f741f231b6515b768c68a`.

Acceptance criteria: retain existing HTTP/protocol behavior, runtime and tenant state ownership, persistence formats, authorization, dispatch ordering and executable paths; migrate repository consumers to canonical module owners; remove only proven unused code and obsolete reexport files. Optimization and business-logic changes are outside this work.

## Integration and cleanup

- Platform source is organized by feature and responsibility as documented in [platform/README.md](../platform/README.md). Agent-core retains the organization documented in [agent-core/README.md](../agent-core/README.md).
- The only merge conflicts were the two branches' independent `tasks/plan.md` and `tasks/todo.md`. Agent-core's versions remain at those paths. Platform's versions are preserved as `tasks/platform-restructure-plan.md` and `tasks/platform-restructure-todo.md`, with their local links updated.
- Migrated agent-core tests, platform diagnostic scripts/tests and executable performance probes to canonical imports. Tooling relocation mappings retain support for older checkouts. Explicit frozen-checkout imports and historical source paths remain historical.
- Removed 15 agent-core root files containing only reexports: `agentcore-services.ts`, `approval-modes.ts`, `business-runtime.ts`, `client.ts`, `file-tools.ts`, `history.ts`, `manager.ts`, `redact.ts`, `requests.ts`, `schema.ts`, `script-runner.ts`, `tenancy.ts`, `trace.ts`, `workspace-sweeper.ts` and `workspace-tools.ts`. A repository-wide static import/export/require scan found no remaining consumers of these paths before deletion. Their implementations remain in their owning folders.
- Removed the redundant `goalTokenDelta` export from the manager; the implementation and owner export remain in `threads/turn-tracker.ts`. Made the locally used `Clock` and `GoalTokens` interfaces private to `threads/state.ts`.
- Removed unused platform imports, the unreferenced `McpSummary` type alias, and the unused conversation-route `mode` option together with its sole forwarding argument. Authentication mode remains available to middleware and streaming where used.
- Preserved executable entrypoints and shared error classes. No dependencies, lockfiles, protocol schemas, persisted formats or deployment commands changed in the integration cleanup.
- Restored the generated `frontend/next-env.d.ts` changes produced by the build so they do not enter the restructuring diff.

## Behavior and adversarial review

Three subagents independently handled export/test migration, platform consumer migration/review, and dead-code analysis/cross-review. Reviews checked constructors, dynamic service callbacks, tenant-aware Store delegation, security and route ordering, cleanup/shutdown, and deletion side effects. No blocking functional regression was found.

The structural audit against the original platform snapshot passed for all 50 route bodies, all 80 service methods (48 delegated), 93 public/storage bodies and initializers, forwarding arguments and expanded bootstrap order. Constructors and Store wrapper delegation were also reviewed manually because the AST verifier does not cover every constructor/wrapper detail.

All behavioral test assertions remain. Tests that compared obsolete root reexports were removed or narrowed to the still-relevant canonical runtime inheritance assertion. Removing the one test devoted solely to manager/approval reexport identity changes the core count from 217 to 216. Marker availability/error tests, storage-failure tests and early-completion tests remain.

The snapshot benchmark's relocated stream guard still has its deliberate negative control. Its three expected-failure modes passed their harness checks: `--red-tests` observed 4 expected failures, `--sync-red-tests` observed 9, and `--coverage-red-tests` observed 1. The HTTP diagnostic probe still extracts and registers the actual route implementation. These tooling checks did not invoke live providers or run full performance benchmarks.

A final source dependency scan across 106 agent-core/platform TypeScript modules found zero unresolved relative imports and zero runtime import cycles. The remaining old path strings serve relocation mappings or explicit historical fixtures; they are not unresolved live imports.

## Validation results

| Check                                                   | Result                                                                                                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test` — agent-core                                 | 216 passed, 0 failed, 0 skipped                                                                                                                          |
| `npm test` — platform                                   | 315 passed, 1 existing failure, 0 skipped; 316 total                                                                                                     |
| `npm --prefix model-gateway test`                       | 68 passed, 0 failed, 0 skipped; run separately because the root test chain stops at platform's failure                                                   |
| `npm --prefix frontend test`                            | 399 passed, 0 failed, 0 skipped                                                                                                                          |
| `npm run build`                                         | Passed for agent-core, platform, model-gateway and frontend                                                                                              |
| Agent-core and platform `tsc --noEmit`                  | Passed                                                                                                                                                   |
| Agent-core and platform `tsc --noEmit --noUnusedLocals` | Passed                                                                                                                                                   |
| `npm --prefix frontend run typecheck`                   | Passed after the build generated Next types                                                                                                              |
| Platform original-source AST preservation audit         | Passed: 50 routes, 80 methods, 93 public/storage definitions and expanded startup order                                                                  |
| `npm --prefix platform run test:compiled`               | Passed against isolated MongoDB/fake runtime: health, middleware refusal, create/send, duplicate receipts, persistence, clean shutdown                   |
| Both emitted agent-core entrypoints                     | Passed in temporary homes/workspaces: core readiness/health/capabilities, bridge ping/invalid invocation, lazy storage initialization, graceful shutdown |
| `node --test scripts/agentcore-smoke.test.mjs`          | 8 passed, 0 failed; fixture tests, not a deployed AWS smoke test                                                                                         |
| `npm run check:secrets`                                 | Passed                                                                                                                                                   |
| `npm run format:check`                                  | 41 existing warnings; all 41 files are byte-identical to `platform-restructure`                                                                          |
| Working/staged `git diff --check`                       | Passed                                                                                                                                                   |

## Existing failures and limits

The platform safety CLI assertion still expects `/cannot be the implicit "default"/`; the command returns `public signup cannot use the implicit legacy "default" tenant`. This is the same baseline mismatch documented by both earlier restructuring runs, including [the incoming platform report](platform-structure.md). The command and assertion were not changed to make this structural merge pass.

The formatting backlog remains visible. No formatter configuration, check threshold or behavior assertion was weakened. An optional stricter platform `--noUnusedParameters` audit also identifies the existing positional `res` callback parameter in `identity/workspaces.ts`; its handler signature was retained. That flag is not a configured repository gate.

Removed deep import paths are intentionally retired within this private repository. All discoverable repository consumers were migrated; unknown consumers outside the repository cannot be audited here. Runtime/public HTTP contracts and emitted startup paths remain the compatibility targets.

This evidence covers local integration, fixtures, isolated MongoDB and the pinned local runtime. It does not measure production load, prove live provider/AWS operation, or certify production deployment readiness. No push or deployment is part of this work. Reverting the merge is the source rollback path; no data migration is required.
