# Scheduled agent automations: implementation tasks

Status: approved; implementation complete through T13; local feature verification complete; operational release gates remain open. Verification: [verification.md](verification.md). [Plan](plan.md) · [Feature contract](../docs/architecture/automations/FEATURE_SPEC.md).

File lists below are the approved planning budgets; actual source/evidence files are mapped in verification.md. Keep each increment small; split tasks if integration exceeds the stated file budget. Do not execute real scheduled business actions as part of a development spike.

- [x] **T01 — Prove Temporal/runtime recovery capabilities.**
  - Acceptance: isolated Temporal Schedule starts a test Workflow; native runtime acceptance lookup is characterized; approval/tool/root/missed-slot evidence limits are documented.
  - Verify: controlled receipt-loss/restart traces; calendar/interval metadata probe on a real dev server; Node/target-architecture SDK build.
  - Depends: scope/default review. Files: a disposable harness and capability report under `docs/architecture/automations/` (2–3 files).

- [x] **T02 — Define shared automation contracts.**
  - Acceptance: validated agent/prompt/trigger/timezone/limits; outcome versus stop-state versus reason modeled explicitly; audit and revision/run correlation contracts defined.
  - Verify: validation/state tests cover malformed times, zones, limits and impossible transitions.
  - Depends: T01. Files: `shared/automations.ts`, `platform/test/automation-contracts.test.ts` (2).

- [x] **T03 — Persist reviewed recipes, run identities and audit.**
  - Acceptance: tenant collections and unique indexes; immutable revisions and atomic execution fence; idempotent append-only audit with safe metadata and pending control/start intents.
  - Verify: real Mongo race/duplicate/replay tests including cross-tenant isolation and audit-write refusal.
  - Depends: T02. Files: `platform/src/automation/store.ts`, `platform/src/store.ts`, `platform/test/automation-store.test.ts` (3).

- [x] **T04 — Enforce unattended recipe authorization.**
  - Acceptance: approved multi-step recipe executes within scope; a new human request stops with a durable reason before any auto-answer/approval-mode/native-default branch; interactive chats retain existing behavior.
  - Verify: approval/input/timeout/secret/native-denial tests and existing approval-mode tests; helper policy inheritance or explicit disablement.
  - Depends: T02. Files: `agent-core/src/requests.ts`, `agent-core/src/business-runtime.ts`, `agent-core/src/manager.ts`, `agent-core/test/automation-policy.test.ts` (4).

- [x] **T05 — Preserve automation execution evidence.**
  - Acceptance: request/denial, selected tool/step and exact root-terminal evidence are durable; ingestion persists audit/outcome evidence before acknowledgment; duplicate/early events converge without helper confusion.
  - Verify: crash before/after ack and event-replay tests; browser disconnected; redaction and incomplete-audit behavior.
  - Depends: T03–T04. Files: `agent-core/src/manager.ts`, `platform/src/service.ts`, `platform/src/automation/evidence.ts`, focused evidence tests in both packages (5).

- [x] **Checkpoint A — Safe execution foundations.** Validate current ownership/tenancy/approval regressions; demonstrate no timeout consent and durable early root evidence. Split additional protocol plumbing into a separate task if T04/T05 require it.

- [x] **T06 — Add reconciled owner-scoped execution adapter.**
  - Acceptance: current owner/agent/project/connector permissions checked; stable provision/submit operations recover the same session/root; ambiguous acknowledgment retains fence and prevents redispatch.
  - Verify: lost receipt and permission-revocation tests against the pinned runtime; same-operation duplicate and native refusal cases.
  - Depends: T03–T05. Files: `platform/src/automation/execution.ts`, `platform/src/service.ts`, `platform/src/runtime-transport.ts`, `platform/test/automation-execution.test.ts` (4; split if manager-side acceptance plumbing is needed).

- [x] **T07 — Run one durable automation Workflow.**
  - Acceptance: finite Workflow admits/executes/observes/persists real outcome; bounded timeouts/retries and pending-start recovery; worker restart observes the same root execution.
  - Verify: Workflow replay/fault tests plus isolated real server/runtime run; missing result, tool blocker and unknown outcome never become success.
  - Depends: T06. Files: `platform/src/automation/{workflows,activities,worker}.ts`, `platform/test/automation-workflow.test.ts`, `platform/package.json` (5).

- [x] **T08 — Create a recipe and test Run now end to end.**
  - Acceptance: authenticated service/API saves and enables a reviewed recipe; simple agent/prompt UI can Run now with request idempotency; actual status/result is visible after browser closure.
  - Verify: scoped API tests and real browser create/test journey; repeat request key returns same run.
  - Depends: T07. Files: `platform/src/automation/service.ts`, `platform/src/index.ts`, `frontend/lib/automations.ts`, `frontend/components/automations/editor.tsx`, one integration test (5; split sidebar wiring if needed).

- [x] **Checkpoint B — Real unattended outcome.** A configured agent/connector completes a reviewed read-only recipe; approval/dependency/error runs are visibly unsuccessful; receipt loss is unknown; actual output and audit are linked.

- [x] **T09 — Add anchored interval scheduling.**
  - Acceptance: native Temporal interval and desired/applied sync; next-five preview, explicit start anchor and interval selector; Run now does not move cadence and busy occurrence is audited.
  - Verify: real Schedule test across restart, repeated control request and manual/scheduled race; actual dispatch lag recorded.
  - Depends: T08. Files: `platform/src/automation/temporal.ts`, `platform/src/automation/service.ts`, `frontend/components/automations/editor.tsx`, focused schedule test (4).

- [x] **T10 — Add timezone calendar schedules.**
  - Acceptance: selected weekdays/local time/IANA zone validated and applied; next-five preview agrees with execution semantics; DST gap/repeated times and lateness policy are explicit.
  - Verify: real calendar Schedule tests, timezone fixtures and late worker pickup; honest missed-window summaries where exact slots are unavailable.
  - Depends: T09. Files: `platform/src/automation/temporal.ts`, `shared/automations.ts`, `frontend/components/automations/editor.tsx`, calendar integration test (4).

- [x] **T11 — Deliver versioned lifecycle controls.**
  - Acceptance: pause/resume/edit/archive reject stale dispatch and re-enable executable revisions; explicit cancellation waits for stop evidence; human/permanent dependency failures leave the schedule enabled with native pause-on-failure disabled, and each subsequent occurrence rechecks current conditions.
  - Verify: enable/edit/pause races, delayed stale control write, cancel while preparing/running and unconfirmed termination tests; approval/permanent-dependency failure followed by another scheduled occurrence proves the schedule stays enabled and distinct run outcomes are audited.
  - Depends: T10. Files: `platform/src/automation/service.ts`, `platform/src/automation/temporal.ts`, `platform/src/automation/workflows.ts`, `frontend/components/automations/controls.tsx`, control integration test (5).

- [ ] **Checkpoint C — Scheduling and control correctness.** Under healthy pilot load meet the proposed timing target; verify preview/cadence/DST, no overlap, no stale dispatch, pause separate from cancellation, and recurrence remaining enabled after failed approval/dependency runs. Unknown prior execution yields a visible skip without changing the schedule's enabled state.

- [x] **T12 — Show detailed run audit and repair actions.**
  - Acceptance: result header and event timeline expose scheduled/actual timing, steps/tools, attempts, request reasons, outputs and partial effects; Needs your action panel gives concrete correction; linked new retry is forbidden while execution is uncertain.
  - Verify: API authorization and browser scenarios for success, approval, dependency, partial failure, unknown and incomplete audit; accessible mobile layout.
  - Depends: T11. Files: `platform/src/automation/service.ts`, `frontend/components/automations/{list,run-details}.tsx`, `frontend/lib/automations.ts`, one focused UI/API test (5).

- [x] **T13 — Add audit filtering, export and attention notices.**
  - Acceptance: paginated date/status history and authorized sanitized CSV; in-app unread failure/attention indication; no raw secrets and identity switch clears state.
  - Verify: pagination/access/redaction tests and browser export/identity-switch check; immutable event replay produces no duplicate rows/notices.
  - Depends: T12. Files: `platform/src/automation/service.ts`, `platform/src/automation/export.ts`, `frontend/components/automations/run-history.tsx`, `frontend/lib/automations.ts`, export/history test (5).

- [ ] **T14 — Reconcile control, run and audit after failures.**
  - Acceptance: pending starts/sync and orphan outcomes recover idempotently; evidence loss/uncertainty stays explicit and fenced; stale starts/backlog remain bounded with health metrics.
  - Verify: kill API/worker/runtime, disconnect Temporal/Mongo, lose receipts and delay ack on a real isolated stack; rollback stops new dispatch without discarding evidence.
  - Depends: T13. Files: `platform/src/automation/reconciliation.ts`, `platform/src/automation/worker.ts`, `platform/src/automation/store.ts`, recovery test, operations notes (5).

- [ ] **Checkpoint D — Acceptance and failure drills.** Verify all nine feature acceptance criteria, existing chat regression suites, audit completeness/redaction and tenant boundaries. Record actual commands and environment; no mock-only readiness claim.

- [ ] **T15 — Package Temporal and perform a limited pilot.**
  - Acceptance: pinned worker/server/persistence deployment and graceful drain; private authenticated access plus backup/restore/upgrade/rollback runbook; feature-flagged read-only pilot with timing/volume measurements.
  - Verify: target-architecture image build, restore/restart exercise, real configured recipe and human/dependency failure cases, final builds/tests and applicable pre-push review before any PR/release.
  - Depends: T14 and deployment authorization. Files: deployment configuration, worker packaging, runbook and pilot evidence (3–5; split production infrastructure rollout from app packaging as needed).

- [ ] **Final checkpoint — Reviewable release readiness.** Link each acceptance criterion to evidence, document remaining risks/product decisions, and obtain explicit authorization for any deployment or broader rollout. Planning does not authorize infrastructure changes or scheduling real agent actions.

## Current acceptance gates

- T01–T13 implementation and automated/local browser checks are complete. Checked tasks do not certify production deployment.
- Checkpoint B: configured live provider/native agent passed manual and scheduled exact-output pilots; actual scoped Qlik read-only connector/root/output verification passed.
- Checkpoint C: native timing, concurrency/control/DST tests pass; one isolated live scheduled recipe measured 354 ms dispatch lag. Sustained/load measurement remains unverified.
- T14: reconciliation implementation and deterministic receipt/audit/replay/control fault tests pass; native persisted-server graceful restart passes. Unclean outage and production restore drills remain open.
- T15: pinned compose/worker and runbook delivered. Local arm64 TypeScript/native SDK checks pass. Docker image build/start and PostgreSQL backup/restore are blocked by the unavailable Docker daemon.
- Final checkpoint: deployment/rollout remains unperformed; no production readiness certification. Final command results and acceptance mapping are recorded in verification.md.
