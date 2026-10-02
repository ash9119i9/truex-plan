# Truex: PostHog Cloud Free implementation plan

Status: proposed; no SDK installation or production configuration has been performed.
Prepared: 2 October 2026.
Scope: first few months, up to 1,000 users, target PostHog spend of $0/month.

## 1. Outcome and starting decisions

Implement enough analytics to answer:

1. Who starts using Truex, and do they reach a useful first result?
2. Which agents, models, connectors and features are used repeatedly?
3. Where do users abandon or interrupt a task?
4. How often do runs complete, fail or get cancelled?
5. Do users return, and do they report useful results?
6. What response times and token usage accompany those outcomes?

Use **PostHog Cloud Free** as the initial platform. Collect deliberate product events, authoritative backend outcomes, sampled masked replay, and a small feedback mechanism. Use PostHog dashboards for the internal team; a customer-facing analytics UI is outside this first phase.

Initial decisions:

- One production project, no payment card, no paid add-ons.
- Analytics disabled in ordinary development and automated tests. Explicit QA mode can send synthetic events into the same project with `environment=qa`; every production dashboard excludes them.
- Explicit events first; broad DOM autocapture disabled initially.
- Replay disabled until privacy verification passes, then sampled at 20% of eligible sessions.
- No raw prompts, responses, reasoning, documents, connector arguments, credentials, filenames or customer-defined titles in analytics.
- Detailed AI observability is a later optional phase. Initial run-level token and timing summaries reuse Truex's existing observability records.
- Separate analytics and replay enablement, with independent kill switches and collection preferences.

The current free plan lists 1M analytics events and 5K recordings monthly, one project, one-year event/metadata retention and one-month recording retention. Other products have separate allowances. Collection beyond a free quota can be dropped. These are vendor limits, not a guarantee that 1,000 users will always fit. [PostHog pricing](https://posthog.com/pricing).

## 2. Repository baseline

Current code, rather than the README's older opening description, provides the following integration points:

| Existing area | Relevant files | Planned use |
|---|---|---|
| Next.js app and actions | `frontend/app/layout.tsx`, `frontend/app/page.tsx` | Initialize browser analytics once and capture explicit interactions |
| Identity endpoint | `platform/src/index.ts` (`/api/me`) | Obtain server-established user, tenant and role |
| Authentication | `platform/src/auth.ts`, `platform/src/user.ts` | Identify signed-in users, respect auth mode and reset on logout |
| Tenant context | `platform/src/tenant.ts`, `platform/src/http.ts` | Derive backend account context without trusting client-supplied tenant IDs |
| Business operations | `platform/src/service.ts`, `platform/src/index.ts` | Capture accepted operations and committed outcomes |
| Durable runtime ingestion | `platform/src/service.ts` (`ingest`, `poll`) | Reuse persisted results; do not depend on browser SSE consumption |
| Turn persistence | `platform/src/store.ts` (`persist`) | Project `turn.completed` traces into safe terminal analytics events |
| Existing run metrics | `shared/contracts.ts`, `agent-core/src/trace.ts`, `frontend/lib/observability.ts` | Reuse status, duration, token counts and helper usage |
| Model gateway | `model-gateway/src/logging.ts` and provider adapters | Optional later model-call instrumentation |

Authentication includes Google-session and development modes, and tenant-aware storage exists. Deployment readiness of those paths is not asserted by this plan. Production analytics must identify real users from authenticated context; a shared development identity must never be counted as a real user population.

Existing `TurnTrace` objects include step labels and privacy samples. **Do not forward a complete trace object to PostHog.** Build a new small allowlisted summary containing approved scalar fields only.

Direct Responses-provider calls may bypass the model gateway. Instrumenting only the gateway would therefore leave gaps in later AI tracing.

## 3. Phase A: measurement definitions and cloud setup

Estimated effort: half to one working day.

### Tasks

- [ ] Create the PostHog organization and production project; select the hosting region after checking customer/data-hosting requirements.
- [ ] Keep the account on Free without a payment card. Recheck the visible plan limits before activation.
- [ ] Restrict project access to the small internal team that needs analytics.
- [ ] Document event names, properties, producer, collection preference, event ID and meaning.
- [ ] Define collection/disclosure preferences for analytics and replay. Reuse an existing preference mechanism if present; otherwise add a minimal one.
- [ ] Define internal/test-user exclusion and permitted production hosts.
- [ ] Establish the launch date: do not export historical conversations or pre-launch events.

### Metric definitions

| Metric | Initial definition |
|---|---|
| Active user | Unique identified user with at least one backend-accepted message or another explicitly defined meaningful action |
| Technical activation | First completed main-agent run within seven days of first eligible app use; label this as a proxy for value |
| Confirmed usefulness | User reports a successful/useful result for a run |
| Completion rate | Completed runs / terminal runs; report failed and cancelled shares separately |
| Execution funnel | Accepted message → started run → terminal result; distinguish new-run messages from steering messages |
| Retention | Week-over-week return to an accepted meaningful action among a defined eligible user cohort |
| Feature adoption | Unique feature users / eligible active users for a specified period |
| Feedback score | Positive feedback share among feedback respondents, accompanied by feedback response rate |

Use UTC timestamps and an explicitly chosen dashboard display timezone. Do not present partial weeks as comparable to full weeks.

### Exit condition

Project created, measurement dictionary reviewed, collection preferences defined, and no paid capability required for the launch dashboards.

## 4. Phase B: analytics foundation and identity

Estimated effort: one to two working days.

### Proposed files

| New file | Responsibility |
|---|---|
| `shared/analytics.ts` | Event types, schema version, property allowlists and validation |
| `frontend/lib/analytics.ts` | Safe browser capture, identify/reset, enablement and session correlation |
| `frontend/components/analytics-provider.tsx` | Initialize once and respond to identity/preference changes |
| `platform/src/analytics.ts` | Backend event projection, safe identity mapping and capture interface |
| `platform/src/analytics-exporter.ts` | Durable delivery, retries and reporting of collection health |

Names are proposed; implementation can adapt them to existing project conventions. Install stable supported `posthog-js` and `posthog-node` versions, update the corresponding service lockfiles, and follow the current official integration guidance. [Next.js SDK guide](https://posthog.com/docs/libraries/next-js), [Node SDK guide](https://posthog.com/docs/libraries/node).

### Configuration

Proposed variables in the service-specific `.env.example` files:

```text
# Browser: project ingestion token is public configuration, not an admin secret.
NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=
NEXT_PUBLIC_POSTHOG_HOST=
NEXT_PUBLIC_ANALYTICS_ENABLED=false
NEXT_PUBLIC_ANALYTICS_ENVIRONMENT=development
NEXT_PUBLIC_SESSION_REPLAY_ENABLED=false
NEXT_PUBLIC_SESSION_REPLAY_SAMPLE_RATE=0.20

# Platform: server configuration remains outside the browser bundle.
POSTHOG_PROJECT_TOKEN=
POSTHOG_HOST=
ANALYTICS_ENABLED=false
ANALYTICS_ENVIRONMENT=development
```

Do not put a PostHog personal/admin API key in frontend configuration. Account-management credentials, if needed for deletion/export administration, belong only in an appropriate server secret store.

### Identity behavior

- Read the user's server-established identity from `/api/me` after authentication and collection eligibility are known.
- Use a stable opaque analytics user ID consistently in both frontend and backend. Reuse internal opaque IDs only if acceptable; otherwise return a server-derived analytics ID. Do not use email as `distinct_id`.
- Include `tenant_id` and membership role on each relevant event. Role belongs to the active tenant, not permanently to the person.
- Start with `tenant_id` filtering in ordinary reports. Dedicated group analytics is optional and must pass a free-plan availability check before use.
- Reset SDK state and stop replay on logout, user changes, tenant switches and collection withdrawal. Reinitialize the correct context before further capture.
- Exclude sign-in callbacks, invite-token pages, admin interfaces and sensitive settings from replay. Do not initialize tracking on those routes merely because they share a root layout.
- Keep the browser's PostHog session ID separate from Truex conversation and authentication-session IDs. An optional browser correlation ID supplied to the server is for reporting only, never authorization.
- Propagate permitted collection context to server operations and persist it with long-running runs. The exporter also checks subsequent withdrawal/deletion before delivery.

All backend identity/tenant fields must come from authenticated server context or stored run ownership. A background poller's current user is not necessarily the user who initiated a run. Add a small attribution snapshot for the initiating user and tenant where current records do not preserve enough information.

### Exit condition

One browser client per app instance; stable matching frontend/backend identity; no capture when disabled or ineligible; no cross-user/tenant leakage after logout or switching; no change to business authorization.

## 5. Phase C: explicit product and backend events

Estimated effort: two to three working days, including durable terminal outcomes.

### Initial event dictionary

| Event | Producer | Meaning and safe properties |
|---|---|---|
| `app_opened` | Browser | Eligible app session begins; environment/app version |
| `conversation_created` | Platform | Creation committed; opaque conversation ID, approved agent category |
| `conversation_opened` | Browser | User intentionally opens a conversation; opaque conversation ID |
| `message_submit_attempted` | Browser | User submits; stable client ID, length bucket, new-turn/steer intent |
| `message_accepted` | Platform | Submission accepted; client ID, conversation/turn ID when known, delivery kind |
| `message_rejected` | Platform | Definite rejection; client ID, bounded reason code; no prompt/error text |
| `run_started` | Platform | New main-agent turn actually starts; initiating user/tenant, turn ID |
| `run_completed` | Platform | Terminal success; duration, approved token summaries, model category |
| `run_failed` | Platform | Terminal failure; duration and bounded failure code |
| `run_cancelled` | Platform | Terminal interruption/cancellation; duration and safe reason category |
| `run_stop_requested` | Browser | Stop clicked; turn ID; does not imply cancellation succeeded |
| `run_steer_accepted` | Platform | Steering accepted; client/turn ID; does not count as a new run |
| `clarification_answered` | Platform | Valid answer accepted; question category and answer mode, no answer text |
| `agent_changed` | Browser | Selected agent changes; approved category or opaque ID |
| `model_changed` | Platform | Model-setting operation accepted; approved old/new categories |
| `connector_config_saved` | Platform | Configuration saved; connector type/scope, no endpoint or credential |
| `file_upload_completed` | Platform | File accepted; file type and size bucket, no name/content |
| `artifact_download_requested` | Browser | User requests a download; artifact type; does not prove delivery |
| `visualization_opened` | Browser | Visualization opened; safe visualization category |
| `response_feedback_submitted` | Platform | Feedback saved; turn ID, useful/not-useful and optional reason code |

Implement only events backed by actual observable hooks. If a connector verification action does not exist, do not report configuration save as connection success. Additional connector verification, tool outcome summaries, onboarding and business-lifecycle events can follow later.

### Shared properties

Every event has `schema_version`, stable `event_id`, `occurred_at`, `environment`, `app_version`, source and applicable user/tenant/correlation IDs. Apply per-event property allowlists and bounded values. Unknown properties are dropped, not forwarded as arbitrary objects.

No raw URL query strings, message text, errors/stacks, document names, step labels, HTTP bodies or credentials. Page reporting, if enabled, uses a sanitized route category; choose a single pageview producer to avoid automatic-plus-manual duplication.

### Durable terminal outcomes

- Derive terminal status and summary values from persisted main-agent turn traces, not browser-rendered completion messages.
- Keep a minimal durable receipt for start time, initiating user, tenant, collection eligibility and terminal timestamp/status. Persist missing lifecycle facts as part of existing authoritative records.
- Add an idempotent analytics outbox with a unique stable event ID. Reconcile eligible persisted lifecycle records into it, including after crashes.
- Do not add a PostHog network request to the adapter-record persistence/acknowledgement path. Existing Mongo persistence and browser streaming must continue during a PostHog outage.
- Use an asynchronous bounded worker with backoff, retry ceilings, operational counters and recoverable failed records. If several platform replicas export, claim records with an atomic lease.
- Deliver with the supported capture transport and mark delivery only after an actual delivery acknowledgement. Enqueuing an event into an SDK's memory buffer is not sufficient proof of delivery.
- Reuse the same vendor deduplication identifier and original timestamp on retries, after verifying the selected SDK/API's deduplication behavior. Describe delivery as at-least-once; do not promise unlimited exactly-once vendor ingestion.
- Separate malformed-event failures, temporary transport failures and quota-disabled collection. Do not endlessly retry permanent rejection or backlog beyond the eligible retention window.
- Store only approved payloads in the outbox. Add expiry/cleanup and delete pending records when the user withdraws or is deleted, according to the collection policy.

Other request/UI events can use bounded best-effort capture if their loss is documented. The run-completion funnel requires durable authoritative outcomes. Report missing terminal records as unknown rather than inventing failures.

### Metrics accuracy

Reuse existing main-agent and helper token summaries without double-counting. Provider usage can be missing: preserve null/missing rather than zero. Initially report tokens and duration. Add dollar cost only when model pricing and cached/reasoning billing treatment are verified, with an explicit estimated-cost label.

Model first-byte timing, first visible response timing and overall run duration are different measurements. Name them separately; do not substitute gateway first byte for time until a user sees the answer.

### Exit condition

Each event has one authoritative producer; terminal outcomes survive browser close and exporter restart; retry, SSE replay, history restore and React rerenders do not multiply counts in controlled scenarios.

## 6. Phase D: masked replay and lightweight feedback

Estimated effort: one to two working days.

### Replay

- Start with synthetic sessions and replay disabled for actual users.
- Mask all inputs and page text by default. Explicitly block/mask chat transcript, reasoning, tool panels, connector configuration, document previews, generated visualizations and customer identity labels.
- Disable console and network-body collection initially; sanitize URLs and metadata separately.
- Add safe markers or deliberate events for navigation/actions. Do not rely on captured button labels or customer content for event meaning.
- Inspect streaming, restored history, modal/portal content, embedded previews and download UI using synthetic secrets. Verify transmitted payloads as well as replay rendering.
- After verification, randomly sample **20% of eligible sessions**, keeping selection consistent within a session. Measure actual sessions and adjust sampling as needed.
- Keep error-targeted recordings separate if added later; do not interpret such a biased sample as population-wide behavior.

PostHog's web input masking alone does not protect general page text. Replay privacy settings are separate from ordinary event properties and AI traces. [Replay privacy documentation](https://posthog.com/docs/session-replay/privacy).

### Feedback

Add a small useful/not-useful control for completed answers. An optional reason selector can use fixed categories such as incorrect, incomplete, slow, misunderstood or technical failure. Store feedback on the backend and send only the allowed rating/category, not free text.

Do not show a modal after every run. Keep feedback voluntary and report respondent coverage. Feedback from an old answer is attributed to its original run, not the currently selected conversation's active turn.

### Exit condition

Synthetic secrets are absent from transmitted analytics/replay payloads; sampling works at session level; preferences and exclusions work; feedback is stored and correlated correctly.

## 7. Phase E: dashboards, quotas and pilot

Estimated effort: one working day to configure, followed by one to two weeks of observation.

### Six launch dashboards

1. **Activation:** eligible app users → first accepted new-run message → started run → first completion; confirmed usefulness shown separately.
2. **Retention:** weekly meaningful active users and returning-user cohorts.
3. **Task outcomes:** started/terminal/unknown counts, completed/failed/cancelled shares, status by agent/model category.
4. **Feature adoption:** connector configuration, uploads, downloads, visualizations, steering and clarification use.
5. **Performance and AI usage:** p50/p95 run duration, measured first-response latency where available, main/helper token totals and usage-data coverage.
6. **Feedback and tracking health:** usefulness ratings, response coverage, pending exports, duplicates/gaps, ingestion delay and quota usage.

Filter every dashboard to production, eligible collection, and non-internal traffic. Use consistent user/tenant definitions and time windows. Tenant reports are for the authorized internal team; PostHog dashboard access does not inherit Truex tenant permissions automatically.

### Operating targets, below vendor quotas

| Product | Free allowance | Proposed working target | Action threshold |
|---|---:|---:|---|
| Analytics | 1M events/month | Below 600K | Review at 70%; reduce noisy/optional events at 85% |
| Replay | 5K recordings/month | Below 3K | Review forecast at 70%; reduce sampling before 85% |
| AI observability, later | 100K events/month | Below 50K | Review at 70%; reduce optional detailed tracing at 85% |

These targets and thresholds are proposed operational choices. Use in-product usage indicators/alerts if available; otherwise review the billing/usage page manually. Do not require a paid alerting feature to remain free. Review weekly during pilot and more frequently near a threshold.

### Volume examples

```text
Baseline: 1,000 users × 10 sessions × 25 browser events = 250,000 browser events/month
Replay:   10,000 eligible sessions × 20% = approximately 2,000 recordings/month

Heavy:    1,000 users × 30 sessions × 40 browser events = 1.2M browser events/month
Replay:   30,000 eligible sessions × 20% = approximately 6,000 recordings/month
```

Backend events add volume. The baseline fits the allowances; the heavy scenario does not. At 30,000 eligible sessions, 10% replay sampling gives about 3,000 recordings, below the proposed target. Reducing replay has no effect on product-event volume.

Always keep the free account's quota boundary in mind: dropped collection is a coverage gap. Add a quota/collection-status note to internal interpretation of affected periods rather than assuming traffic stopped.

### Pilot rollout

- [ ] Synthetic QA sessions and privacy verification.
- [ ] Internal production cohort, excluded from product metrics, for 2–3 days.
- [ ] Small eligible real-user cohort for approximately one week.
- [ ] Broader eligible population after data quality and performance checks pass.
- [ ] Review after two weeks: actual event/session volume, retention questions, missing outcomes and whether another analytics tool is justified.

The staged timeline is a proposal, not a requirement to collect for every period if a defect appears. Fix defects and repeat the relevant checks before expanding.

## 8. Optional Phase F: detailed AI observability

Estimated additional effort: two to four working days for a representative workflow; full provider/runtime coverage may take longer.

Run-level summaries are sufficient for initial product analytics. Add detailed PostHog AI tracing only when individual model/tool calls are needed to explain failures, quality or cost.

- [ ] Instrument one representative end-to-end run with consistent user, conversation and trace IDs.
- [ ] Identify both direct provider and gateway routes, plus helper-agent attribution.
- [ ] Capture safe model/tool categories, latency, usage and bounded status fields; keep prompt/response content excluded by default.
- [ ] Verify SDK content-capture defaults and support for metadata-only operation before activation.
- [ ] Distinguish vendor-billed AI events from product events and avoid exporting the same accounting totals at multiple levels.
- [ ] Trial a limited sample against the 100K monthly allowance and working target.
- [ ] Decide whether PostHog meets actual tracing/evaluation needs before adding Langfuse.

AI observability requires application instrumentation; browser analytics alone does not expose runtime model calls. [PostHog AI observability](https://posthog.com/docs/ai-observability).

## 9. Verification and acceptance criteria

Implementation tests should target meaningful risks, not merely repeat event constants. Documentation-only planning does not require application tests.

| Check | Passing result |
|---|---|
| Disabled/missing configuration | App operates normally; no analytics request or crash |
| Preferences | Ineligible users generate no prohibited collection; withdrawal stops capture and clears pending exports |
| Identity | Same permitted user connects browser/backend events; another user never inherits their browser identity |
| Tenant switch | Subsequent events/replay use the new tenant context without replaying the previous tenant's content |
| Privacy | Synthetic secret markers absent from event/replay/console/network payloads and outbox records |
| Event semantics | Attempted submission, acceptance, steering and terminal status match actual operations |
| Retry and history | Same client/turn outcome is not multiplied by retries, reconnects, restores or rerenders |
| Browser closed | Persisted terminal outcome is exported without an open SSE subscriber |
| Exporter interruption | Restart and lease expiration recover eligible pending events with stable IDs |
| PostHog unavailable | Normal message submission, runtime persistence and rendering continue; queue remains bounded |
| Summaries | Known synthetic runs match dashboard counts; missing usage is shown as unknown |
| Sampling | Selection is consistent within sessions; aggregate recording volume matches the expected range |
| Performance | Compare representative streaming UX and resource use with analytics disabled/enabled; investigate a material regression |
| Data access/deletion | Dashboard access is restricted; deletion includes vendor data and pending local exports |

Run applicable service type/build checks, meaningful tests and the repository's required checks once implementation exists. Before future push/review/release, use the repository's applicable pre-push verification workflow. This plan does not certify deployment readiness.

Reconcile a fixed synthetic set of new-turn messages, steering messages, failures, interruptions and completions against persisted source records. Include at least one helper-agent run and missing-usage case. In the pilot, publish collection eligibility/identity coverage alongside outcome metrics.

## 10. Rollback and continued operation

- Keep server and browser capture/replay kill switches independent. Public environment flags may require a frontend rebuild; add a server-fed runtime enablement setting if immediate shutdown is required.
- Disabling export also prevents growing an unlimited pending backlog. Preserve operational records and retain/drop analytics receipts according to the documented policy.
- If privacy leakage is detected, stop the relevant capture immediately, fix the projection/masking, remove affected vendor/local analytics data and verify with synthetic examples before re-enabling.
- Keep product usage dashboards weekly, review 5–10 sampled sessions with a specific question, and choose one measurable improvement at a time.
- Revisit paid plans only when observed volume, replay retention, access controls or other requirements justify them. No automatic paid upgrade is part of this plan.

## 11. Deliverables and effort estimate

Deliverables:

- [ ] Production PostHog project on Free, with hosting/access decisions recorded.
- [ ] Typed event dictionary and sanitization wrappers.
- [ ] Identity, tenant and preference integration.
- [ ] Initial product events and durable terminal-outcome export.
- [ ] Verified masked replay with 20% starting sampling.
- [ ] Lightweight feedback capture.
- [ ] Six dashboards with definitions and exclusions.
- [ ] Usage/coverage monitoring and deletion/rollback runbook.
- [ ] Evidence from synthetic verification and a real pilot.

**Planning estimate: approximately 6–10 engineering working days for the initial implementation and validation**, assuming one engineer familiar with the repository and no major deployment/identity changes. A pilot observation period follows and is not full-time implementation work. Detailed AI tracing is optional additional work.

Core dependency order: definitions/setup → safe identity/capture foundation → explicit events and backend outcomes → privacy-verified replay/feedback → dashboards and pilot. Detailed AI tracing follows when the initial data demonstrates a need.

Related background: [User analytics research](USER_ANALYTICS_RESEARCH.md).
