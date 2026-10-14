# Platform structural migration verification

Date: 2026-10-14. Original revision: `e84a2e4d3f23d572569f741f231b6515b768c68a`.

Scope: platform source organization and unchanged-body extractions. Code refactoring, performance fixes, public API/schema/auth policy changes and deployment are excluded. Current module ownership and request flows: [platform/README.md](../platform/README.md).

## Structural outcome

- All platform source modules are organized by responsibility; `src/index.ts` is the only top-level source file and remains the executable entrypoint.
- Startup/security/shutdown and full-path API registration are separated. The SSE endpoint remains one complete lifecycle unit.
- Five contained feature collaborators replace corresponding blocks in PlatformService; its constructor, public methods/properties, runtime dispatch/recovery/ingestion state and dynamic callback semantics are preserved.
- Public projections, event transformation/decoding, persistence document/index definitions and plan/event writes have named owners. Temporary root aggregation modules were removed; consumers import their canonical owners.
- No collection/schema/index/protocol/dependency or production startup-command changes. One additive package command runs the compiled-artifact smoke check.
- All 47 original test files remain discovered. Two guard suites add eleven tests: 49 files and 316 tests total.

## Results

| Check                                          | Result                                                                                                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline platform suite                        | 304 passed, 1 failed, 0 skipped; 305 tests                                                                                                                            |
| Final platform suite                           | 315 passed, the same 1 failed, 0 skipped; 316 tests                                                                                                                   |
| Agent-core suite                               | 207 passed, 0 failed/skipped                                                                                                                                          |
| Model-gateway suite                            | 68 passed, 0 failed/skipped                                                                                                                                           |
| Frontend suite                                 | 399 passed, 0 failed/skipped                                                                                                                                          |
| Full repository build                          | Passed: agent-core, platform, model-gateway and frontend                                                                                                              |
| Frontend typecheck after build                 | Passed; build regenerated stale local `.next` types. Generated tracked frontend declarations were restored to avoid an unrelated source change                        |
| Platform strict source compilation             | Passed                                                                                                                                                                |
| Explicit guard/verifier/smoke TypeScript check | Passed                                                                                                                                                                |
| Compiled JavaScript smoke                      | Passed: health, metadata/cache headers, capability/foreign-origin refusals, create/send, duplicate receipt without second dispatch, Mongo receipt and clean shutdown  |
| Source preservation audit                      | Passed: 50 route call bodies, all 80 original service method bodies/signatures/defaults, all wrapper argument forwarding and fully expanded bootstrap statement order |
| Public/persistence preservation audit          | Passed: 93 original executable declarations/method bodies/initializers                                                                                                |
| Test file inventory                            | No missing original test files; two new guard suites                                                                                                                  |
| Secrets check                                  | Passed                                                                                                                                                                |
| Whitespace/diff check                          | Passed                                                                                                                                                                |
| Root format check                              | Still fails on 42 pre-existing files, compared with 45 before; zero newly failing file paths after mapping moved files                                                |
| Docker build/container smoke                   | Not run: Docker daemon unavailable (`/Users/ashok/.docker/run/docker.sock` missing)                                                                                   |

The source audits compare parsed executable bodies, rather than trusting visual file moves. The five explicitly reviewed receiver aliases preserve dynamic calls back through the facade. Added control tests reject a missing/wrong access check, empty/duplicate route discovery, neighboring-route/comment false positives, changed forwarding, and changed registration order. Existing behavioral authorization tests remain intact.

Historical first-send, configuration and HTTP diagnostic probes also passed with isolated fixtures. Tooling source-path resolution supports both legacy and organized checkout layouts, and browser fixture imports point to their canonical owners.

## Existing failure and limits

`platform/test/safety.test.ts` fails the demo-provisioning assertion that expects `/cannot be the implicit "default"/`. The command currently returns `public signup cannot use the implicit legacy "default" tenant`. The same mismatch occurred before any source change. Neither the command nor the assertion was changed to make this structural migration green.

The format failures are existing issues in untouched portions of the repository; they were not broadly reformatted. These baseline failures remain visible, so this report does not claim all repository gates are green or certify merge/deployment readiness.

The compiled smoke and diagnostic probes use isolated fixtures, not live providers. Diagnostic probes were exercised to verify tooling compatibility, not to certify performance. Docker packaging startup still needs validation when the daemon is available. No production deployment, production latency/capacity benchmark or post-deployment observation was performed.

Contained collaborators share the facade's readonly Store/hosts/settings references, and callback dependencies resolve facade methods at call time. In-place mutation and supported method overrides are retained. Forced reassignment of readonly references through untyped JavaScript is not used by any repository consumer. Stack source paths and promise-adoption details naturally change with delegation; original internal error handling and awaits remain unchanged.

## Reproduce the checks

From repository root:

```sh
npm --prefix platform test
npm --prefix agent-core test
npm --prefix model-gateway test
npm --prefix frontend test
npm run build
npm --prefix frontend run typecheck
npm --prefix platform run test:compiled
npm run format:check
npm run check:secrets
git diff --check
```

To reproduce the explicit structural AST audit, extract `platform/src` from the original revision to an isolated directory and pass that source directory to `platform/test/verify-structure.ts`. During implementation it ran against `/tmp/truex-platform-structure-baseline/src`. This verifier is an explicit review tool; ordinary tests do not depend on that temporary snapshot.

The tracked verifier also matches each original public/persistence executable declaration to its new owner with whitespace/comments/trailing commas ignored; the Store wrappers were checked against extracted `savePlan`/`persist` bodies. Peer review also confirmed a single Store definition, single tenant/user/request context instances, single public regex/constants, and no new runtime cycles in the public/persistence/streaming graph.

## Rollback and next work

Rollback is a code/image rollback; persisted data was not migrated. Further separation of history/ingestion/session orchestration and performance changes are separate work, with the current facades and regression suites retained as the compatibility boundary.
