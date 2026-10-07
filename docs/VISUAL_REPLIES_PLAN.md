# Visual replies: verified architecture and implementation plan

Status: implemented locally, 2026-10-07; deployment remains separate.
The implementation retains existing Visualize and adds tool-driven visual replies.
See [operation and verification](VISUAL_REPLIES.md) for configuration, measured
results, checks and remaining validation limits.

## Decision

Implement T3's `html_preview` -> `html_render` workflow as the new agent-facing
visual reply capability. A user-facing integrated browser is **not a
prerequisite**. Add an isolated headless HTML preview service and tool-driven
publication; keep browser tabs, navigation, shared browsing sessions, and browser
automation as a separate product feature.

The current Visualize feature is custom Truex code exposed through Codex dynamic
tools, not a Codex built-in rendering service. Its storage, authorization and
sandboxed viewer are possible integration foundations. Its registration and legacy marker workflow remain supported. New conversations
also receive `html_render`, plus `html_preview` when a runner is configured.

### Parity status

This implementation adapts the T3 workflow; it is not an exact port. It uses
Truex's tool adapter, storage, authorization and viewer rather than T3's service
code. Matching tool names alone would not establish equivalent behavior.

| Behavior          | T3 implementation                                                         | This proposal                                              |
| ----------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Agent workflow    | Preview, inspect/fix, then publish                                        | Same intended workflow                                     |
| Publication       | Tool-driven thread attachment, independent of final-text markers          | Same intended user behavior using Truex persistence        |
| Source document   | Complete HTML document                                                    | Complete documents plus legacy fragment compatibility      |
| Remote resources  | HTTP(S) resources/CDN libraries can load                                  | Denied under current Truex policy                          |
| Local images      | Absolute-path images automatically embedded                               | No host-path discovery or automatic embedding              |
| Limits            | 512,000 HTML characters; title up to 200 characters; frame height 80-2000 | Current Truex limits retained; frame height 160-900        |
| Responsive sizing | Optional measurements at nine widths plus client sizing                   | Client resize messages; server width measurements deferred |
| Clients           | Web/desktop iframe and native mobile WebView                              | Truex web, including responsive mobile web                 |
| Tool transport    | T3's built-in MCP toolkit and invocation context                          | Truex's existing dynamic-tool adapter                      |

Exact behavior parity would require resolving each difference and adding
observable acceptance tests against the T3 reference. Reusing T3 source would
still require integrating its service dependencies and contracts into Truex;
this plan does not claim that such reuse has happened.

The three capabilities have different requirements:

| Capability                     | Required foundation                                                          |
| ------------------------------ | ---------------------------------------------------------------------------- |
| Display an interactive visual  | Saved HTML, conversation association, authorized retrieval, sandboxed iframe |
| Let the agent check its output | Headless Chromium, screenshot/console/height capture, model image delivery   |
| Browse websites together       | Navigation, browser sessions, interaction tools, streaming and browser UI    |

Implement product-owned tools through Truex's existing dynamic-tool adapter. No
new user-configured MCP connection, standalone visualization skill, change to
the pinned Codex engine, or permission to execute host commands is needed.

## Evidence inspected

Local Truex `main`: `5de52da75c2e51ed34dad24e96a52db4e58a2915`.
Local T3 `main`: `9503155da67add4fbd7fbc51c99ec19a0c8c4a2c`, dated 2026-10-06.
Both worktrees were clean before this audit. No remote-main freshness claim is
made; this review did not fetch upstream. Three sub-agents separately reviewed T3,
Truex backend, and Truex frontend.

Root [AGENTS.md](../AGENTS.md) requires inspection, smallest safe changes,
observable acceptance criteria, adversarial review and appropriate verification.
It does not require an integrated browser or define an additional product-building
MCP. [Frontend instructions](../frontend/AGENTS.md) additionally require reading
the installed Next.js documentation before changing frontend code.

### T3 reference implementation

Paths below are relative to `/Users/ashok/t3code`:

| Source                                                       | Verified behavior                                                                                               |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/mcp/toolkits/html/tools.ts:25`              | `html_preview` accepts a complete document and returns PNG, console diagnostics and content height              |
| `apps/server/src/mcp/toolkits/html/tools.ts:70`              | `html_render` accepts HTML, title and frame height                                                              |
| `apps/server/src/mcp/toolkits/html/handlers.ts:43`           | Publication is scoped to the invoking thread's live run                                                         |
| `apps/server/src/htmlRender/HtmlRender.ts:370`               | Explicitly states: "Never installs the browser: html_render must not depend on it"                              |
| `apps/server/src/htmlRender/HtmlRender.ts:416`               | Saves an HTML attachment; browser-based width measurements are optional and failure does not prevent publishing |
| `apps/server/src/preview/PreviewBrowser.ts:24`               | HTML previews and browser tabs share executable installation, with separate consumers                           |
| `apps/server/src/htmlRender/headlessChrome.ts:40`            | Headless preview runs on a synthetic web origin with public-network proxy restrictions                          |
| `apps/server/src/provider/T3OrchestrationInstructions.ts:35` | Agent receives preview-before-publication instructions directly                                                 |
| `apps/web/src/session-logic.ts:701`                          | A successful render tool result becomes a visual timeline row                                                   |
| `apps/web/src/components/chat/HtmlRenderFrame.tsx:27`        | Responsive inline display using a saved attachment reference                                                    |

T3 allows remote resources and inlines absolute-path images. Those assumptions
should not be transferred into Truex's business-data environment. Preserve Truex's
network-denying policy and managed-file boundaries. If copying substantial T3
code, retain its MIT copyright and license notice from the checkout's `LICENSE`.

### Existing Truex implementation

```text
User request -> model -> create_visualization dynamic tool
  -> ConversationFiles saves HTML fragment and metadata
  -> tool returns [truex-visualization:ID]
  -> assistant includes marker in text -> message persistence
  -> session-authorized JSON retrieval -> sandboxed iframe
```

| Source                                                        | Reuse / identified gap                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [file-tools.ts](../agent-core/src/file-tools.ts)              | Visual tool, immutable revisions, serialized storage, 50-file / 25 MB quota                |
| [business-runtime.ts](../agent-core/src/business-runtime.ts)  | Built-in dynamic-tool registration and execution; current output is JSON text only         |
| [visualizations.ts](../shared/visualizations.ts)              | HTML fragment contract and direct agent instructions                                       |
| [visualization.ts](../frontend/lib/visualization.ts)          | CSP, bootstrap, state bridge, responsive resizing and sandboxed export                     |
| [visualization.tsx](../frontend/components/visualization.tsx) | Inline frame, expansion, reload, state restoration and explicit follow-up drafting         |
| [chat-messages.tsx](../frontend/components/chat-messages.tsx) | Marker-based chat rendering                                                                |
| [platform/index.ts](../platform/src/index.ts)                 | Session-checked visual retrieval; raw visual download rejected                             |
| [access.ts](../platform/src/access.ts)                        | Read/write ownership policy; permitted shared-chat readers need not be the owner           |
| [manager.ts](../agent-core/src/manager.ts)                    | Durable record spool exists, but dynamic-tool activity is not a durable visual association |
| [service.ts](../platform/src/service.ts)                      | Tenant-scoped ingestion persists records before acknowledgement                            |

The existing wrapper hard-codes `color-scheme:light` and does not consume the
resolved application theme. The `wide` class has no dedicated layout rule;
expansion is the currently working route to a wider view.

The pinned protocol already supports `inputImage` with `imageUrl` in
[DynamicToolCallOutputContentItem.ts](../shared/protocol/v2/DynamicToolCallOutputContentItem.ts).
The adapter must return that content explicitly. Chat and Gemini gateway tool
output currently flattens images to `[image omitted]`; Anthropic has image-aware
tool-result conversion. Existing user-image handling does not prove preview
images reach a model.

Some capability documentation still says there is no authentication/tenant
authorization or workspace tooling. Current code has ownership/tenant controls
and managed workspace tools. Update relevant descriptions from code evidence;
deployment `AUTH_MODE=poc` still deliberately uses a shared identity.

## Target behavior and boundaries

An ordinary request such as "Show monthly sales as an interactive chart" should
produce a checked, interactive artifact before the assistant's final text.
Controls work locally without starting model requests. Publication remains usable
if preview is unavailable; the agent accurately discloses missing validation.

Proposed tools, using the current dynamic-tool mechanism:

| Tool           | Proposed arguments and result                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `html_preview` | `{html, width?, appearance?}` -> bounded height/console/error diagnostics plus a PNG image content item                         |
| `html_render`  | `{html, title, height, description?, sourceId?}` -> saved visual reference; host attaches it to the invoking turn automatically |

The new tools accept complete HTML documents. Keep legacy `create_visualization`
calls and fragment/marker rendering compatible in existing conversations. Optional
description supports an accessible text alternative; `sourceId` preserves Truex's
immutable revisions.
Neither tool accepts a target thread, user, tenant, URL to visit, or host path.
Derive authority from validated invocation context. Main-agent calls only initially.

Retain current 180,000-character HTML and 200,000-character argument limits, 1 MB
file limit, and conversation quota. Reject invalid numbers and oversized UTF-8
payloads before work begins. Initial proposed preview bounds: width 240-1600,
capture height at most 4000 pixels, PNG at most 4 MiB, 20 console entries of at
most 500 characters, and a 20-second execution deadline. Validate screenshot and
transport limits against the real runtime before committing these values.

Use existing frame height bounds, 160-900 pixels, for the first release. The
preview reports full content height separately from captured height; long visuals
scroll in the frame. Validate client resize messages. Multiple server-side width
measurements are unnecessary initially.

Initial scope retains inline data, JavaScript, CSS, SVG/canvas, and data-URI images.
It excludes live API calls, remote/CDN assets, filesystem image discovery, and
native mobile applications. Responsive mobile web is included. Vetted bundled
chart libraries can be a follow-up if native rendering proves insufficient.

## Implementation sequence

### 1. Share document preparation and fix theme behavior

Extract pure document/bootstrap/CSP generation from the frontend into a shared
module, with no React, Node or filesystem imports. Preview, chat rendering and
exports must consume the same prepared document and policy.

Add optional source-format metadata, defaulting older files to `fragment`. Store
original source for revisions; prepare complete documents through deliberate HTML
parsing rather than inserting another document inside the current body or using
fragile regular-expression rewriting. Insert host CSP/bootstrap before generated
content. Keep export isolation and original script/style ordering.

Pass the resolved light/dark theme into preparation. A narrow parent-to-frame
theme message should update an open visual without resetting its selections;
validate the sender and message shape in both directions. Specify explicit export
theme behavior. Keep expansion as the wider display path and remove the ineffective
`wide` distinction from new-tool guidance unless a real layout is implemented.

Likely files: `shared/visualizations.ts`, new `shared/visualization-document.ts`,
`shared/assistant-capabilities.ts`, `frontend/lib/visualization.ts`,
`frontend/components/visualization.tsx`, and `frontend/test/visualization.test.ts`.

### 2. Publish as a durable turn artifact

Implement `html_render` by reusing `ConversationFiles`, not a second file store.
Use tool invocation `threadId`, `turnId` and `callId` as authoritative association
data. Add optional artifact metadata and a typed `visual.published` event carrying
only visual ID, title, description, display mode/height and call identity.

Save the source and committed metadata, then durably record publication before
reporting tool success. Reuse the adapter spool and platform persist-before-ack
ingestion. Upsert the turn association by session/call identity. Make repetition
of the same call return the original artifact; reject the same call identity with
different arguments. Independent calls remain distinct even when their HTML is
identical.

Handle the save-to-event crash window explicitly: committed metadata is the
reconciliation source, enabling a missing event to be re-emitted after restart.
Do not acknowledge an event until Mongo persistence succeeds. Clean incomplete
files without deleting committed visuals. Forks copy visuals and remap their
conversation associations. Revisions create a new artifact and retain originals.

Render a typed artifact row as soon as publication is received, before final
prose. Include associations in persisted history, reconnect snapshots and replay;
artifact-only or interrupted turns must remain visible. Retain old marker parsing
and suppress a duplicate marker when the same artifact already has a typed row.
Do not expose raw HTML, console logs, screenshot bytes or runtime paths in SSE.

Likely files: `agent-core/src/file-tools.ts`, `agent-core/src/business-runtime.ts`,
`agent-core/src/manager.ts`, `shared/contracts.ts`, `shared/assistant-capabilities.ts`,
`platform/src/store.ts`, `platform/src/service.ts`, `platform/src/public.ts`,
`frontend/lib/chat.ts`, `frontend/lib/chat-groups.ts`, and
`frontend/components/chat-messages.tsx`.

### 3. Add isolated headless preview and model image delivery

Introduce a small renderer interface and adapter-owned `html_preview` tool. The
renderer takes prepared HTML, theme and viewport; it returns PNG, measured content
height and bounded diagnostics without saving a published artifact.

Use an isolated Chromium job, without runtime-volume mounts, conversation
filesystem access, provider credentials, cloud credentials or application cookies.
Enforce network denial at the job boundary as well as CSP/browser request policy.
Block navigation, popups, workers and local-file access. A fresh browser context
alone is not the isolation boundary. Keep Chromium's sandbox enabled; a deployment
that requires disabling it needs another demonstrated isolation boundary.

Reuse the existing script-runner's dependency-injection and container-limit
patterns where useful, but not its writable workspace mount or general script API.
Run preview on a private renderer host for deployments that cannot launch isolated
jobs inside AgentCore. Authenticate the service transport; never expose an
unauthenticated render endpoint or give untrusted browser jobs transport credentials.
The renderer is an internal implementation service, not a tenant-configured MCP.

Start with one running preview and at most four waiting jobs per worker. Bound
admission per conversation and tenant. Reject overflow clearly. Cancel jobs on
turn interruption and kill the owned job process/container on deadline, including
infinite JavaScript that prevents browser-level timeout callbacks. Clean temporary
profiles after completion, error, cancellation and worker restart. Measure CPU,
memory, latency and cleanup under concurrent hostile jobs before increasing limits.

Return diagnostics as `inputText` and the screenshot as an actual `inputImage`,
not base64 inside JSON prose. Test direct Responses and gateway providers end to
end. Fix Chat/Gemini image omission with provider-valid mappings or explicitly
offer diagnostics-only preview for unsupported models. Never claim visual
inspection where image delivery is unverified. Keep screenshots out of public
activity/debug projections and avoid recording customer HTML/console content in
operational logs.

First perform a deployment spike on the actual Linux ARM64 environment: browser
installation at image-build time, library dependencies, sandbox support, process
cleanup and bounded image transport. Select/pin a supported browser driver using
that evidence; do not transplant T3's Effect/CDP/browser-install stack wholesale.
Do not add browser downloading to a user turn or make publishing depend on preview
health.

Likely files: new `agent-core/src/html-preview.ts`, new renderer worker/image,
`agent-core/src/business-runtime.ts`, `model-gateway/src/adapters/{chat,gemini,anthropic}.ts`
where needed, runtime configuration and deployment documentation. Keep Chromium
out of the main runtime image when using the private worker deployment.

### 4. Enable the ordinary-chat workflow

Update `shared/visualizations.ts` instructions: build -> preview -> inspect/fix ->
publish -> short explanation. Bound repair attempts to avoid repeated failing
previews. Publish a usable unvalidated visual with an accurate note when the
preview service is unavailable; publication itself must still return real success
before the assistant claims it exists.

Advertise preview only where the renderer is configured; expose honest service
failure diagnostics if a configured worker later becomes unavailable. New tool
registration occurs at thread start. Existing conversations retain their current
tools and a clear availability notice; no silent runtime-policy upgrade.

Update capability/activity labels and documentation to describe T3-style visual
replies. Ordinary chat is the primary entry point; the existing Visualize shortcut
could invoke the new workflow. The new tools coexist with `create_visualization`; the existing
fragment/marker workflow remains supported. No additional skill installation or
user browser setup is required.

## Acceptance and adversarial verification

| Area              | Observable release criterion                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Normal flow       | Real pinned runtime calls preview then render; interactive chart appears before final prose without a marker           |
| Provider contract | Screenshot arrives at each declared image-capable route; unsupported routes expose an accurate limitation              |
| Layout/theme      | Same prepared source works at 320, 390 and desktop widths in both themes; controls remain keyboard-accessible          |
| Theme changes     | App theme changes update open frames without losing selected values                                                    |
| Persistence       | Reconnect, reload, cold restart and fork retain correct artifacts; original remains after revision                     |
| Idempotency       | Replayed call/record displays one visual; separate calls with identical content remain separate                        |
| Partial failure   | Crash after source commit/before event or Mongo acknowledgement recovers the association exactly once                  |
| Access            | Hidden chats and wrong tenant/session references fail; shared readers retain intended read-only permissions            |
| Input             | Empty/malformed/oversized HTML, invalid title/height/options and unknown namespaces reject before work                 |
| Execution         | JS errors, excessive logs, infinite loops, worker crash and cancellation end within bounded time and release resources |
| Isolation         | Parent DOM/cookies, tools, host files, remote resources, private networks and metadata services remain inaccessible    |
| Bridge            | Forged-window messages, invalid origin, oversized state and invalid resize values are rejected                         |
| Compatibility     | Old fragments/markers, saved state, expansion, reload and sandboxed offline exports continue working                   |
| Capacity          | Measured overload rejects predictably; preview failure does not interrupt normal chat or publication                   |

Use disposable fixtures and explicit ownership context. Test real Chromium and
the pinned runtime, not just mocks. Include browser E2E checks for user controls,
resize and theme, while backend tests inject save/spool/ingest crash boundaries.
Live-provider quality and production capacity remain separate acceptance checks.

Run the repository's required build, test, format and protocol-verification gates
for implementation, plus frontend tests/typecheck (root `npm test` omits frontend).
Review the final diff and exercise the worst realistic incident: malicious or
broken generated HTML leaking business data or consuming all renderer capacity.
Network denial, isolated jobs, bounded admission and recovery are release gates.

## Rollout and operational impact

Use additive fields/events and independent preview/publication capability flags.
Deploy storage/event consumers and the frontend before enabling new publication
tools. Bring up and test the private worker before advertising preview. Canary on
new conversations; preserve existing sessions, sources and marker rendering.

Rollback disables new tool registration while retaining readers for already saved
artifacts. Keep committed source and publication metadata on the existing retained
runtime volume. No destructive migration is needed; deployment must not remove
these readers during rollback.

Observe preview queue depth, rejects, timeouts, memory, duration, active jobs and
cleanup failures; publication latency/failures, unacknowledged spool records and
reconciliation repairs. Log safe call identifiers and error classes rather than
HTML, customer values, screenshots or credentials. Preview outages should degrade
validation only. Reader-side generated JavaScript still has no guaranteed CPU
budget; passing preview is not proof a malicious interactive page is safe forever.

## Implementation verification

- Full backend/gateway run: 206 agent-core, 213 platform and 61 gateway tests
  passed; five optional Docker tests were skipped in the default run and all five
  passed separately against the real worker image. One additional tenant admission
  test added after that run also passed. Final trace-only review excluded image
  payloads from text context/privacy scanning; all nine trace tests and the
  subsequent agent-core build passed.
- Frontend: 356 tests passed, including common/dark token parity and legacy/typed
  publication replay; typecheck and optimized build passed.
- Actual pinned Codex fixtures deliver preview images and publish without a final
  marker. HTTP fixtures verify authorized retrieval, final-reply ordering and
  restart repair. Adversarial fixes cover spool failure, late calls after Stop,
  invalid journals and lost acknowledgment.
- Real Linux ARM64 Docker checks cover authenticated HTTP transport, remote/file/
  metadata denial, overload, memory/CPU limits, infinite JavaScript, cancellation,
  autonomous watchdog and container cleanup.
- Native browser checks cover typed publication before prose, keyboard interaction,
  saved state, theme updates preserving the iframe, mobile sizing, follow-up draft,
  expansion/Escape and reload. Native screenshot capture failed; pixel comparison
  is not claimed.
- Root build, pinned-runtime/protocol verification and whitespace checks passed.
  Repository format check reports 55 warnings, each also present in original HEAD;
  new/modified feature code passed applicable targeted formatting checks.
- Platform Docker build and AgentCore services-build (ARM64) passed with shared
  parser resolution verified. Full AgentCore runtime image verification is blocked
  by the checkout's missing prebuilt `.runtime/agentcore/codex.json`, not compiled
  afresh as part of this feature.

See [operation and remaining deployment checks](VISUAL_REPLIES.md) and
[measured evidence](performance/visual-replies/README.md). Live-provider acceptance,
AWS host deployment and sustained production load remain unverified. This is a
local implementation, not a production release or an exact T3 source port.
