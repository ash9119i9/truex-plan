# Sub-agents: adopt Codex's exact design (coding + helpers in one chat)

Goal: stop treating coding and sub-agents as mutually exclusive, and run them
the way upstream Codex does — one shared workspace, capability controlled by
**roles**, not by a read-only lock or workspace isolation. This supersedes the
"helpers gather, the lead acts" product rule from `tasks/subagents-plan.md`
only where the two conflict; everything else there (event routing, billing,
settle, stop, reconnect) stays.

Engine stays Codex `multi_agent_v2`, unmodified (see
[[subagents-use-codex-native]]). All work is in `runtime-adapter`,
`platform-next`, `frontend`.

## What Codex actually does (verified in vendor/codex)

| Concern | Codex's design | Anchor |
|---|---|---|
| Filesystem | **Shared**. All agents, same container, same cwd; edits are immediately visible to all. No isolation. | `prompts/src/multi_agent_instructions.rs:12-19` |
| Capability | **Roles** reduce (never escalate) tools/permissions; chosen per spawn via `agent_type`. Built-ins: `default`, `explorer` (fast, read-oriented), `worker` ("divide file ownership; you are not alone"). | `core/src/agent/role.rs:33,166`; `core/src/agent/role.rs` built-ins; test `multi_agents_tests.rs:375,404` |
| Write collisions | Managed by the `worker` role instruction (divide ownership), not by locks. | `core/src/agent/role.rs` (worker), `model_messages/multi_agent.rs` |
| Delegate-or-not | `<multi_agent_mode>` policy: `ExplicitRequestOnly` by default, `Proactive` only at Ultra effort. | `model_messages/multi_agent.rs:45` |
| Bounding | Breadth: `max_concurrent_threads_per_session` (default 4). Tree-wide `RolloutBudget` (under dev). LRU residency evicts idle children to disk. | `core/src/agent/control/runtime.rs:188`, `registry.rs:24`, `control/residency.rs:99` |
| Leaf agents | Do **not** receive collaboration tools (no infinite spawning). | test `subagent_notifications.rs:2427` |

So Codex's answer to "coding + sub-agents" is: allow both, share the workspace,
and give a spawned agent a *role* that narrows what it may do.

## What Truex does today (the v1 constraints to change)

1. **Hard gate** — the adapter refuses helpers whenever coding is on:
   ```ts
   // runtime-adapter/src/server.ts:90
   if (request.subAgents && options.manager.codingEnabled)
     throw new AdapterError("SUBAGENTS_DISABLED");
   ```
   Platform maps it to "Helper agents aren't available for this assistant"
   (`run-executor.ts:1103`, `SUBAGENTS_UNAVAILABLE`).

2. **Helpers forced read-only** — two overrides replace Codex's own role model:
   - `config.ts` `HELPER_INSTRUCTIONS` ("Never change data…"),
     `DELEGATION_HINT`, pushed as `subagent_developer_instructions` +
     `multi_agent_mode_hint_text`.
   - `config.ts` `hide_spawn_agent_metadata: true` — suppresses per-helper
     `agent_type`/`model`, so **roles are currently invisible to the model**.
   - `chat.ts:1633` auto-declines any helper approval: `decline("helper_write")`.

3. **Two platform switches** — operator `CHAT_SUBAGENTS` + agent `helpers`
   (`chats.service.ts:1630`). These stay; only the coding conflict is removed.

## The one decision you must make (safety)

Codex's design assumes the operator **is** the developer and trusts every
agent. Truex's member is a **customer**. Pure-exact Codex means a helper can
create/edit/delete files **and** call MCP connector write tools with no
approval. Two of those have very different blast radii:

- **Workspace file writes / command exec** are already sandboxed, per-chat,
  no-internet (`CODING_INSTRUCTIONS`, network policy). Blast radius = this
  chat's scratch files. Letting helpers write here is bounded and reversible.
- **MCP connector writes** hit real external systems (create_issue, send,
  delete). Irreversible. This is the guarantee the sub-agent design exists to
  protect, and the injection tests cover it.

**Option A — pure exact Codex.** Remove every read-only constraint. Helpers
write files, run commands, and call connector writes like the lead.
Simplest; matches upstream byte-for-byte; drops the "no unapproved external
change" guarantee.

**Option B — exact Codex in the sandbox, keep the external guarantee
(recommended).** Helpers get Codex's shared workspace + roles and may write
files / run commands in the sandbox exactly as Codex intends. Connector
(MCP) writes by a helper still go through approval (keep the `helper_write`
decline **only** for MCP, drop it for coding file/exec). This is >95% of
Codex's design, removes the bad gate, enables the "helpers gather, lead
writes the document" flow in one chat, and keeps the only guarantee that
maps to real-world irreversibility.

The plan below is written for **Option B** with the one-line switch to make it
Option A called out. Pick before Phase 1.

## Phase 0: Probe the pin (tests only)

`runtime-adapter/test/codex/subagents-coding-probe.test.ts`, coding on +
`multi_agent_v2` on. Each records observed shape, becomes a pin assertion.

- [ ] P0.1 With coding on, V2 still offers the lead the collaboration tools;
      spawn works; the child inherits the coding tool-set (file/exec).
- [ ] P0.2 `hide_spawn_agent_metadata: false` → the model may pass
      `agent_type`/`model`/`reasoning_effort` on spawn; unknown role →
      Codex error shape (record it).
- [ ] P0.3 Built-in roles resolve: `agent_type:"explorer"` and `"worker"`
      accepted; confirm which tools each removes on the pin (role layer).
- [ ] P0.4 A helper's file write lands in the **shared** cwd and is visible to
      the lead (confirm shared-fs behaviour on our build).
- [ ] P0.5 A helper's **MCP** write still surfaces an approval request carrying
      the child thread/turn (so Option B can decline just that).
- [ ] P0.6 Two helpers writing different files in the shared cwd do not corrupt
      each other; same file → last-writer-wins (document it; worker role is the
      mitigation, not a lock).
- [ ] P0.7 Leaf (depth-2) agents receive no collaboration tools on the pin
      (matches `subagent_notifications.rs:2427`).

GO/NO-GO: record findings in this file under "Observed on the pin", like 05.

## Phase 1: Adapter — remove the gate, expose roles

- [ ] 1.1 `server.ts:90` — delete the coding⊕subagents throw. Keep the
      `UPLOADS_DISABLED` image check. Contract (`contract.ts`) already allows
      `subAgents`; no shape change.
- [ ] 1.2 `codex/config.ts` `subAgentConfig`:
      - `hide_spawn_agent_metadata: false` so roles/models are selectable.
      - Register the roles we allow under Codex's `agent_roles` (or rely on
        built-ins `default`/`explorer`/`worker`). Define the exact allow-set in
        one place; reject any other `agent_type` at the adapter boundary.
      - Replace `HELPER_INSTRUCTIONS`/`DELEGATION_HINT` with role-appropriate
        text: keep a short Truex framing but let Codex's native
        `multi_agent_instructions` + role layers drive capability. When coding
        is **off**, keep today's read-only helper text (text chats unchanged).
- [ ] 1.3 `runtime/chat.ts:1633` — scope the `helper_write` decline:
      - **Option B:** decline only when the approval is an **MCP** tool call
        (`meta.codex_approval_kind === "mcp_tool_call"`) from a child thread;
        let coding file/exec approvals from a child follow the normal coding
        path (`onCodingApproval`).
      - **Option A:** remove the child-thread decline entirely.
- [ ] 1.4 Coding approval attribution — `onCodingApproval` must tag a card with
      the requesting agent path so the member can see "helper /root/worker
      wants to run X". Needed because helpers now trigger coding cards.
- [ ] 1.5 Keep all existing routing/usage/watchdog/settle/stop logic from
      `tasks/subagents-plan.md` Phase 1–2 unchanged (helper events off the
      lead's stream, per-helper billing, archive on settle, stop interrupts
      all). Re-run those suites to prove no regression.
- [ ] 1.6 Logs: add `subagent_role` to `subagent_started`; add
      `subagent_coding_write` / `subagent_mcp_write_declined` counters.

## Phase 2: Platform (platform-next)

- [ ] 2.1 `chats.service.ts:1630` — unchanged logic (both switches), but the
      run no longer fails under coding. Remove the "coding refuses helpers"
      assumption from comments.
- [ ] 2.2 `run-executor.ts` — keep `SUBAGENTS_DISABLED` mapping only for **old
      adapters** (pre-this-change) that still throw; it is no longer expected
      from a current adapter with coding on. Note that in `helpers-report.ts`.
- [ ] 2.3 Persist helper **role** on the `agent` row (already persisting task,
      status, usage). One new optional field; backward compatible.
- [ ] 2.4 If a helper runs a coding command, the coding approval card and its
      "Allow for this chat" scope must record which agent asked (so an audit
      shows helper-initiated writes).

## Phase 3: Frontend

- [ ] 3.1 Helper cards show the **role** (Explorer / Worker) next to the task.
- [ ] 3.2 Coding approval cards triggered by a helper say so ("Helper
      /root/worker wants to run …"), reusing the existing coding-card UI.
- [ ] 3.3 Files the lead (or a helper, Option A) writes already render as file
      cards; verify a helper-written file appears once, attributed correctly.
- [ ] 3.4 Agent dialog copy: drop "helpers only read" if Option B lets them
      write files in the sandbox; keep the external-write guarantee wording.

## Phase 4: Measure (before any rollout)

- [ ] 4.1 Real-model eval on Opus (writes files reliably) and nvidia: the
      screenshot-2 task — "spin helpers to prepare a document" — now produces a
      real file, with helpers doing the per-section research and the lead
      assembling the doc. Assert a file is captured, content covers each
      section, nothing invented.
- [ ] 4.2 Collision test: two workers told to write the same file; confirm
      last-writer-wins and no corruption; confirm the worker role's ownership
      instruction reduces this in practice.
- [ ] 4.3 Option B safety: injected "call create_issue" in a helper result —
      MCP write still declined; a helper file write still allowed. (Extends the
      existing injection test.)
- [ ] 4.4 Cost: coding + helpers request sizes and token multiple vs text-only
      helpers (role layers add prompt; measure).

## Acceptance

- Coding on + helpers on in one chat: no `SUBAGENTS_DISABLED`; helpers spawn,
  share the workspace, and the lead assembles a file the member can open.
- A spawned `explorer`/`worker` role narrows tools as Codex defines; unknown
  `agent_type` is rejected at the adapter.
- Option B: a helper can never change an **external** system without approval;
  Option A: documented removal of that guarantee, owner-accepted.
- Every pre-existing sub-agent guarantee still holds: no helper outlives its
  run, all helper tokens billed, stop settles all, reconnect shows same state.
- Flag off (either switch) or coding off → behaviour byte-for-byte as today.

## Rollback

Re-add the `server.ts:90` throw (or flip a new `RUNTIME_SUBAGENTS_WITH_CODING`
env to off). Stored `agent` rows with a role field stay readable. No data
migration.

## Open questions for the owner

1. Option A or B? (external-write guarantee kept or dropped.)
2. Which roles do we expose — just Codex built-ins (`default`/`explorer`/
   `worker`), or a Truex-defined narrowed set?
3. Delegation policy: keep our hint, or adopt Codex's native
   `ExplicitRequestOnly`/`Proactive` (needs Ultra effort to self-delegate)?
4. Per-chat workspace retention when helpers write — same as coding today?

## Implementation status — Option B landed (2026-10-27)

Built the **core** of Option B. Offline suites green: runtime-adapter 296,
platform-next 628, frontend 619, model-gateway 83; typecheck + format clean.

Observed on the pin (first time coding + `multi_agent_v2` ran together), in
`runtime-adapter/test/codex/subagents.test.ts` ("helper agents on a coding
runtime"):

- The combined config is accepted; the lead is offered **both** the coding
  tools (`apply_patch`, `exec_command`, `write_stdin`) **and** the
  `collaboration.*` tools in one request (test "offered the coding tools and
  the collaboration tools together").
- A helper inherits the coding tools and writes a file with `apply_patch` into
  the **shared** workspace; the lead reads it in the same cwd. Shared-fs, as
  Codex intends — no isolation.
- Option B guarantee holds: a helper's **MCP** write is declined
  (`helper_write`) and never reaches the connector, while its **file** write
  lands. A helper's publishing command (`git push`) is declined
  (`helper_command`).

Done:

- 1.1 `server.ts` gate removed. `SUBAGENTS_DISABLED` kept for older adapters.
- 1.2 Coding-aware helper text (`HELPER_INSTRUCTIONS_CODING`,
  `DELEGATION_HINT_CODING`, shared-workspace framing); text chats unchanged.
- 1.3 `helper_write` MCP decline unchanged (already MCP-only).
- Phase 2 platform: gating never checked coding, so no logic change; stale
  "coding refuses helpers" comments corrected; `SUBAGENTS_DISABLED` mapping is
  now the older-adapter path.
- Phase 3 frontend: agent-dialog helper copy made mode-accurate (helpers may
  prepare work; external changes still ask).
- Phase 4 real model (Opus via gateway),
  `test/codex/subagents-coding-real.test.ts` (gated): injection safety holds
  (an injected `create_issue` never ran). Document task: run completes, but
  this Opus profile under coding **misrecognises** the collaboration tools
  ("not available here", reaches for a nonexistent subagent tool) and spawns 0
  helpers / writes nothing. Not an adapter or gateway bug — the adapter sends
  the tools and the gateway forwards `collaboration__spawn_agent` to Opus
  (verified by converting a captured request). Opus delegated fine in TEXT
  mode; it fumbles delegation under coding on this profile.

Deviations from the plan (deliberate, smallest-safe-change):

- **Roles not exposed.** `hide_spawn_agent_metadata` stays `true` (1.2 partial;
  3.1 N/A). Flipping it re-opens per-helper **model** switching against our one
  gateway provider and could let the model pick a read-only `explorer` for a
  writing task; it needs its own pin probe (P0.2/P0.3) and an allow-set. The
  document use-case works without it. 2.3 (persist role) follows this.
- **No UI attribution of helper coding cards (1.4 / 2.4 / 3.2).** Instead a
  helper's publishing command is declined outright (`helper_command`) — simpler
  and safer; no new approval-card surface.

Follow-ups: expose Codex roles behind a probe (unknown `agent_type` rejected,
model pinned to the one provider); a collision test for two workers on the same
file (4.2); evaluate whether offering helpers to a coding agent on a model that
fumbles delegation (this Opus profile) is net-negative, i.e. keep helpers
opt-in per agent.
