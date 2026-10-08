# Implementation plan: scheduled agent automations

Status: approved; implementation and local verification delivered; operational release gates remain open, 9 October 2026. Task list: [todo.md](todo.md). Feature contract: [FEATURE_SPEC.md](../docs/architecture/automations/FEATURE_SPEC.md).

## Outcome and scope

A user selects an agent and prompt, chooses a recurring time/interval and timezone, and receives reliable browser-independent execution plus a clear audit. Human intervention and unresolved required dependencies are unsuccessful unattended outcomes. Temporal is explicitly selected by the user.

MVP includes create/edit/enable, Run now, interval and weekday-time recurrence, preview, pause/resume/archive, cancellation, run history, failure recovery instructions, audit filters/export, and operational recovery. Defer webhooks, automation-management MCP tools, existing-chat queues, arbitrary cron, and generic suspended approvals. One-off execution is an explicit scope decision.

The user approved this specification and plan and authorized implementation on 9 October 2026. Proposed defaults below are the implementation defaults. Production deployment, broader rollout, and real business actions remain separate operational gates. Existing user changes are preserved.

## Architecture decisions

- Native Temporal Schedules → finite per-run Workflow → Activities calling the existing Truex execution boundary. No in-process recurrence timer or second scheduling engine.
- Mongo owns definitions/revisions, desired/applied control state, execution fence, accepted request identity, audit events, and business outcome read models. Explicit tenant/owner contexts are mandatory.
- Fresh agent conversation per run. Saved, reviewed recipe has bounded authorization; per-run unattended policy takes precedence over interactive timeout/approval-mode behavior.
- Reconciliation-aware dispatch and exact root-turn evidence precede recurrence implementation. Temporal durability does not make native agent/connector side effects exactly-once.
- One active agent execution per automation across Run now and scheduled triggers. Busy is an audited skip; uncertain execution retains its fence.
- Product failures/unknowns must be persisted by the automation domain. Confirmed user decision: approval/review and permanent missing dependencies fail only the affected run and leave the schedule enabled. Disable native Temporal Schedule pause-on-failure and any application failure-triggered pause. An unresolved execution fence still prevents overlapping dispatch while the schedule remains enabled.
- Audit is part of every increment. Dedicated append-only workflow events complement existing aggregated security audit, with authorized content references and no secrets in Temporal history.
- Intervals preserve a stable anchor; calendar schedules use explicit zone and preview. Separate scheduled instant, workflow start, agent dispatch, and completion.

## Build sequence

1. **Prove runtime and Temporal boundaries** (T01): local isolated Temporal; acceptance/recovery identity; blocker/tool evidence; exact/missed schedule metadata; SDK/platform compatibility.
2. **Define minimal contracts and persistence** (T02–T03): lifecycle/reasons, immutable revisions, run identities, audit schema, indexes and admission.
3. **Make unattended execution safe and observable** (T04–T06): reviewed recipe policy, durable request/tool/root evidence, reconciled dispatch under current owner permissions.
4. **Deliver Run now end to end** (T07–T08): finite Workflow, user-facing creation/test and real outcome without browser dependency. This validates execution before recurring it.
5. **Deliver scheduling in vertical slices** (T09–T11): interval first, timezone calendar second, versioned pause/edit/resume/archive/cancel controls.
6. **Complete user audit and recovery** (T12–T14): timeline/result/actions, paginated filters/export and alerts, partial-write/crash/receipt-loss/permissions recovery.
7. **Operational pilot and readiness evidence** (T15): deployable worker/server configuration and recovery runbook; a real read-only recipe pilot, then reviewed broader rollout.

Each task has acceptance and verification in todo.md. If a task needs more than roughly five source files, split its integration glue from its behavioral change before implementing. Checkpoints validate current chat regressions alongside automation behavior.

## Reliability and user-facing failure rules

Approval/review/required input/permanent dependency failure records Failed—needs your action, blocks further unauthorized actions in that run, and requests termination. Keep the schedule enabled and runtime stop state separate. After termination is confirmed, the next scheduled occurrence creates a new run and rechecks current scope/access/dependencies; an unresolved dependency produces a new audited failure, not an automatic pause. A manual retry is also a new linked run. An uncertain prior execution remains fenced until reconciled or explicitly resolved with evidence; subsequent occurrences record a skip rather than overlapping work. A lease timeout never clears the fence.

Retry idempotent persistence/observation/configuration operations with bounds. Retry dispatch only through its reconciliation wrapper. Do not blindly replay business mutations or whole workflows. Existing interactive chat approval behavior stays covered by regression tests.

The application cannot promise exact scheduling during outages. Show lateness and skip stale work under the chosen window. Where Temporal never emitted an action, use an honest missed-window audit summary unless the T01 spike proves exact supported slot reconstruction.

## Risks and mitigation

- **Lost native acknowledgment:** T01/T06 prove lookup or deliberately produce unknown; keep execution fenced.
- **Every long recipe asks for plan approval:** automation-specific instructions recognize reviewed scope; code rejects new consent/required input. Do not reuse current auto approval mode.
- **Incomplete audit from browser-only/tool/helper events:** durable instrumentation and ingestion-before-ack; verify helper scope/evidence or disable helper side effects.
- **Mongo/Temporal partial failure and stale edits:** pending intents, applied version tracking and recheck before dispatch; recovery tests delay old control writes.
- **Permission/configuration changes after enable:** immutable recipe scope plus live authorization; widened scope requires renewed enablement.
- **Temporal worker replay/deployment compatibility:** pin tested versions, replay history checks and retain compatible workers for active workflows.
- **Audit payload growth/sensitive content:** safe metadata, paginated queries, artifact references, retention and redaction tests.
- **Unclear business completion:** root completion plus required result/blocker checks; structured output validation where available and real pilot recipe assertions.

## Verification and rollout

Use pure tests for validation/state/reasons; actual Mongo integration for uniqueness/admission/convergence; Temporal workflow tests for timers/replay/Activities; a real isolated Temporal server for calendar/interval/overlap/catch-up and crash recovery; actual configured agent and permitted connector for end-to-end outcomes. Validate UI via the available T3 browser against installed Next.js guidance.

Run affected focused tests each increment. At checkpoints run relevant existing agent-core/platform approval, runtime, tenancy and ownership tests. Final checks: `npm --prefix agent-core test`, `npm --prefix platform test`, `npm --prefix frontend test`, `npm --prefix frontend run typecheck`, `npm run build`, `npm run format:check`, plus newly added real Temporal integration checks. Apply the repository's pre-push verification workflow before GitHub review or release; planning does not certify readiness.

Feature flag off → internal tenant Run now → recurring read-only recipe → tested failure/recovery drills → limited tenants. On rollback, stop new admission and pause schedules while retaining workers needed to observe active/uncertain runs. Preserve history and unknown fences.

## Product defaults for review

Confirmed user decision: fail only the affected run and keep the schedule active for human approval/review or permanent missing dependencies. Approved implementation defaults: recurring MVP; minimum one-minute interval; one execution at a time; 30-minute run deadline; 10-minute lateness grace; dispatch within 30 seconds under healthy pilot load; 365-day audit metadata retention; fresh conversation each run. Native DST behavior is visible in preview; once-per-date handling remains an explicit decision.

## Evidence and limits

Grounded in the existing source and architecture at `d3590c3e0857972e35b481965f217ea929abf851`. Temporal capabilities verified against [Schedules](https://docs.temporal.io/schedule), [ScheduleSpec](https://typescript.temporal.io/api/interfaces/client.ScheduleSpec), and [Retry Policies](https://docs.temporal.io/encyclopedia/retry-policies). Implementation, isolated live pilots and verification are recorded in [verification.md](verification.md). Production infrastructure deployment remains unperformed.
