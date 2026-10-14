# agent-core restructuring evidence

Date: 2026-10-14. Original revision: `e84a2e4`. Status: structural implementation and local verification complete. Core checks pass; repository-wide exceptions are documented below.

## Scope and implementation

The user authorized the plan, then explicitly requested restructuring only, with optimization and logic changes left for later. Existing algorithms, validation, security checks, limits, queues, APIs, configuration, persisted formats and executable paths were preserved.

- Main manager implementation moved to `agent-core/src/threads/manager.ts`: **2,269 -> 1,023 lines**, with state, snapshots, messages, approvals, helper tracking, records, events, SSE and turn tracking in their owning modules.
- Runtime, protocol, telemetry, tools, HTTP, bootstrap and AgentCore bridge code moved into their corresponding folders. The actual map and debugging guide are in `agent-core/README.md`.
- Existing root module paths remain explicit compatibility reexports of identical objects. Production implementation imports canonical owners directly; external platform imports continue working.
- All 28 original test files moved by responsibility. Every byte outside changed relative import specifiers remains identical, and all original import targets are preserved. The demo visualization fixture is unchanged.
- Two additional HTTP/runtime compatibility files and a structural characterization file bring discovery to 31 test files. Recursive discovery was tested with both top-level and deeply nested probes before moving tests.
- `agent-core/package.json` changes only test discovery. Dependencies, lockfiles, shared generated protocol, Dockerfile, compiler settings and other application packages are unchanged.

## Verification results

| Check                                    | Evidence                                                                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original core baseline                   | 207 pass, 0 fail, 0 skipped; original core build passes.                                                                                                                                                                        |
| Restructured source before test grouping | 214 pass, 0 fail, 0 skipped.                                                                                                                                                                                                    |
| Final core suite after grouping          | **217 pass, 0 fail, 0 skipped**, through root sequential `npm test`.                                                                                                                                                            |
| Full platform suite                      | 305 tests: 302 pass, 3 fail (including one parent), 0 skipped; two distinct assertion failures described below.                                                                                                                 |
| State/snapshot/turn extraction           | 62 focused tests pass.                                                                                                                                                                                                          |
| Event storage/SSE extraction             | 59 focused tests pass.                                                                                                                                                                                                          |
| Helper extraction                        | 41 focused tests pass after restoring the original parent-watchdog callback during extraction.                                                                                                                                  |
| Approval extraction                      | 68 focused tests pass.                                                                                                                                                                                                          |
| Tools extraction                         | 81 focused tests pass, including pinned-runtime workspace integration.                                                                                                                                                          |
| HTTP/bridge extraction                   | 9 direct HTTP/bridge tests and 1 platform synchronization test pass.                                                                                                                                                            |
| Structural characterization              | Storage failure and completion-before-start-response tests pass against both original HEAD code in an isolated archive and the extracted manager; compatibility identity test also passes. 3/3 in each implementation.          |
| Runtime test after grouping              | Isolated exact runtime file passes 2/2, 0 skipped.                                                                                                                                                                              |
| Gateway suite                            | 68 pass, 0 fail, 0 skipped.                                                                                                                                                                                                     |
| Build                                    | Root `npm run build` log reaches successful compilation of core, platform, gateway and frontend.                                                                                                                                |
| Compiled entrypoints                     | Both existing emitted entrypoints start and shut down cleanly with temporary storage. Core liveness/readiness, pinned capabilities and repeated health succeed. Bridge ping and invalid invocation leave storage uninitialized. |
| Smoke script tests                       | `node --test scripts/agentcore-smoke.test.mjs`: 8 pass, 0 fail, 0 skipped. This exercises the smoke client with fixtures, not deployed AWS.                                                                                     |
| TypeScript                               | Core `tsc --noEmit` passes after the extractions.                                                                                                                                                                               |
| Scoped formatting                        | All core source/tests, package configuration and README pass Prettier.                                                                                                                                                          |
| Secret scan                              | `npm run check:secrets` passes.                                                                                                                                                                                                 |
| Import direction                         | Static relative import/reexport graph: 58 source files, no cycles, no internal implementation imports through root compatibility facades.                                                                                       |
| Diff                                     | `git diff --check` passes; original test hashes/import targets and demo fixture were checked.                                                                                                                                   |

The root formatter reports **44 unchanged files** in platform, frontend and `scripts/migrate-mcp-scopes.mjs`. No files in this refactor fail scoped formatting. These unrelated files were left untouched.

An earlier concurrent broad run was externally interrupted. It recorded one pinned-runtime scenario failure before interruption, but no final assertion detail or suite totals. The exact file subsequently passed in isolation. That interrupted run is not counted as successful verification; the final sequential repository test chain completed the core suite successfully and then stopped on platform assertions, described below. The previously recorded gateway run passed independently.

## Independent source review

Three sub-agents implemented disjoint runtime, HTTP and tool slices. Independent reviews compared extracted code to the original TypeScript AST/text after only explicit receiver/import/dependency substitutions:

- All local HTTP middleware/routes retain their 30 original registration statements and order. Bootstrap/shutdown, AgentCore app and service-launcher bodies match.
- Runtime transport, history, tenancy, schemas, requests, trace and redaction moved intact. Policy/configuration bodies, marker payloads, catches and file modes match.
- Every WorkspaceFiles method and script/sweeper implementation matches; document rendering/extraction branches and storage operations match. Path/open defenses stay together.
- Manager lifecycle, listeners, capabilities and server-request guards match. Message/reasoning projection, snapshots, goal/timing calculations, helper and approval bodies match after explicit owner substitutions.
- Publication remains redaction -> sequence -> synchronous durable write -> replay retention -> broadcast. Storage failure still drains, reports the original event then `STORAGE_UNAVAILABLE`, and disconnects subscribers.
- Reconnect capture through subscriber attachment remains synchronous. Helper permissions use the same BusinessRuntime registry, and approval review revision/single-settlement protections remain intact.

No behavior changes or optimizations were identified in the final independent review. The preserved tests and runtime checks provide additional evidence; this is not a production capacity or security certification.

## Plan execution and scope adjustments

All planned source owners and test groups have been implemented. HTTP routing has a small `routes/` directory; startup/shutdown are separate; goal accounting remains within turn tracking; existing workspace safety methods remain together. No placeholder layers, generic event bus, new abstraction framework or empty planned modules were added.

Compatibility facades are intentionally retained for existing platform/script consumers. Removing those source paths is a separate compatibility cleanup rather than part of a behavior-preserving move.

Additional speculative service-launcher fault tests and expanded stale-approval-race cases from planning were not added to this structural pass. The service launcher and approval protection bodies were moved unchanged and reviewed against the original; existing scenarios remain. No tests or assertions were removed or weakened.

Docker image verification and deployed AWS invocation have not been performed. No image was published, service deployed, database migrated, production record rewritten or live business connector invoked. A later release can use the unchanged Docker build and `npm run agentcore:test -- <test-runtime-arn>` workflow.

## Final repository checks

- [x] `npm test` executed: core 217/217 passes; platform 302/305 passes and the command stops there. Gateway independently passes 68/68. Repository-wide tests are **not fully green**.
- [x] Root build compiles all four packages.
- [x] Compiled local core and AgentCore executable smoke checks pass.
- [x] Scoped formatting, secret scan and diff checks pass.
- [x] Final source/diff, unchanged test/fixture, dependency direction and documentation review completed.

### Repository-wide test exceptions

1. `platform/test/safety.test.ts`, provision-demo: the assertion expects `/cannot be the implicit "default"/`, while the CLI returns `public signup cannot use the implicit legacy "default" tenant`. The exact same assertion fails on an isolated `git archive HEAD` checkout with original code and existing dependencies. Platform/scripts were not changed by this refactor.
2. `platform/test/private-access.test.ts`, nested immutable-creator/agent-limit scenario: the full run did not observe `AGENT_LIMIT` in the parallel creation responses. This also fails its parent, producing two reported failures. The complete private-access file subsequently passes **16/16** on current code, and passes on original HEAD in the focused original-code check. Its cause is unconfirmed; do not claim the refactor fixes it or silently lower the assertion.

The original-code focused check ran 17 tests, with 16 passing and only the provision-demo wording assertion failing. The current-code private-access check ran 16 tests, all passing. These checks used isolated MongoDB fixtures and no production data.

All core/source checks are green. Broader platform behavior fixes, the formatter backlog and production release verification are explicitly outside the user's restructuring-only scope.

Rollback is the previous code/image with the same runtime-home volume; no storage migration is needed.
