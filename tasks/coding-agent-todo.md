# Coding agent tasks

Plan: [coding-agent-plan.md](coding-agent-plan.md). Status: approved 2026-10-21.
Each task is about 3–5 files. Codex behaviour a task relies on is asserted by a
test in `runtime-adapter/test/codex/` against the real pin and the local model
fixture, so a pin upgrade that changes it fails the suite.

Commands: `npm --prefix runtime-adapter test`, `npm --prefix platform-next test`,
`npm --prefix <pkg> run build`, `npm run format:check`, `npm run check:secrets`.

## Phase 1 — Commands and edits with approval

### 1. Runtime coding profile, kill switch and model catalog

- [x] `RUNTIME_CODING_ENABLED=1` (adapter env, default off) turns on one coding profile for every run; no per-agent or per-request switch.
- [x] With it off, Codex params are byte-identical to today (existing pin test unchanged).
- [x] The adapter writes a model catalog per chat home with the run's model: `apply_patch_tool_type: "function"`, the model's context window, shell type for unified exec; pin test asserts the model is offered `apply_patch` as a function tool.

**Files:** `runtime-adapter/src/config.ts`, `src/codex/config.ts`, new `src/codex/catalog.ts`, `src/runtime/chat.ts`, tests. **Deps:** none. **Size:** M.

### 2. Codex coding config and rules file

- [x] Coding runs get shell, unified exec, `apply_patch`, `update_plan`; sandbox `workspace-write` with network off; approval policy `untrusted`; environment and permissions context blocks stay off.
- [x] The adapter writes `home/rules/default.rules`: read commands allowed (`cat`, `head`, `tail`, `ls`, `rg`, `wc`, `pwd`, `git status|diff|log|show`), `git push` always prompts. No `sed`, `find`, `awk`.
- [x] Pin tests: allowed reads run with no request; a write, `sed -i`, `find -delete`, `cat a > b`, `$(…)` and `git push` each raise an approval request; the offered tool list equals the expected set.

**Files:** `runtime-adapter/src/codex/config.ts`, new `src/codex/rules.ts`, `test/codex/coding.test.ts`, model fixture additions. **Deps:** 1. **Size:** M.

### 3. Relay command and file-change approvals

- [x] `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` become `approval.requested` with `kind: "command" | "file_change"`, bounded display fields (command, cwd, parsed actions; changed paths and a bounded diff). Requests for another turn, an unknown item or a finished run are declined, as for MCP.
- [x] Decisions: Allow once → `accept`; Allow for this chat → adapter-held (scope per open question 1), never Codex `acceptForSession`; Deny → `decline`; stop → `cancel`. A `git push` prompt is never satisfied by an allow-for-chat.
- [x] Tests: each decision, expiry, withdraw (`serverRequest/resolved`), restart loses no audit, push asks twice in one chat.

**Files:** `runtime-adapter/src/runtime/chat.ts`, `run.ts`, `contract.ts`, `test/codex/coding-approvals.test.ts`. **Deps:** 2. **Size:** M.

### 4. Command and file-change events

- [x] New events `command.started|output|completed` and `file.changed`, and items `{type: "command"}` / `{type: "file_change"}` in `run.completed` and `run.snapshot`. Output is capped per event and per item (full output stays in Codex history).
- [x] The watchdog treats a running command like an MCP call (its own timeout + grace).
- [x] README contract section updated.

**Files:** `runtime-adapter/src/runtime/chat.ts`, `run.ts`, `README.md`, tests. **Deps:** 2. **Size:** M.

### 5. Platform: store, stream and answer the new items

- [x] Chat store persists command and file-change items and approval records with `kind`; the approval route accepts the new kinds; stream relay forwards the new events.
- [x] Authz unchanged: only the chat's owner sees or answers; bounded sizes enforced on write.
- [x] Tests: persistence, replay after reconnect, foreign-user answer refused.

**Files:** `platform-next/src/modules/chats/chat-store.ts`, `run-executor.ts`, `chats.controller.ts`, `chats.service.ts`, tests. **Deps:** 3, 4. **Size:** M.

### 6. Frontend: approval card variants and activity blocks

- [x] Approval card shows the command or the changed files and diff, with Allow once, Allow for this chat and Deny (push without Allow for this chat).
- [x] Transcript shows command blocks (command, status, collapsible capped output) and file-change blocks.
- [x] Driven in headless Chromium with a mocked API.

**Files:** `frontend/components/approval-record.tsx`, `components/tenant/chat-transcript.tsx`, chat state reducer, styles. **Deps:** 5. **Size:** M.

### Checkpoint A — local coding loop

- [x] All three package suites, builds, format and secrets checks pass.
- [x] In the real app (`npm run dev:next`, macOS Seatbelt, Claude Sonnet 5.5): create a file, edit it, delete it, run a Node and a Python test, write a file with a zsh heredoc, read files back. No approval card on any step: file changes and in-chat commands never ask (granular policy, 2026-10-22); only `git push`, `reset --hard` and `clean` ask. Run 2026-10-23, 7 steps, 10–18 s each.
  - Found and fixed in that run: `node file.js` failed with ERR_INVALID_PACKAGE_CONFIG because Node reads every package.json above a script and the repo's own one sits above the local state directory, unreadable in the sandbox. The adapter now writes a readable empty `package.json` at the top of the state directory when a directory above it has one (none on a deployed runtime). Regression pin test in `test/codex/coding.test.ts`.
  - Seen, not fixed: a delete done with `rm` shows as "Ran a command", not as a deleted file (Codex reports a shell command, not a file change); earlier versions stay in storage. `git init` in the workspace is refused because Codex keeps `.git` read-only (task 14).
- [ ] Human review before Phase 2.

## Phase 2 — Files and documents

### 7. Adapter workspace file operations

- [x] `GET /v1/chats/:chatId/files` and `/file?path` list and read a chat's workspace files (read-only; platform uploads come with task 9). Paths are workspace-relative and confined: no `..`, dot entries, absolute paths or symlinks; 20 MiB per file, 500 files per list.
- [x] Tests: traversal and symlink attempts refused, caps enforced, unauthenticated refused.
- [x] `file_change.progress.preview` streams a new file's text (64 Ki per piece, 256 Ki in all).

### 8. Stored files, file card and viewer

- [x] After each run the platform copies new or changed files to S3 as versions (`chat_files`, index v4), sends `files` before `saved`; owner-only list and content routes (attachment, nosniff).
- [x] File card under the reply (Writing… / ready, Open, Download, version from v2); viewer panel at 560 px with Preview/Source, Markdown, CSV grid, sandboxed HTML, images; opens by itself while a new file is written.
- [x] Driven in headless Chromium against the real adapter and pinned Codex (fixture, memory file store).

### 9. Uploads into the workspace

- [x] Attach files to a message; the platform writes them to `uploads/` in the workspace before the run starts and adds their paths to the message.
- [x] Limits from open question 3; type allowlist (office, PDF, text, code, images).
- [x] Driven in the real app with a real model (DOCX + XLSX read back).

Built 2026-10-23, behind `CHAT_UPLOADS_ENABLED=1` (platform; needs the S3 bucket and `RUNTIME_CODING_ENABLED=1` in the adapter). Each file uploads on its own (`POST /api/v1/uploads?name=`, raw body) to S3 as a staged upload (tenant `chat_uploads`, TTL a day, index v5); the message names up to 10 in `attachments`, and saving it claims them in the same transaction and records each as the next version of `uploads/<name>` in the chat's files (`source: upload`). Before Codex starts, the run writes them through the adapter's `PUT /v1/chats/:id/uploads/:name?sha256` (hidden temp file, SHA-256 checked, rename; symlinked or file-blocked `uploads/` refused) and the model's text lists the paths. Limits: 20 MiB per file, 10 per message, 500 MiB per chat, 30 staged and 3 in flight per member; name, extension and magic bytes checked. No files into a running reply (`CHAT_BUSY`). Frontend: paperclip, drop and paste in the composer, chips with Uploading/failed/Remove, sends when all are uploaded; sent files show above the bubble and open in the viewer; uploads are left out of the reply's file card. The forwarder allows 20 MiB on that route only.

Real-app run 2026-10-23 (`npm run dev:next`, Claude Sonnet 5.5, headless Chromium): an `.exe` was refused in the browser, a text file renamed `.pdf` was refused by the platform (chip shows why, Send disabled), DOCX + XLSX uploaded and sent; the model listed `uploads/`, read both and answered correctly (cutover 14 November, owner, Consulting 11,250 over); no approval card; a file picked while the reply ran couldn't be sent; sent files survived a reload and open in the viewer. Fixed on the way: the viewer said "wasn't saved" for a just-sent file (the chat's files are now re-read after a send with attachments); the Server-Timing test broke because a text-only send gained an `uploads` step (only timed when there are attachments); the compiled platform (`dist`, so the image and `operator` CLI) failed to start since the connectors commit, because Nest tried to inject `ClientSecretResolver`'s `now` parameter (now a field). Dev setup: `CHAT_UPLOADS_ENABLED=1` in `platform-next/.env`, `ensure-tenant-indexes --all` (v5) run on the dev database.

Follow-ups 2026-10-23: attached images (png, jpg, jpeg, gif, webp) now also go to the model as images. The platform sends their `uploads/<name>` paths as `input.images`, and the adapter checks each is a regular file in `uploads/` (no symlink), then adds a Codex `localImage` with the relative path, so no host path reaches the model. Codex keeps the image in the thread, so later turns don't re-read the file. Real run: chart values and a sign's text read correctly in 18 s, with no command run. "Uploading files…" is now grey status text, not an error; chats started with files only name each file once. Deploy the adapter before the platform: an older adapter refuses the new `images` field.

Image previews 2026-10-23: attached images show as pictures, not name chips: a 30 px crop in the composer chip, and the image itself (up to 260 px, 320 px when alone) on the sent message, which opens the viewer. Other files keep their chip. A just-sent image is shown from the picked file's bytes, and those bytes seed the shared content cache under the saved version's ID (paired in send order, only when count and sizes match), so it isn't downloaded again; after a reload each image downloads once. An image that can't load falls back to its file chip. Real run: thumbnails in the composer, images shown at once on send, 0 downloads until reload, 2 after it, viewer opens on click, a forced 500 shows the chips, fine at 420 px wide.

**Files:** platform chats controller/service, runtime client, frontend composer. **Deps:** 7. **Size:** M.

### 10. Toolchains and document libraries

- [x] Image: Python 3 with pinned python-docx, openpyxl, python-pptx, pypdf, reportlab; Node already present. Local dev check script reports missing ones.
- [x] Pin test: a Python and a Node test run inside the sandbox.

Done 2026-10-23. Pins in `runtime-adapter/toolchain/requirements.in`, transitive pins and sha256 hashes in `requirements.txt` (uv, universal, Python ≥ 3.11, wheels only). Image: `toolchain` stage in the root `Dockerfile` builds `/opt/truex/python` (Debian Python 3.13.5) and sets `RUNTIME_TOOLCHAIN_DIRS`; the stage was built for linux/arm64 and the libraries wrote and read a PDF and DOCX in it. Local: `npm run toolchain:setup` / `toolchain:check` (`scripts/toolchain.mjs`, 7 unit tests); `dev:next` warns when coding is on and the toolchain is incomplete. `test/codex/toolchain.test.ts` (real pin, sandboxed): `python3` is the toolchain's, `node --test` and `unittest` pass, and the libraries write and read DOCX, XLSX, PPTX and PDF; it fails against a Python without the libraries. Adapter 180 tests. Not yet verified: the same commands under the Linux sandbox (AgentCore probe), and the full runtime image (needs the Codex artifact).

**Files:** `Dockerfile`, a requirements file with hashes, `scripts/dev-next.mjs` check, test. **Deps:** 2. **Size:** S.

### Skills (S0–S5, before task 11)

Design: [coding-agent-plan.md § Skills](coding-agent-plan.md#skills-agreed-2026-10-23).

#### S0. Real-model probe

- [x] One hand-placed skill as a capability root, real Sonnet 5.5 through the gateway: the `skills` tools survive gateway translation, the model picks the skill from its description, `skills.read` returns references, no absolute paths leak to the model or the stream.
- [x] With coding on locally: a script in the skill directory runs under the sandbox with a read grant, and fails without it.

**Findings (2026-10-23, `.runtime/skills-probe/real.ts`, `real.json`):** coding off, Sonnet 5.5 picked `invoice-check` from its description, read SKILL.md and `references/rules.md`, and cited both rule codes (11.7 s first turn, 4.6 s follow-up); an unrelated question ("capital of France") did not touch the skill (1.9 s). Coding on, the model ran `scripts/total.py` from the read-only skill directory and used its total (15.6 s). No event contained the state directory or the skills path. The model itself sees `skill://truex-skills/<state>/skills/<sha256>`, which names no tenant or chat. A skill pushed for another chat on the same runtime is unreadable from the sandbox (pin test in `test/codex/skills.test.ts`). Codex emits no thread item for `skills.list`/`skills.read`; the call appears only in the thread's rollout file, written before the reply starts, so S5 reads it from there.

**Files:** probe script, findings in this file. **Deps:** none. **Size:** S.

#### S1. Catalog, versions and operator CLI

- [x] `truex_skills` and `truex_skill_versions` in the catalog DB, indexes on `slug` and `(skillId, version)`.
- [x] Operator `putSkill <folder>`: validates the bundle, packs one archive, uploads to S3, inserts the version, then moves `currentVersionId`. Re-running on unchanged content is a no-op (same sha256).
- [x] Repo folder `skills/` with one sample skill.

**Files:** `platform-next/src/modules/skills/`, `modules/operator/operator.service.ts`, `src/cli/operator.ts`, `skills/`, tests. **Deps:** S0. **Size:** M.

#### S2. Agent skill IDs and dialog picker

- [x] `agent.skillIds: ObjectId[]`, validated against enabled catalog skills on save, max 10; existing agents without the field read as `[]`.
- [x] Skills list API for the picker; dialog shows "Unavailable" for disabled skills and "Needs coding" for script skills when coding is off.

**Files:** `modules/agents/agent.ts`, agents service/controller, frontend agent dialog, tests. **Deps:** S1. **Size:** M.

**Built 2026-10-23.** CLI: `skill-put --folder <path-to-skill-folder> [--toolchain]` (skill sources live outside this repo; only S3 `skills/` holds published archives), `skill-enable|skill-disable --slug`, `skill-list`. The packer (`modules/skills/skill-bundle.ts`) is deterministic (same folder, same sha256) and refuses what the adapter would. `GET /api/v1/skills` returns `{skills, scripts}`; `scripts` follows `CHAT_UPLOADS_ENABLED` (coding on). A disabled skill already on an agent may stay; it can't be added.

#### S3. Chat snapshot and delivery to the adapter

- [x] Chat start resolves `skillIds` to `[{ skillId, versionId, sha256 }]`, drops disabled ones, stores the snapshot on the chat.
- [x] Platform reads archives from S3 with an in-memory cache by sha256, PUTs them to the adapter in parallel before `thread/start`, and resends missing hashes on resume.

**Files:** `modules/chats/chats.service.ts`, `run-executor.ts`, `runtime-client.ts`, tests. **Deps:** S2. **Size:** M.

**Built 2026-10-23.** The snapshot (`chat.skills`, with the name at start) comes from the catalog cache, so a publish reaches new chats within 60 s. The run pushes archives before a new thread's first post; on `SKILLS_MISSING` it pushes the named ones and posts again once (`SKILLS_FAILED` otherwise). Archives are cached in memory by sha256 (64 MB LRU) and checked against their digest.

#### S4. Adapter skills route and capability roots

- [x] `PUT /v1/chats/:id/skills/:sha256`: hash check, safe extract (no symlinks, no `..`, size and count caps), atomic rename into `<state>/skills/<sha256>/`; idempotent.
- [x] `thread/start` passes the chat's skill directories as `selectedCapabilityRoots`; with coding on, the permissions profile adds a read grant for them.
- [x] Pin tests on the real pin: catalog lists the skill, `skills.read` works, roots survive resume, a tampered archive is rejected.

**Files:** `runtime-adapter/src/server.ts` (route), `src/runtime/chat.ts`, `src/codex/coding.ts`, `src/contract.ts`, tests. **Deps:** S0. **Size:** M.

#### S5. Activity and events

- [x] Skill use shows as "Used skill <name>" in the transcript (live, snapshot and saved as a `tool` message with `skill`).
- [x] **Script path (found at checkpoint, fixed 2026-10-23):** the model could only see a skill by its stored path, could not list `skills/` to find it, and skipped `word-playbooks`'s own check. Each coding chat with skills now gets `$SKILLS`, a read-only directory of relative links `<slug> → skills/<sha256>/<slug>` rebuilt every run (`linkSkills`), and one instruction sentence naming it. The coding instructions also say "use $TMPDIR, never /tmp". Command rows now show `$SKILLS/<slug>/...`. Pin tests: scripts run from `$SKILLS`; links can't be removed or added; a chat without skills gets neither the variable nor the sentence. Real rerun with Sonnet 5.5 (`word-playbooks` v2): the model called `"$SKILLS/word-playbooks/scripts/inspect_docx.py"`, wrote its build script to `$TMPDIR`, the script's new `warnings` flagged 14 empty paragraphs and it fixed them; the output has no warnings, real title/author/dates, 3 shell calls, no `/tmp` attempt.
- [ ] Follow-ups (separate tasks): turn token counts show only the last model call, and some gateway calls report 0 output tokens with cached input 0; `pwd` and `$SKILLS` expand to a path holding the tenant and chat IDs.

**Files:** adapter event mapping, platform item store, frontend transcript. **Deps:** S4. **Size:** S.

#### Checkpoint S — skills in the real app

- [x] Attach the sample skill to an agent, start a new chat, the model uses it; publish a new version and confirm the old chat keeps the old version and a new chat gets the new one; disable it and confirm "Unavailable".

**Done 2026-10-23** with real Sonnet 5.5 in the browser (`npm run dev:next`, S3 `truexdocs`): the dialog picker attached `invoice-check`; the model read it, ran `scripts/total.py` and applied all four rules; "Used skill Invoice check" showed live and after reload. After publishing v2, the old chat stayed on v1 (sha `cec6e308`) and a new chat got v2 (`8ecdb676`, its new last line appeared). After disabling, the edit dialog showed "Invoice check · Unavailable" and a new chat ran without it. The catalog was left with `invoice-check` v1 enabled.

### 11. Document skills

- [x] Skills to read and create documents through the pinned toolchain libraries, each in the standard bundle shape (SKILL.md + references + a read-only inspect script), published to the catalog like `word-playbooks`.
- [x] Ships through the skills plan's capability roots (no platform code change).

**Done 2026-10-23.** Three skills added under `skills/`, published to the catalog (`truexdocs/skills/`), all enabled:

| Slug | Title | Script | Libraries |
|---|---|---|---|
| `excel-playbooks` | Excel workbooks | `inspect_xlsx.py` (package, fragile parts, per-sheet formulas/errors/validations, `--text` dump) | openpyxl |
| `powerpoint-playbooks` | PowerPoint decks | `inspect_pptx.py` (slides, shapes, empty placeholders, off-slide shapes, alt text, notes, `--text`) | python-pptx |
| `pdf-playbooks` | PDF files | `inspect_pdf.py` (pages, text layer, fonts/embedding, forms, bookmarks, encryption, `--text`) | pypdf, reportlab |

Each SKILL.md follows `word-playbooks`: a step-0 state classification, a routing table into `references/`, and completion gates that require the inspect script's `warnings` to be empty on every output. The references state the real limits of the image (no pandas/numpy/matplotlib, no OCR, no slide/page rendering, Latin-only fonts, AES PDF encryption unavailable without `cryptography`, Office-to-PDF loses layout) so the model never claims a check it cannot make. Every python-pptx/openpyxl/pypdf snippet in the references was run against the pinned toolchain before shipping; two inspector bugs found this way were fixed (openpyxl `ws.tables.items()` returns name/ref strings; python-pptx sets a picture's file name as alt text).

**Verified in the real app** (API driver + real Sonnet 5.5, agent temporarily carried all three skills): the model built an XLSX (Orders sheet, 7 formulas, bar chart, total row), a 4-slide PPTX (takeaway titles, native chart, speaker notes) and a one-page PDF (title/author set), each with its skill row in the transcript, `warnings`-clean on its own inspector, summed turn usage, and no tenant/chat/`/mnt/state`/`skills/<sha>` path in the stored messages (`$SKILLS` shown where scripts ran). Test sessions revoked; agent restored.

**Follow-up (not blocking):** `cached` tokens are 0 on every call — the Kiro proxy upstream reports no cache_read/creation and buffers tool_use responses (output_tokens 0 mid-turn). Recorded as a separate task.

**Files:** `skills/{excel,powerpoint,pdf}-playbooks/`. **Deps:** 10, S0–S5. **Size:** M.

### Checkpoint B — files

- [x] Upload a DOCX and an XLSX, get a summary, get a generated PPTX and download it, in the real app.

**Result (2026-10-23, headless Chromium, Sonnet 5.5, Invoice desk with the Word, Excel and PowerPoint skills):** both files uploaded through the composer; turn 1 (26 s, 22.2k in) summarized the brief and the workbook, recomputed the formula-only total row (5,220k EUR, matches the fixture) and flagged what the brief leaves out. Turn 2 (78 s) produced `northwind-expansion-board.pptx`: 5 slides with takeaway titles, a native chart, a risk table and notes on every slide; `inspect_pptx.py` reports no warnings. Downloaded through the file panel's Download button. No tenant ID, chat ID, `/Users/`, `/mnt/state` or `/tmp/` in the stored messages; commands show `$SKILLS` and `$TMPDIR`. No console errors.

## Phase 3 — Network and credentials for every connector

Revised 2026-10-23: network and credentials are one generic layer that every
connector uses; git is only the first connector through it. Design:
[coding-agent-plan.md § Network and credentials](coding-agent-plan.md#network-and-credentials-revised-2026-10-23).
Decisions agreed 2026-10-24 (plan § Decisions): every connection works from the
sandbox automatically; writes ask with Allow once / Allow for this chat / Deny,
critical actions always ask; tenant admin host allowlist now; unlisted hosts ask.

### P0. Probe the pin's network proxy

- [x] With our coding profile plus a network section: an allowed host works, an unlisted host is handled, a private/loopback target is refused, a direct connection that skips the proxy fails.
- [x] How a write to a credentialed host can be held (method visibility on HTTPS) and how the credential broker is configured per run.

**Findings (2026-10-24, `.runtime/network-probe/probe.ts`, macOS Seatbelt, real pin, model fixture):**

- Config that works: `features.network_proxy = { enabled, credentials }`, `features.credential_masking = true`, and `network = { enabled, mode: "full", domains, allow_local_binding: false, mitm.hooks }` inside our `permissions.truex` profile. Commands get `HTTP(S)_PROXY`, `ALL_PROXY`, npm/pip/git/Node CA variables; the CA bundle under the chat's Codex home is readable from the sandbox even with the state directory denied.
- Allowed host: `curl`, `node fetch`, `git clone` and Python urllib reach it. Python failed certificate checks only through the MITM path with the system Python 3.9 (it ignores `SSL_CERT_FILE` there); recheck with the image's Python in task 14.
- **Unlisted host: refused, never asked.** Codex's inline network approval (`networkApprovalContext`) only runs when managed requirements exist (`/etc/codex/requirements.toml`, MDM or the ChatGPT cloud bundle; `session.rs` `managed_network_requirements_configured`). We can't set those per process, and not at all on a dev laptop without root. The command fails with a stable message, `Network access to "example.com" was blocked: domain is not on the allowlist for the current sandbox mode.`, on `item/completed` (status `failed`).
- Private targets: a name that resolves to loopback (`localtest.me`) and `127.0.0.1` are refused (`local/private network addresses are blocked`). **An IP literal put on the allowlist is let through** (169.254.169.254 was tried and timed out), so hosts must never be IP literals; metadata addresses get explicit `deny` entries too.
- Skipping the proxy (`curl --noproxy '*'`) fails: no DNS inside the sandbox.
- Credential broker: a configured provider (`env`, `patterns`, `url_prefixes`, `auth`) with the token in `shell_environment_policy.set`. Commands see a dummy (`echo` and `env`); the proxy swaps in the real token only for URLs under the prefixes (`/anything/` got the real one, `/headers` on the same host got the dummy); no header, nothing added. The token appears in no file under the Codex home except command output when a server echoes it back. Git uses it through a credential helper set by `GIT_CONFIG_*` variables (Basic `x-access-token:<dummy>`).
- Method visibility: MITM hooks see method and path on HTTPS. **A host with hooks admits only requests that match one** (`HTTPS request denied by MITM hook policy.`, exit 0), so `reads` rules become hooks (GET/HEAD, and `POST pattern:/**/git-upload-pack` for git fetch). The broker injects before hook actions run. A hook-denied request names no host and raises no Codex event; there is no "ask" action.
- Consequence for tasks 13–15: nothing in the sandbox can be asked about *before* it is sent. Unlisted hosts and connector writes are blocked first; the adapter turns the block into a card (Allow once / Allow for this chat / Keep blocked) that applies from the next reply. Agreed by the user 2026-10-24 ("continue"): block-then-ask everywhere, no managed requirements file.

**Files:** pin tests in `runtime-adapter/test/codex/`. **Deps:** none. **Size:** S.

### 12. Egress profile on connectors and a per-run network policy

- [x] Catalog connectors gain an `egress` block (data, operator CLI only): `hosts` the connector talks to, `credential` (header, scheme, URL prefixes the user's token may be sent to), `reads` (methods that pass without asking), `critical` (requests that always ask). Validated on write; MCP `url` host must be in `hosts`. Connectors without `egress` stay MCP only.
- [x] Tenant admin host allowlist (hosts without a token), stored per tenant, admin-only API; private addresses and wildcards over public suffixes refused.
- [x] Each run gets one `network` policy built by the platform from: the baseline (npm, PyPI), the tenant allowlist and the chat owner's active connections on the agent. Nothing from the model or the message can add a host.
- [x] GitHub's catalog document filled in first (github.com, api.github.com, git over HTTPS). Definition validated with `parseConnectorSpec` (`.runtime/mcp-e2e/github-write.json`); not yet put into the shared catalog DB, which waits for the adapter side (tasks 13–14).
- [x] Tests: foreign user's connection never in the policy; `needs_reconnect` connection drops its hosts; invalid egress refused.

**Files:** `platform-next/src/modules/connectors/connector.ts`, operator CLI, `chats/run-executor.ts`, `runtime-adapter/src/contract.ts`, tests. **Deps:** none. **Size:** M.

**Done 2026-10-24:** `CHAT_SANDBOX_NETWORK=1` (platform, default off) adds `network` to every run; the adapter parses it (`contract.ts`, host rule repeated: names only, no IP literals or local zones) and keeps it out of the request hash. Tests: `test/unit/network-policy.test.ts`, `test/integration/network.test.ts`, connectors §7c, `chats-input` config test, adapter `start-run network contract`. platform-next 533/533, adapter unit 126/126.

### 13. Managed proxy with the policy (no credentials yet)

- [x] Coding runs use Codex's network proxy, deny by default; policy hosts allowed; private, loopback and link-local addresses (including 169.254.169.254) refused even through an allowed name, with explicit deny entries for metadata addresses; any other host is blocked and the adapter turns the block into a network card (Allow once / Allow for this chat / Keep blocked) that applies from the next reply (block-then-ask, P0).
- [x] Pin tests: `npm install` from the registry works; `curl` to an unlisted host asks; direct connection bypassing the proxy fails; an allowed name resolving to a private IP is refused.

**Files:** `runtime-adapter/src/codex/config.ts`, `src/codex/coding.ts`, tests. **Deps:** 12. **Size:** M.

**Done 2026-10-24** (`src/codex/network.ts`, `test/codex/network.test.ts`, 11/11 on the real pin, local HTTPS fixture): unlisted host → one `network.blocked` card per site; private/metadata refused with no allow; `--noproxy` fails; no policy keeps commands offline. `npm install` against the real registry is rechecked in the real-app run (task 16).

### 14. Credential broker for any connector

- [x] For each policy connector with `egress`, the adapter configures one broker provider (URL prefixes, header, scheme) and hands the token only to the Codex process; commands see a dummy. One code path for every connector.
- [x] Credentialed hosts go through the proxy's inspecting mode so the method is visible: `reads` methods pass; any other method asks with Allow for this chat; `critical` requests ask every time.
- [x] Token never in logs, events, stored Codex params, or the sandbox (`env`, `/proc`, files); never sent to a host outside its URL prefixes.
- [x] Pin tests with a local HTTPS fixture serving both a JSON API and git over HTTP: GET passes with the real token at the fixture, POST asks, the sandbox shows only the dummy, the same token is not sent to a second fixture host.

**Files:** `runtime-adapter/src/codex/config.ts`, `contract.ts`, test fixture, `platform-next/.../run-executor.ts` (token per run). **Deps:** 13. **Size:** L.

**Done 2026-10-24** (same test file): token only under its URL prefixes, stand-in in the sandbox, not in any event/log/file; reads pass, writes blocked → card (`grant: chat`), critical → `once`, read-only connection → `none`; a granted write passes on the next run. "Asks" means block-then-ask (P0).

### 15. Network approvals and audit, generic

- [x] Network cards (block, then ask): the adapter's `network.blocked` becomes a role `tool` message with `network` (host, method, kind, connector, critical, grant). The platform recomputes the offered answer itself (`networkBlockOf`, `reconcileBlock` against the run's own policy and catalog rules), never trusting the runtime's. Owner-only `POST /chats/:id/messages/:messageId/network` with `allow_once` / `allow_for_chat` / `keep_blocked`; first answer wins; at most 50 grants per chat. Grants widen the next run (`applyNetworkGrants`, checked again: public hosts only, writes only on a read_write connection in the run, critical never for the chat); Allow once is used by one reply.
- [x] MCP side of the same rule: catalog `criticalTools` (a subset of `writeTools`) ask every time; Allow for this chat never covers them (platform drops them from approvedTools, adapter too). MCP URLs naming an IP literal or a local/metadata name are refused in the catalog and the adapter.
- [x] Audit: every block and every answer in the tenant's `tool_approvals` (`kind: "network"`, host, method, kind, connector, decision; no bodies, no tokens); every allow also in `security_audit` (`chat.network.allow`). Connector tool approvals were already recorded.
- [x] Real app (browser fixture: real platform, adapter, pinned Codex with coding + `CHAT_SANDBOX_NETWORK`, headless Chromium, `.runtime/network-browser/drive.mjs`): `curl https://example.com` blocked → card after the command → Allow for this chat → Try again → HTTP 200, no new card; answer survives reload; Try again only on the latest reply; `localtest.me` allowed by name is still refused at connect time and its card offers nothing; no console errors.

**Done 2026-10-24.** Tests: platform `network-grants` unit, `network` integration (owner-only, offered answers, once vs chat, audit), `catalog-connectors` unit; adapter pin `network.test.ts` 12/12 (incl. a command printing a fake violation line raises no card, card order), `mcp.test.ts` critical tool; frontend `tenant-network.test.ts`.

### 16. First connector end to end: GitHub

Decided 2026-10-24: **pushing code goes through the GitHub MCP tools only**
(`create_or_update_file`, `push_files`, `create_branch`, `create_pull_request`,
`update_pull_request`), each asking before it runs; `delete_file` and
`merge_pull_request` are critical (ask every time). The sandbox uses the
connection for reads only (clone, fetch, API GETs); a sandbox write to GitHub
is blocked by the generic write rule and offered as a card like any other.
No git-specific rules, no `.git` write access, no agent-branch rule.

- [x] Definition in the repo: `platform-next/catalog/connectors/github.json` (validated by `test/unit/catalog-connectors.test.ts`).
- [x] Real run (2026-10-24, user's dev:next on :3000, real GitHub connection, agent "Ashok"): github catalog put to revision 3 (egress), `CHAT_SANDBOX_NETWORK=1`. Verified live: repo list, `git ls-remote` on a private repo, `git clone`, `npm view` and a Node `fetch` to api.github.com all pass as reads; the real token reaches only github prefixes and the sandbox sees only the dummy (model confirmed, and refused to print it); `POST /issues` is blocked and offered as critical (Allow once only — the block has no path, so any POST to api.github.com is treated as critical: stricter but safe); example.com is blocked, Allow for this chat + Try again then succeeds and stays allowed; no token in any stored message/run; one `chat.network.allow` audit row in the catalog DB, deny rows in the tenant `tool_approvals`. The 169.254.169.254 / loopback block was not reproduced in-app (the model declined those turns with empty output); it rests on the adapter pin test. Code pushing stays MCP-only, as decided, so no sandbox push was tested.

**Files:** GitHub catalog document, tests. **Deps:** 14, 15. **Size:** S.

### 17. Second connector with no new code

- [x] Gmail's network data written as catalog data only (`platform-next/catalog/connectors/gmail.json`): hosts, bearer token for `https://gmail.googleapis.com/`, reads GET/HEAD, sends and deletes critical. Both connections in one run keep separate hosts, tokens and rules (`catalog-connectors.test.ts`). No connector code was needed.
- [ ] Real Gmail run: blocked on the Google Cloud OAuth setup (clientId placeholder), as before.
- Open: Gmail says "Truex never sends email", but its `gmail.compose` scope can send. From the sandbox a send is critical (asks every time) rather than impossible. A "never" rule list in `egress` would make it impossible; needs a decision.

**Deps:** 16. **Size:** S.

### Checkpoint C — complete locally

- [x] Backlog "done when" met locally, except the AgentCore items and the two real-account runs above.
- [x] Security review of the diff (independent reviewer, 2026-10-24): no Critical or High. Acted on: the card's critical/grant now comes from the run's policy (`reconcileBlock`), and a pin test shows command output can't fake a block. Residual: blocks are read from Codex's own stderr log line; safe because command output never reaches that stream (pinned), and a forged block can only name a public host the owner must still allow.
- [x] Gates 2026-10-24: platform-next 552/552, runtime-adapter 258/258 + network pin 12/12, frontend 573/573; typecheck, prettier, `npm run build` (platform, adapter), `next build` (frontend) clean.
- [x] Pre-commit gates 2026-10-24: gateway 76/76, platform-next 552/552, frontend 572/572 on the committed tree. runtime-adapter 259/259 on a rerun; the first run failed once ("an attached image reaches the model as an image", status `failed` after 64 s), which passes alone, in its file and in the rerun. Open: find what made that run fail.
- [ ] AgentCore stays `RUNTIME_CODING_ENABLED=0` and `CHAT_SANDBOX_NETWORK` off until the deferred probe passes.

