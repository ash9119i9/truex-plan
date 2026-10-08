# Scheduled agent automations: feature contract

Status: approved for implementation, 9 October 2026. Implementation and verification tracked in [tasks/todo.md](../../../tasks/todo.md) and [tasks/verification.md](../../../tasks/verification.md).

User requirement: select an agent, supply a prompt, and choose execution times or an interval. Execute without the browser being open. Treat errors, required human review/approval, and unavailable dependencies as unsuccessful runs. Provide detailed, clear audit history. The user explicitly selected Temporal as the reliable workflow engine.

This is one end-to-end scheduling feature: its execution policy and audit are required parts of the same acceptance contract. The scoped implementation plan is [tasks/plan.md](../../../tasks/plan.md); tasks are in [tasks/todo.md](../../../tasks/todo.md).

## Proposed assumptions and defaults

- MVP supports recurring intervals and selected weekdays at a local time. A one-off future run, webhooks, arbitrary cron expressions, and continuing an existing conversation are follow-ons unless requested.
- Every run starts a fresh conversation using the selected agent and the automation owner's current permitted connectors. Enabling a saved revision authorizes that recipe within its reviewed scope, not unrestricted new actions.
- Approval, essential clarification, human review, or a permanent dependency problem stops the unattended run. There is no suspended approval queue or automatic consent. Resolution starts a new linked run; it does not revive an expired request.
- One active agent execution per automation. Overlapping triggers are visibly skipped. Uncertain execution remains fenced until reconciled.
- Proposed limits: minimum interval one minute, maximum execution time 30 minutes, scheduled admission grace 10 minutes. These are tunable product defaults, not measured capacity claims.
- Proposed healthy pilot target: agent dispatch within 30 seconds of the scheduled instant under the agreed pilot load. Record and display actual lag. Outages can produce delayed or missed occurrences; Temporal does not guarantee an exact wall-clock start.
- Confirmed user decision: approval/review/required-input and permanent-dependency failures fail only that occurrence. The schedule remains enabled and the next scheduled occurrence evaluates current dependencies/permissions again. Do not automatically pause or require re-enabling because a run failed. If runtime termination is unconfirmed, retain the execution fence: the schedule remains enabled, but subsequent occurrences cannot dispatch overlapping work.
- Audit metadata retention defaults to 365 days for review; restricted prompt/output artifacts follow the tenant's retention policy. Never expire unresolved execution identities or fences automatically.

## User journey

1. Open Automations, choose New automation, enter a name, select an allowed agent, and enter the execution prompt. Select an optional project using existing access rules.
2. Choose either every N minutes/hours/days from an explicit start anchor, or a local time and weekdays with an IANA timezone. Default the timezone from user settings/browser, show it explicitly, and persist it.
3. Preview the next five executions and review the agent, scope, and execution limits. Validate required connections where discoverable. Save as draft or explicitly enable the reviewed revision.
4. List shows enabled/paused/draft, next scheduled time, configuration synchronization state, latest result, and any action needed. Run now provides a test using the same policy and audit path.
5. Run details show what was scheduled, what actually happened, output/documents, failure reason, completed actions, and the next permitted action.
6. User can pause/resume, edit, archive, or request cancellation of the current run. Editing execution scope produces a new revision requiring explicit enablement.

## Run outcomes and human-action behavior

Lifecycle: accepted → preparing → running → succeeded / failed / skipped / cancelled / unknown. Cancellation also has a nonterminal cancellation-requested state. Store the diagnostic reason separately from the outcome and runtime termination evidence.

Success requires the exact root turn to terminate successfully, the expected result reference to be saved, and no unresolved required dependency/human-action signal. Submission acceptance, a final message alone, and a helper's completion are not success. Where a recipe has a structured deliverable contract, validate it too. Generic prompts cannot mechanically prove arbitrary business correctness; pilot recipes need explicit output acceptance checks.

| Situation | User-visible result | System action and recovery |
| --- | --- | --- |
| Agent completes with required result | Succeeded | Store result/artifact links, actual timing, and next occurrence. |
| Requires approval | Failed — approval required | Persist request and reason, deny further unapproved execution, and request safe termination. Keep the schedule enabled; after confirmed termination the next occurrence starts a new run. Owner can also resolve scope and initiate a linked manual run. |
| Requires human review or essential input | Failed — human action required | Same per-run stop behavior; show the exact missing decision without exposing secrets. The schedule remains enabled. |
| Missing connector, expired credential, unavailable agent, revoked access, missing required input/artifact | Failed — dependency unavailable / access revoked | Record which dependency is missing and how to fix it. Keep the schedule enabled and recheck authorization/dependencies on the next occurrence; if still unavailable, record a new failed run. Do not substitute another user's credentials or host data. |
| Temporary infrastructure/provider issue with proven safe retry | Retrying, then succeeded or failed | Bounded retries of the same logical operation; retain attempts. Do not repeat an ambiguous external action. |
| Runtime accepted work but receipt/outcome cannot be recovered | Outcome unknown — review required | Keep the schedule enabled, retain the execution fence, preserve known effects, and reconcile. Subsequent occurrences are visibly skipped while prior execution is unresolved. Never label this definitely failed or automatically start another agent. |
| Previous execution active | Skipped — previous run still active | Preserve the nominal occurrence and reason; do not overlap agent work. |
| Occurrence outside lateness policy | Missed — schedule window elapsed, or Skipped — too late for an emitted workflow | Display available timing evidence. Do not fabricate a started run. |
| User cancels | Cancellation requested, then Cancelled only after confirmation | Interrupt the root execution; preserve completed side effects. An unconfirmed stop stays unknown and fenced. |

The prior architecture uses internal `needs_attention`; it may remain an internal reason/state, but the feature's public presentation must make clear that the unattended run did not succeed. Retain business outcome and execution-stop state separately so a failed recipe is not confused with proof that the runtime has terminated.

### Unattended policy is distinct from interactive chat

The saved recipe may create an internal plan and execute within its reviewed scope. Automation-specific runtime instructions must not request fresh plan approval solely because the recipe has multiple steps. If a real new approval or required question arises, stop; do not answer Approve/recommended on behalf of the user. Enforce the policy in code before existing approval-mode and timeout auto-answer branches, not just through model instructions. Propagate the same or narrower scope to any permitted helpers; disable helpers for MVP if that inheritance cannot be proven.

Detect blockers through actual request events, structured dependency/tool errors, and an explicit result contract where needed. Do not classify success/failure by matching casual words in assistant prose. Recoverable optional-tool failures may be audited without failing the recipe; an unresolved required dependency must fail it.

## Temporal architecture

Use native Temporal Schedules for recurrence, one finite Workflow per logical run, and Activities adapting the existing Truex execution service. Temporal owns timing, durable coordination, timeouts, and recoverable retries. MongoDB owns tenant-scoped definitions, immutable reviewed revisions, admission identities, run summaries, and workflow audit events. The platform owns authorization and runtime evidence ingestion. Agent-core executes the selected agent.

Run path: Temporal occurrence → create/recover logical run → check current owner/agent/project/connector access → acquire the automation's single-execution fence → provision/submit through a reconciliation-aware adapter → observe exact root-turn evidence → persist business outcome and audit → release fence only with proven completion or absence of execution.

Reuse the broader architecture's all-source Mongo admission guard, rather than treating Temporal Schedule overlap policy as protection against independently started Run now workflows. Keep schedule/native concurrency distinct from agent concurrency.

Schedule configuration and Temporal synchronization cannot use one distributed transaction. Persist desired configuration and its pending sync intent before acknowledgment; expose synchronization pending/error, retry convergently, and compare against applied revisions. At dispatch, recheck enabled state and the executable revision so stale schedule actions do not execute old prompts.

Keep actual prompts, credentials, raw tool arguments/results, and connector secrets out of Temporal arguments, search attributes, and ordinary logs. Pass references and safe identifiers. Resolve current owner credentials inside trusted Activities.

Do not blindly retry existing provision/submit methods inside Activities. First prove reconciliation using stable operation identity and session/root-turn evidence; lost acknowledgment otherwise becomes unknown. Disable whole-workflow retries initially. Idempotent persistence/observation/control operations can use bounded Activity retries; restarting a worker resumes observation of the same execution.

Temporal supports native calendars/intervals and explicit catch-up/overlap policies. Disable native Schedule pause-on-failure and do not change the enabled flag when a run fails. Configure catch-up rather than inheriting its default, and independently bound actual dispatch age after queue delay. [Schedule documentation](https://docs.temporal.io/schedule), [ScheduleSpec](https://typescript.temporal.io/api/interfaces/client.ScheduleSpec), [retry policies](https://docs.temporal.io/encyclopedia/retry-policies).

### Time and missed-occurrence semantics

- Store instants in UTC and render with the saved timezone; intervals are fixed-rate from the saved anchor. Run now and title/prompt-only changes do not shift cadence.
- Calendar preview and execution use Temporal's timezone/calendar semantics. Native DST behavior skips nonexistent local times and may execute both repeated instants. Show this explicitly; once-per-local-date is an optional separate policy.
- Pause stops future admission; resume does not silently backfill paused periods. Define any intentional backfill later as a reviewed action.
- The audit must include skipped/missed timing decisions, not just executed runs. Use exact Temporal action metadata where available. If actions outside catch-up have no per-run identity, record a downtime/missed-window summary with counters and known time bounds, explicitly labeled as such. Exact per-slot historical reconstruction requires a supported, tested Temporal matching-times path; this is a validation spike, not a second scheduler.

## Audit contract

Provide a tenant-scoped, append-only event ledger with deduplicated event identities, and a run summary derived from evidence. Existing `security_audit` aggregates events and deliberately excludes prompts/message text; it is not the workflow ledger. Continue using security audit for protected reads/configuration access, alongside the new workflow ledger.

For each run retain:

- Automation/run IDs, definition revision, owner/tenant, selected agent and actual model/configuration fingerprint, trigger source, correlation/workflow/session/root-turn identifiers.
- Nominal scheduled time, accepted time, execution start/end, observed/persisted event times, lag, durations, attempt numbers, retry reasons, and timeout/cancellation evidence.
- Authorized prompt revision/reference and scope; sanitized dependency checks and configuration changes. Show the revision that actually ran even after edits.
- Plan/task progress where supplied; trusted tool/connector name, start/end, permitted scope, safe result/status, and artifact references. Record partial effects as confirmed/unknown; do not claim full external effects or compensation without provider evidence.
- Approval/review/input requests, blocked action, decision actor/source, denial/resolution, and policy reason. Never turn request expiration into consent.
- Result/document links, failure code, readable explanation, repair instruction, and lineage for any user-initiated retry.
- Created/edited/enabled/paused/resumed/archived/run-now/cancelled control events, including actor and version.

Raw prompts, outputs, and sensitive tool payloads remain restricted content with authorized references, redaction and tenant retention. The timeline is an execution record, not a dump of private model reasoning. MVP must capture side-effecting tool evidence from permitted helpers as well, or prohibit such delegation.

Capture selected audit evidence durably in agent-core; ingestion writes outcome/evidence/audit projections idempotently before acknowledging runtime records. Audit-write failure blocks new dispatch. After execution has started, retain unacknowledged runtime evidence for recovery and mark audit incomplete until repaired. Never claim a complete audit after evidence loss.

UI: concise result header (scheduled versus actual time, duration, status), timeline, outputs, and failure/next-action panel. Filter history by automation, date, and outcome; paginate. CSV export contains authorized, sanitized metadata. Raw content export remains subject to ordinary content access checks. Unknown outcomes and missing audit segments must be conspicuous.

## Codebase grounding and integration

Observed at Truex revision `d3590c3e0857972e35b481965f217ea929abf851`:

- `agent-core/src/requests.ts`: timeout answer helper can select recommended/Approve options.
- `agent-core/src/business-runtime.ts`: interactive long-task instructions require plan approval and allow timeout-as-approval. Introduce a trusted automation-specific policy while preserving interactive behavior.
- `agent-core/src/manager.ts`: approval-mode decisions can precede visible requests; durable events currently include `approval.resolved`, final messages and turn completion, but omit `approval.requested` and general tool start/end evidence. The business-runtime branch also declines certain native permission requests before normal public request emission; automation must record this path too.
- `platform/src/service.ts`: background ingestion already works without a browser and persists records before acknowledgment. Extend that path with correlated run evidence rather than relying on browser streams.
- `platform/src/audit.ts`: operator security audit has aggregation and content restrictions; reuse its access principles but add a dedicated workflow ledger.
- `shared/contracts.ts`, `platform/src/store.ts`, `platform/src/index.ts`, frontend agent selection and same-origin API forwarding are existing contract/storage/API integration points.
- The original architecture sketch is design context; implemented source and evidence are tracked in the task files.

Proposed new boundaries: `shared/automations.ts`; `platform/src/automation/{service,store,execution,temporal,workflows,activities,worker}.ts`; `frontend/components/automations/*` and `frontend/lib/automations.ts`; deployment configuration/runbook for a self-hosted Temporal service and its persistence database.

Keep Temporal SDK internals out of frontend/shared contracts; deterministic workflows cannot import database/network modules. Follow existing TypeScript style, e.g. discriminated outcome unions with explicit reason codes instead of loosely related booleans. Read the installed Next.js documentation and `frontend/AGENTS.md` before frontend implementation.

## Acceptance and validation

1. User can create an automation using an allowed agent, prompt, interval/calendar time and explicit timezone; sees a valid preview and draft/enabled/synchronizing state.
2. Under agreed healthy pilot load, measured dispatch meets the proposed 30-second timing target. The job completes with the browser closed and the recorded exact root result is available afterward.
3. Approval, human input/review, unavailable dependency, revoked permission, provider failure, and timeout each yield an explicit unsuccessful result/reason; no timeout-based consent. A human-action or permanent-dependency failure leaves the schedule enabled: the next occurrence creates a distinct run, rechecks current conditions, and succeeds or fails independently. Unknown prior execution remains fenced and produces an explicit skipped occurrence rather than overlapping work.
4. Two workers, duplicate delivery, manual/scheduled race, and worker restart do not produce concurrent agent execution or a blind duplicate external mutation.
5. Receipt loss or uncertain termination becomes unknown, with the fence retained. Cancellation requested differs from confirmed cancellation.
6. Pause/archive/edit races reject stale dispatch. Timezone/DST/interval anchor and late/missed policies match preview and history.
7. Audit exposes authorization, schedule/run timing, steps/tools, attempts, blockers, partial outcomes, output links, control actions and retry lineage. Replayed evidence creates no duplicates; unavailable/lost evidence is visibly incomplete.
8. Tenant/owner changes and denied access cannot expose another user's prompt, run history, output, or credentials. Current permissions are rechecked at execution.
9. Real self-hosted Temporal recovery and a configured agent/connector pilot pass. Fake agent output and mocked timers alone are insufficient evidence.

Existing commands: `npm --prefix agent-core test`; `npm --prefix platform test`; `npm --prefix frontend test`; `npm --prefix frontend run typecheck`; `npm run build`; `npm run format:check`. Add focused automation and Temporal integration commands during implementation. Workflow time-skipping tests do not replace real Schedule tests. Completed implementation checks and remaining deployment gates are recorded in [verification](../../../tasks/verification.md).

## Boundaries and decisions for review

Always preserve tenant ownership, current permission checks, existing interactive behavior, honest run outcomes, and durable evidence. Product scope has been approved; implementation is authorized. Production deployments and real scheduled business actions require separate authorization. Local isolated tests are part of implementation verification.

Confirmed: fail the affected run and keep the schedule active for approval/review or permanent missing dependencies. Approved defaults for implementation: recurring-only versus one-off inclusion; healthy timing target and load; maximum run time; audit retention; whether DST repeated-time execution should be once per local date. The user approved these defaults with the implementation plan.
