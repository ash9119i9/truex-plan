# Coordinated Stop and watchdog recovery

Branch: `agent-core-update-v2`. Implemented for Truex's web conversation lifecycle; no T3 desktop architecture or provider replacement was introduced.

## Behavior

Stop immediately closes conversation admission and persists its intent before cancellation side effects. The server pauses an active goal, interrupts the root and active or initializing helpers, archives those helpers, then checks native metadata. It confirms only explicit idle/notLoaded states, confirmed helper shutdown, stable turn targets, and settled local document/script work.

The public wait is bounded to 10 seconds for interruption plus 5 seconds for reconciliation, including a wait behind a missing startup acknowledgment. Duplicate callers share the internal recovery operation. A timeout leaves the conversation blocked with **Stop unconfirmed** and **Retry stop**. A late startup acknowledgment or notification attaches its native turn ID without reopening the conversation. Recovery never resubmits the prompt or reexecutes tools.

The same coordinator handles inactivity watchdogs. Stop intent survives manager/runtime restart on the same durable runtime home. Cold recovery pauses the persisted goal before any thread resume. Invalid or unavailable recovery storage fails closed. Metadata sampled for an older turn cannot confirm a newer turn. Completed helpers from prior work are left alone.

Partial output is finalized through the existing durable message records when Stop settles. Late events for stopped turns are suppressed. A naturally completed turn racing Stop retains its native outcome. The UI blocks messages and approval answers while stopping, preserves drafts, disables duplicate clicks, and fences asynchronous responses by conversation, turn and attempt.

## Verification

Commands used with Node 24 and `PROJECT_ROOT=/Users/ashok/truex-plan` for native integration tests:

- Root `npm test`: agent-core, platform and model-gateway suites.
- `npm --prefix frontend test`: frontend suite.
- Root `npm run build`: all four application builds.
- Final agent-core `npm test` and build after lifecycle race fixes.
- Final platform build and frontend typecheck after shared contract changes.
- Prettier checks on all changed/new TypeScript files; `git diff --check`.

Final results: **594 tests passed**, with zero failures or skips: agent-core 194, platform 151, model-gateway 58, frontend 191. The Stop-specific suite includes 20 manager regressions and 2 real native-runtime integrations. All four application builds passed; final core/platform builds and frontend typecheck also passed after the shared lifecycle changes.

The added tests exercise missing completion events, hung interruption/reads, active goal pause, startup acknowledgment loss, delayed startup notifications, duplicate Stops, preparation races, runtime generation changes, helpers discovered during Stop, stale metadata, local work still mutating the workspace, approval decisions resolving late, corrupt/unwritable recovery markers, and watchdog uncertainty.

Two integration tests execute the pinned native binary with a local Responses fixture and no live provider credentials. They confirm native interruption despite a lost host completion event, partial preservation, exactly one terminal record, another conversation staying active, no additional model requests from recovery, and a goal staying paused after process restart and cold resume. Successful Stop confirmation measured about 22–40 ms in these small local fixtures; this is not a production latency or scale guarantee.

Browser verification used isolated MongoDB and the local demo provider. Observed **Stopping…**, disabled repeat Stop, injected a Stop HTTP failure, used **Retry stop**, returned to Ready, and verified partial text survived page reload. Temporary services were stopped afterward.

Repository-wide `npm run format:check` still reports 59 existing formatting failures. Each was checked against its `HEAD` contents: all 59 predate this change. Changed TypeScript files pass their formatting check. An existing SSE test also exposed a fixed-delay subscription race under concurrent native tests; it now waits for the actual subscription handshake before publishing.

## Operational limits and rollout

- Native execution stopping does not prove remote cancellation or rollback. The fixture's upstream HTTP response remained open after native interruption. Already-issued MCP/connector actions can complete remotely.
- Detached local tools are tracked to settlement; this change does not add process-kill support to the script/document tools. Long work can therefore leave Stop unconfirmed until it settles.
- Recovery depends on a healthy persistent runtime home. An unavailable volume cannot guarantee persistence of a newly requested Stop; the current manager blocks admission and reports a storage error.
- Native same-thread FIFO processing is part of the recovery proof. Goal operations, interruption, archive and metadata reads are serialized by the pinned runtime. Future runtime updates must preserve or reverify that behavior.
- No database migration or new dependency is required. Public fields/events are additive. Monitor `stop confirmed` latency/target counts and `stop unconfirmed` errors during rollout. Before rolling back to code that does not understand Stop intents, drain the runtime and resolve outstanding unconfirmed Stops.

No commit, push, merge or deployment was performed.
