# Individual helper Stop: implementation and verification

Implemented on `agent-core-update-v2`; review time 2026-10-05T22:52:33.081941+00:00. Base HEAD `e44b79e9c5eea2b5de000a0cfca6ffff8a5821ec`; working tree uncommitted. Snapshot digest of 30 changed/new application files (sorted paths plus content SHA-256; excludes reports): `d5e243c81bd88df2412a32d9f585e58daa67ab55403a84b381a54386d86dc47c`. Contracts remain optional/additive; no dependencies, native pin, or database schema changed. Codex pin remains `4a942885c8b4745757a9f86ad2075e16c42483c5`.

## Result

Individual helper Stop has bounded native interruption, acknowledged shutdown, inactive metadata reconciliation, duplicate coalescing, durable retry intent, restart recovery, and visible pending/unconfirmed/retry states in both helper controls. Only the selected helper's native subtree is stopped: its parent conversation, active root goal, and siblings continue. Goal Pause keeps its existing graceful behavior.

Previously interruptAgent returned success after an interrupt ACK and swallowed archive failures. It now returns an authoritative projected terminal helper. Core and platform reject uncertainty; the frontend rejects bare ACKs and mismatched helper responses. A natural terminal notification retains pending/unconfirmed Stop until reconciliation succeeds. Partial helper output remains available; stopped-turn events cannot reopen the helper.

Helper recovery lives under `helper-stop-intents/<rootId>/<helperId>.json`, with validated ownership, restrictive permissions and atomic fsync writes. Intent is saved before cancellation. Failures remain retryable and do not change parent state. Cold resume retries saved helper Stop without native-resuming the helper or replaying model input. Corrupt storage repeatedly fails closed. Recovery requires the same durable runtime home across restarts.

Native archive shuts down descendants of the selected helper. Reconciliation includes known descendants and new turns/helpers found while Stop runs; stable metadata is required. Conversation-wide Stop absorbs outstanding helper intents, including when the parent has already become idle. Conversation deletion/archive cannot discard unresolved helper ownership. Buffered notifications from failed or replaced runtime processes are fenced before parsing/dispatch.

## Verification

Node 24.21.0; commands from the repository root unless noted. All final suites have zero failures/skips: **623 tests passed** (agent-core 211, platform 154, model-gateway 58, frontend 200).

| Gate | Outcome and evidence |
| --- | --- |
| Core/platform/gateway full suites | PASS: root `npm test`, followed by final `npm --prefix agent-core test` after idle-parent recovery refinement. Logs `/tmp/truex-helper-final-tests.log`, `/tmp/truex-helper-final-core.log`. |
| Frontend full suite | PASS: `npm --prefix frontend test`, 200 tests; `/tmp/truex-helper-stop-frontend-tests.log`. |
| Four application production builds | PASS: root `npm run build`; final core `npm --prefix agent-core run build` after last refinement. Logs `/tmp/truex-helper-final-build.log`, `/tmp/truex-helper-final-core-build.log`. Frontend typecheck also passed. |
| New helper manager regressions | PASS: 15 tests covering failures, bounded hangs, duplicate calls, initialization, restart, ownership, late subtree/turn discovery, natural completion, generation changes, corrupt/unwritable markers, root Stop absorption and deletion guards. |
| Actual pinned native lifecycle | PASS: new helper native regression plus two existing root Stop native regressions. Real native spawn_agent, local Responses fixture; lost helper completion still settles; native root remains active with active root goal; no model replay. New test reproduced the previous shutdown/status failure. |
| Runtime transport regression | PASS: failed-child stdout test fails without the fence; stale frames before/after replacement are discarded and current RPCs remain intact. |
| Ownership/public boundary | PASS: nonowners/admin write denial before runtime dispatch; matching projected terminal response required; private recovery state never exposed. |
| Frontend lifecycle regressions | PASS: pending/retry, terminal uncertainty, stale replay, sibling preservation, ACK-only/mismatched helper rejection; session/generation/attempt fences reviewed. |
| Diff review | PASS: `git diff --check`; scoped adversarial review completed. No new dependencies or configuration changes. |
| Formatting | Repository gate FAIL: 59 existing files. Each failing file was checked using its HEAD contents: all 59 already fail; zero newly failing files. New helper/core/contract/reducer modules pass targeted formatting. Existing formatting in touched service/ownership/UI files was preserved. |
| Production dependency audit | Core/gateway/frontend aside from Next: no production findings. Platform has two high findings (`multer`, dependent `@nestjs/platform-express`); frontend has one critical `next` finding. Existing manifests/lockfiles unchanged. Sources: per-project `npm audit --omit=dev --json`; logs `/tmp/truex-helper-audit-*.json`. No forced upgrades. |
| Browser UI | UNVERIFIED for this helper change. Reducer, type/build and native lifecycle checks passed; previous conversation-wide Stop browser evidence is separate. |
| Live providers/MCP effects, load, deployment | UNVERIFIED and outside this local implementation. Native tests use a local provider fixture, not customer connectors. |

## Risks and operational impact

Stop confirms observed native inactivity; it cannot undo connector actions already sent. Native archive removes runtime membership and has a bounded shutdown wait, so inactive/notLoaded metadata is not proof that every remote side effect has ceased. Explicit later helper resume remains native behavior; recovery itself never resumes that helper. No shared runtime restart is used for a helper Stop.

Default stop work uses a 10-second interruption phase plus a 5-second reconciliation phase. Helpers in the selected subtree are reconciled with bounded requests. No production latency/capacity claim is made. Polling avoids repeated durable writes for unchanged intent. There is no database migration.

For a coordinated deployment, update core, then platform, then frontend: a new platform/frontend facing an old ACK-only response fails closed with retryable uncertainty. Preserve runtime-home storage. Settle pending helper/root intents before rolling back to a core that does not understand them; retain backups. Observe structured helper confirmed/unconfirmed logs and persisted intent counts. No commit, push, PR, deployment, or live data mutation was performed; temporary native fixtures clean up their services/processes.

## Readiness decision

Requested implementation is complete and local functional/build checks pass. **GitHub/release readiness remains BLOCKED** by existing repository formatting/dependency findings and missing `PRE_PUSH_CHECKLIST.md` in this workspace or its ancestors. The verify-before-push skill was read and applied; another project's checklist was not substituted. Remote CI/reviewer approval and production operational evidence were not requested or verified. These are existing/unverified shipping gates, not hidden test failures in the implemented behavior.
