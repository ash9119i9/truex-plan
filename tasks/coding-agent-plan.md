# Plan: coding agent on platform-next, using Codex's own tools

Date: 2026-10-21. Status: approved 2026-10-21; Phase 1 in progress. Backlog item:
[04-coding-agent-codex-tools.md](../backlog/features/04-coding-agent-codex-tools.md).
Tasks: [coding-agent-todo.md](coding-agent-todo.md).

## Goal

In any chat, with any agent, the user can upload documents, have
the agent read them, create documents and code, run tests in Node.js or Python,
edit and delete files, and push to their own git host. Everything except reads
asks for approval (Allow once, Allow for this chat, Deny; push always asks).
Generic across git hosts, per user, built from Codex features. `vendor/codex`
is not modified.

## Scope of this plan

In: everything in the backlog item except the AgentCore probe.
Deferred: the AgentCore probe (bubblewrap/user namespaces, `/proc` exposure,
image runtime check). Until it passes, **coding stays off in the AgentCore
deployment** (adapter flag `RUNTIME_CODING_ENABLED`, default off), so building
this does not change production.

Development and tests run locally. On macOS, Codex sandboxes commands with
Seatbelt instead of bubblewrap, so every rule, approval and network behaviour
below is testable on a laptop against the real pin. Only the Linux sandbox
itself waits for the probe.

## Existing flow this builds on

```text
frontend ─► platform-next chats ─► runtime-adapter ─► codex app-server
             (authz, Mongo, SSE)     (config, events,     (tools, sandbox,
                                      approvals)           approvals, fs/*)
```

- `runtime-adapter/src/codex/config.ts` is the only place Codex config is
  built. Today it is text-only (`shell_tool: false`, `sandbox: "read-only"`,
  `approvalPolicy` "never" or MCP-elicitations only).
- `runtime-adapter/src/runtime/chat.ts` already relays MCP approvals: it emits
  `approval.requested` / `approval.resolved`, holds "Allow for this chat" itself
  (Codex's session memory is lost on restart and would bypass the audit), and
  declines anything it can't match to a known call.
- platform-next persists items (`reply`, `input`, `tool`) and approval audit
  records in `modules/chats/chat-store.ts`; the answer route is
  `POST chats/:id/runs/:runId/approvals/:approvalId`.
- Per-user OAuth tokens already exist in `modules/connectors` (encrypted with
  `token-crypto.ts`).
- Each chat already has its own `workspace` directory in the adapter's state.

## Architecture decisions

1. **Every agent, one profile.** There is no per-agent or tenant switch: every
   agent gets the same Codex tool capabilities. They are defined once, in the
   adapter's code (`src/codex/config.ts`, `src/codex/rules.ts`), not in
   MongoDB, so a rule only changes through review and the pin tests. Agents
   keep instructions, model and connectors. `RUNTIME_CODING_ENABLED` (default
   off) is an operator kill switch only; while off, runs keep today's
   text-only params byte for byte. It stays off in AgentCore until the
   deferred probe passes.
1a. **Model catalog.** The adapter writes a Codex model catalog
   (`model_catalog_json`) with an entry per model it serves, so gateway models
   get `apply_patch` in the `function` form (the gateway drops freeform tools
   for Anthropic, Chat Completions and Gemini) and their real context window
   instead of the 272k × 95% fallback. The catalog is read once per Codex
   process, which matches one process per chat.
2. **Codex does the work.** `exec_command`, `write_stdin`, `apply_patch`,
   `update_plan`, `request_user_input`; the `truex` permissions profile.
   Revised 2026-10-22: files and commands inside the chat no longer ask.
   Approval policy is granular (`sandbox_approval: false`, `rules: true`,
   `mcp_elicitations: true`): prompt rules ask (`git push`, `git reset --hard`,
   `git clean`); Codex itself refuses escalation, patches outside the
   workspace and `rm -f`/`sudo`. The platform's file versions replace
   per-file approval (Phase 2). Superseded: `untrusted` + read allow list.
3. **One approval path.** Command, file-change and network approvals reuse the
   MCP approval event, store and card, with a `kind` field. "Allow for this
   chat" stays adapter-held, same reason as MCP.
4. **Files through app-server `fs/*`.** Uploads, downloads and the files panel
   use `fs/writeFile`, `fs/readFile`, `fs/readDirectory`, limited to the chat's
   workspace. No model tool for this.
5. **Network deny by default, for every connector.** Codex's managed network
   proxy; the allowlist is built per run from package registries and the
   hosts declared by the user's connected connectors. Anything else asks.
   Revised 2026-10-23, see [Network and credentials](#network-and-credentials-revised-2026-10-23).
6. **Credentials stay in the proxy, for every connector.** A connector's
   per-user token goes to Codex's credential broker for that connector's URL
   prefixes; commands see only a dummy. Git is the first connector, not a
   special case.
7. **Documents through skills,** depending on the skills plan's capability
   roots. Python document libraries are added to the image, pinned.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Linux sandbox doesn't run in AgentCore | High | Coding off in AgentCore until the deferred probe passes |
| A read rule lets a write through (`sed -i`, `find -delete`, redirects) | High | Allowlist excludes them; pin tests assert each one asks |
| Token readable from the sandbox | Critical | Broker only; pin test asserts the sandbox sees the dummy; push off in AgentCore until probe |
| Approval fatigue makes users click Allow blindly | Medium | Allow for this chat; reads never ask |
| Command output floods the stream or Mongo | Medium | Bounded output in events and storage; full output stays in Codex |
| `experimental_network` / broker config changes on a pin upgrade | Medium | Pin tests fail on change |
| Workspace grows without bound | Medium | Upload and file-size caps; workspace quota check |

## Decisions (2026-10-21)

1. Allow for this chat, for commands: re-allows only that same command. File
   edits: all edits in this chat. Push always asks.
2. No per-agent switch; every agent gets the capabilities (decision 1 above).
3. Uploads: 20 MB per file, 10 files per message, 500 MB per workspace.
4. Git token: both sources (a connector's OAuth token for that host, or a host
   and token added in Connected tools), behind one "git host" record.
   Superseded 2026-10-23: there is no git host record. The token is the user's
   connection to the connector; a user-added token becomes a later connector
   auth type, usable by any connector.
5. Runtime profile in code, not MongoDB.
6. Gateway models use the `function` form of `apply_patch`.
7. Document skills (Task 11) wait for the skills build.
8. Prompt injection hardening is the next design topic, beyond approval cards.

## Network and credentials (revised 2026-10-23)

Status: agreed 2026-10-24 (decisions below); building. Replaces the git-specific tasks 12–15.

### Problem

The earlier plan treated git as special: a "git host" record, a git-only
allowlist entry, a push-only approval rule. Every connector a user connects
(GitHub, Gmail, later SAP and others) has the same three questions: which
hosts may it reach, whose token goes with the request, and which requests
change data. Answering them per connector would mean new code per connector.

### Two egress channels, one policy

| Channel | Who sends the request | Today | Generic rule |
| --- | --- | --- | --- |
| MCP tool call | Codex process, outside the sandbox | Per-user token in the MCP headers; write tools ask | Unchanged; the MCP URL's host must be one of the connector's declared hosts |
| Sandbox command (`git`, `curl`, `npm`, a Python script) | A command in the sandbox, through the proxy | Network off | Deny by default; allowed hosts and injected tokens come from the same connector data |

### What a connector declares (catalog data, operator only)

```text
egress:
  hosts:       [github.com, api.github.com]      # where it may connect
  credential:  { header: Authorization, scheme: Bearer,
                 urlPrefixes: [https://github.com/, https://api.github.com/] }
  critical:    { methods: [DELETE], paths: [...] } # always ask (decision 2)
  reads:       [GET, HEAD, OPTIONS]               # pass without asking
```

Adding a connector is one more catalog document. No connector name appears in
platform or adapter code.

### Per-run policy

```text
baseline (npm, PyPI)
  + chat owner's active connections on this agent  ── hosts, credentials
  = run network policy ──► adapter ──► Codex proxy domains + broker providers
```

The platform builds it at run start, after token refresh. A disconnected or
`needs_reconnect` connection drops out at the next run. The model, the
message and the workspace cannot add a host or a credential.

### Security rules

1. Deny by default. Unlisted hosts raise a network approval; nothing reaches
   them silently.
2. Private, loopback and link-local addresses (AWS metadata
   `169.254.169.254`) are refused even when an allowed name resolves to one.
3. A token is sent only to its connector's URL prefixes. It never reaches the
   sandbox (dummy in `env`), logs, events, stored params or files.
4. Only the chat owner's connections; another member's or another tenant's
   are never in the policy.
5. Reads pass; writes ask. For MCP that is the connector's write tools
   (exists). For sandbox requests to a credentialed host, any method outside
   `reads` asks; Allow for this chat covers later writes except critical
   ones (decision 2). Code reaches GitHub through its MCP tools
   (decision 7); a sandbox `git push` is just a blocked write like any
   other, with no git-specific rule.
6. No direct egress: the sandbox reaches the network only through the proxy.
7. Every network decision is audited: user, tenant, chat, host, method,
   connector, decision. No bodies, no tokens.

### Known limits

- An allowed host can still receive data the model chose to send (a gist, an
  email draft). Rule 5 makes every such write visible and approved; it does
  not judge the content. Prompt-injection hardening (decision 8) is the next
  layer.
- Method checks on credentialed hosts need the proxy's inspecting (MITM)
  mode, which the broker needs anyway. Uncredentialed allowed hosts
  (registries) are tunnelled, so their method is not checked.
- Whether MCP headers reach any Codex file on disk is unverified; task 14
  asserts it.

### Decisions (2026-10-24)

1. **Every connection works from the sandbox automatically.** No per-connector
   `sandbox` switch for users: a connector with `egress` data is reachable by
   commands as soon as the member has connected it. The operator can still
   leave `egress` out of a connector's catalog document.
2. **Ask, then Allow for this chat, except critical actions.** A connector
   write asks with Allow once / Allow for this chat / Deny. After Allow for
   this chat, later writes to that connector in that chat pass, except
   actions the connector's catalog data marks critical (deletes, force
   pushes, history rewrites, sending to someone outside the company,
   permission or sharing changes, billing), which ask every time. The same
   rule covers MCP write tools and sandbox requests.
3. **Tenant admin host allowlist, now.** Admins add hosts that need no token
   (company APIs, internal docs on public addresses). Private addresses stay
   refused whatever the list says.
4. **Unlisted hosts ask.** Allow once / Allow for this chat / Deny.
6. **Block, then ask (2026-10-24, after the P0 probe).** The pin can't pause a
   sandbox request for approval without a machine-wide managed requirements
   file, so unlisted hosts and sandbox connector writes are blocked first and
   the block becomes a card (Allow once / Allow for this chat / Keep
   blocked; critical: Allow once only) that applies from the next reply, with
   a Try again action. Same behaviour on laptops and AgentCore. MCP write
   tools still ask before they run. Allowlist entries are names only, never
   IP literals; metadata addresses get explicit deny entries.
5. **Scope.** The allowlist and unknown-host prompts are for the sandbox
   only. Connector rules (tokens, approvals, critical actions, audit) apply
   wherever the connector is used. Our own tools (web search and page
   reading, a separate later task) run on our side; they only refuse
   private addresses and are audited.
7. **Pushing code goes through MCP only (2026-10-24).** GitHub writes
   (branches, commits, PRs) use the GitHub MCP tools, which ask before they
   run. The sandbox uses a connection to read (clone, fetch, GETs). No git
   write access to `.git` and no git-specific push path is built.

### What decides each sandbox request

```text
host private / loopback / link-local ............ refused (always)
host of an active connection (egress.hosts) ...... allowed; token added for its
                                                   URL prefixes; writes ask (2)
baseline registries (npm, PyPI) .................. allowed
tenant admin allowlist ........................... allowed
anything else .................................... ask (4)
```

How a write is detected (method on HTTPS needs the proxy to see the request)
is fixed by the P0 probe before task 13.

## Skills (agreed 2026-10-23)

Task 11 depends on these. Tasks S0–S5 in
[coding-agent-todo.md](coding-agent-todo.md).

```text
operator CLI ─► S3 archive + truex_skill_versions ─► truex_skills.currentVersionId
agent.skillIds ─► chat start: snapshot versions ─► platform reads archive (cached by sha256)
  ─► PUT adapter /v1/chats/:id/skills/:sha256 ─► verify, extract <state>/skills/<sha256>/
  ─► thread/start selectedCapabilityRoots ─► model uses skills.list / skills.read
```

1. **Catalog like models.** Global operator catalog `truex_skills { _id, slug,
   name, description, enabled, currentVersionId }`; no tenant allow-list in v1.
   Versions are immutable: `truex_skill_versions { skillId, version, s3Key,
   sha256, sizeBytes, requires }`. Publishing changes only `currentVersionId`.
2. **Agent reference.** `agent.skillIds: ObjectId[]`, max 10, pointing at the
   skill, never a version. Names resolve through a cached catalog read.
3. **New chats only.** A chat stores `[{ skillId, versionId, sha256 }]` at
   start; later publishes or disables never change it. A disabled skill on an
   agent is dropped from new chats and shown as "Unavailable" in the dialog.
4. **Bundle format.** One source folder per skill (kept outside this repo), with
   `SKILL.md` (frontmatter `name`, `description`), optional `references/`,
   `scripts/`, `assets/`. The CLI packs it into one archive at
   `<CHAT_FILES_S3_BUCKET>/<prefix>skills/<skillId>/<sha256>.tar.gz` and
   rejects missing frontmatter, unknown top-level entries, symlinks, `..`
   paths, more than 5 MB or too many files, and `requires` packages the image
   toolchain does not ship (`runtime-adapter/toolchain/requirements.in`).
5. **Delivery like uploads.** The platform pushes archive bytes to the adapter
   before `thread/start`, in parallel, and resends any hash the adapter reports
   missing on resume. The adapter gets no AWS credentials or S3 access. The
   skills route works with `RUNTIME_CODING_ENABLED` off.
6. **Outside the workspace.** Extracted skills are read-only and
   content-addressed under the adapter state, never in the workspace or the
   files panel. With coding on, the permissions profile gets a read grant for
   the skill directories so scripts run.
7. **Scripts ship.** They run only where coding is on; in AgentCore that waits
   for the sandbox probe. The agent dialog labels script skills
   "Needs coding" where coding is off.
8. **S3 versions are never deleted** while any chat references them.

Follow-up: scope the platform role to read-only on the `skills/` prefix.
