# Unreal Agent evaluation for Truex

**Review date:** 23 September 2026  
**Upstream snapshot reviewed:** `unreallabsai/unreal-agent` commit `b7c9bf1c5c2fa4127255c07727a7c8413e23944a`  
**Truex baseline:** Codex app-server revision `4a942885c8b4745757a9f86ad2075e16c42483c5`, pinned in [`codex.lock.json`](../codex.lock.json)

## Executive assessment

Unreal Agent is a promising, MIT-licensed Go agent harness. Its core design is relevant to Truex: it runs tool operations asynchronously, records session events, supports recovery and forks, and aims to reduce the number of model turns spent waiting for tools. Its published benchmark results show similar or somewhat higher pass rates at lower reported cost on the selected coding benchmarks.

**It can replace the Codex engine, but it cannot replace it as a drop-in dependency in the current Truex application.** Truex depends on Codex's app-server protocol and on behavior built around it. Unreal Agent provides a Go library and a one-request runner; it does not provide that app-server protocol or Truex's REST/SSE, MongoDB, session, MCP, document and visualization integration. Replacing Codex would therefore mean building and supporting a new Truex runtime adapter, not changing a package name.

**Recommendation:** run a side-by-side proof of concept before deciding on a production cutover. Unreal Agent merits that evaluation, especially if reducing inference spend is a priority. The public evidence is not enough to conclude that it is better for Truex's business-assistant workloads or that it preserves Truex's user-visible behavior.

## What Unreal Agent is

Unreal Agent is an agent harness with a Go SDK, a command-line runner and Harbor benchmark support. Its components include a coordinator, a session store, a context builder, an LLM adapter, a tool registry and an operation manager. Its main design difference is that tool calls become serializable operations that can continue while the coordinator accepts other inputs or the model works on independent tasks. The model can receive an interim “still running” tool result, with the completed operation result supplied later.

The repository describes the session store and operation manager as replaceable interfaces. The checked-in persistence implementation is local JSONL; a Mongo-backed store or another production store would need to be implemented for Truex. The default registered tools are Bash, ViewImage and skill use. The Responses API adapter also maps the hosted `web_search` tool. Custom tools can be added through the registry and translators.

The stock runner reads one request, uses provider selection and credentials from its process environment, and writes persisted session items as JSONL. The SDK is the more suitable integration surface for a long-running Truex service. The repository's default provider set includes OpenAI, OpenAI Codex, OpenRouter, Fireworks and Ollama. A custom adapter can be injected, but dynamic per-conversation provider configuration is not supplied by the runner interface as used today.

## Comparison against the Truex baseline

| Area | Current Truex + Codex | Unreal Agent | Effect on a Truex replacement |
|---|---|---|---|
| Runtime interface | Truex launches the pinned Codex binary as `codex app-server --listen stdio://` and exchanges generated, schema-validated app-server RPC messages. | Go library and CLI runner; no Codex app-server protocol or Truex-compatible server API. | Implement a Go service or sidecar and map its events and controls into the existing Truex API, or refactor the platform around a new runtime contract. |
| Model providers | Truex reads provider, endpoint, API key, model and reasoning configuration per agent/model profile from MongoDB. It sends Responses API configuration to Codex. | Stock runner selects a provider and credentials through environment variables. The library supports custom LLM adapters; built-in providers are a fixed list. | Build per-session/per-profile adapter construction and secret isolation, or constrain deployment to one provider configuration per runtime process. |
| Async tools | Codex runs the tool loop and Truex serializes turn control and exposes progress. | Async operation actor model is a central feature; serializable operations can run across model calls and support recovery. | Strong architectural fit for long-running tools, but custom Truex tools and user-facing events still need integration. |
| Live output | Truex forwards answer and thinking deltas through SSE, with reconnect snapshots and timing metrics. | The Responses API adapter consumes the SSE stream but returns a normalized completed response. The public runner emits persisted session items, not a documented Truex-style token-delta REST/SSE API. | To keep Truex's live answer/thinking experience, add delta events and a browser-facing relay; otherwise users will see a behavior regression. |
| Session history | Truex persists public messages in MongoDB and retains Codex thread/runtime state on the owner volume; it supports same-owner resume and history reconciliation. | Versioned append-only session model, fork support and local JSONL store; storage is an interface. | Implement a Mongo-compatible store or durable owner service. Codex thread state cannot be resumed natively by Unreal; plan a new-session replay/import path. |
| Stop, steer and settings | Truex exposes stop, follow-up steering, model/reasoning settings, fork, compact, archive and goals through restricted RPC mappings. | Coordinator includes hard/idle stop, inputs, reasoning effort, fork and session compaction concepts. The stock runner does not expose all of Truex's session controls as a hosted API. | Several core concepts align, but each Truex action needs an explicit mapping and lifecycle tests. Goals and other product controls need new implementation or a different UX. |
| MCP/business connectors | Truex attaches HTTP MCP profiles from MongoDB and scopes them to an agent. Local stdio connectors are rejected. | No MCP client/connector runtime is part of the documented default harness tools. Custom translators can wrap connector calls. | Rebuild connector discovery, credentials, allowlists, approvals and progress handling, or write an MCP bridge. This is a significant parity item. |
| Documents and visualizations | Truex has adapter-owned upload, extraction and creation for PDF, DOCX, XLSX and PPTX, plus saved interactive visualizations. | No equivalent product tools or browser document/visualization UI are included. | Port the existing file tools and viewer contracts or defer these capabilities. |
| Security boundary | Truex disables shell and host file capabilities, creates managed workspaces, filters public events and restricts configuration. | Bash and local operation primitives exist. The Unreal Labs article itself recommends deterministic controls outside the harness, such as sandboxing, scoped credentials and network policy. | Disable Bash unless explicitly isolated; enforce workspace, filesystem, network and connector policies outside the model loop. Recheck every tool path. |
| Build/dependency footprint | Current app pins and builds Codex Rust source locally; setup requires Rust/native build tooling and carries a large upstream source tree. | Go module with a comparatively small declared module set; no Codex Rust source is needed for the main harness. | Potentially simpler runtime build and fewer Codex-specific upgrade obligations, in exchange for ownership of a new runtime integration. |

The Truex details above are visible in [`README.md`](../README.md), [`agent-core/src/client.ts`](../agent-core/src/client.ts), [`agent-core/src/business-runtime.ts`](../agent-core/src/business-runtime.ts), [`platform/src/service.ts`](../platform/src/service.ts) and [`docs/TRUEX_RUNTIME.md`](TRUEX_RUNTIME.md).

### One Codex-related nuance

Unreal Agent does not require the Codex CLI or its app-server to run its harness. However, its optional `openai-codex` provider calls the ChatGPT Codex backend and reads an existing Codex subscription access token/auth file. Its code says interactive login and token refresh are not implemented. Using that provider would retain a Codex credential dependency, though not the Rust app-server dependency. The other listed providers can be used without that provider.

## Benchmark evidence and limits

Unreal Labs published results on 22 September 2026 using GPT-6 Astra at xhigh reasoning effort. The reported comparisons are:

| Benchmark | Unreal Agent pass rate | Codex pass rate | Reported total cost | Approx. cost reduction |
|---|---:|---:|---:|---:|
| Terminal-Bench 4.0 | 57.9% | 57.9% | $1,428 vs $2,350 | 39.2% |
| SWE-Atlas Codebase QnA | 65.8% | 63.3% | $936 vs $1,303 | 28.2% |
| DeepSWE 1.1 | 72.4% | 69.0% | $1,367 vs $1,633 | 16.3% |
| Agents' Last Exam / ALE-CLI | 30.0% full pass | 29.0% | $217 vs $292 | 25.7% |

These are encouraging results: the reported pass rate is equal on Terminal-Bench and higher on the other three tasks, with lower reported cost in each table. The benchmark jobs linked by Unreal Labs are public, including the [Terminal-Bench run](https://hub.harborframework.com/jobs/27133053-2015-46f3-8c72-6b6910859da6), [SWE-Atlas run](https://hub.harborframework.com/jobs/3d2fa057-e11c-4be0-a962-e8be81b87709) and [DeepSWE run](https://hub.harborframework.com/jobs/2311ca63-2929-49eb-ba0c-0084ef31ba8b).

Treat the figures as vendor-reported evidence rather than a result independently reproduced for Truex. The benchmark article does not publish confidence intervals or a detailed cost-pricing calculation. The Harbor Terminal-Bench page identifies Codex as a leaderboard baseline; it is not a paired rerun of both harnesses shown on the same job page. The linked Unreal Agent jobs show hundreds of trials, but the Harbor pages report no per-trial inference cost. The article also says the pass-rate differences are marginal and may reflect benchmark variance. Finally, coding/science task suites do not establish cost or quality for Truex's business-data, document, connector, privacy and conversation-resume workflows. The article's separate claim of savings on production workloads is not accompanied there by a public dataset or workload breakdown.

**Conclusion on performance:** the results justify a controlled Truex pilot; they do not establish general superiority over Codex.

## Main migration work and risks

1. **Replace the runtime boundary.** `BusinessRuntime` extends `CodexClient`, and the manager/platform use Codex method names, generated schemas and event shapes. Create a runtime-neutral interface and an Unreal-backed implementation, or expose Unreal through a new sidecar API and translate its records into Truex events.
2. **Keep profile and credential isolation.** Truex supports separate API keys, endpoints and model settings per conversation while one Codex process serves requests. Unreal's stock runner is environment-configured. Build the SDK-backed service so credentials are selected per session and never shared across sessions or written into logs.
3. **Restore the full user experience.** Implement streaming text/thinking deltas, timing metrics, stop/steer, history replay, fork/compact/archive, goals, normal-mode clarification, document tools, visualizations and MCP calls. Verify which features can be mapped directly and which need new tools or UI work.
4. **Add durable Truex persistence and routing.** Use the existing MongoDB records and owner routing, or add a tested store/operation adapter. The upstream local JSONL store is not by itself a multi-owner MongoDB integration. Test recovery after interruption while tools are still running.
5. **Reapply the security policy.** Keep shell disabled for business sessions unless it runs in a verified sandbox. Constrain operation inputs, managed file paths, network access and connector credentials outside the model. Review how tool results and runtime diagnostics are projected to the browser.
6. **Plan conversation continuity.** Existing Codex thread IDs and app-server state are not portable session IDs. Keep existing sessions on the Codex runtime during a transition, and define how Truex's persisted user/assistant messages seed a new Unreal session. That replay creates a new runtime session; it is not a lossless native resume.

The workspace validation record reports a working Truex foundation, but still lists production acceptance gaps, including full provider/MCP behavior, load sizing, multi-pod failure testing, backup/restore and some stress scenarios. The Unreal pilot should be evaluated against those same gaps, not presented as production-ready based on harness benchmarks.

## Recommended evaluation plan

1. **Build an isolated vertical slice.** Keep the current Codex path intact. Run Unreal Agent behind an internal-only service with a pinned upstream commit. Support one existing Truex model profile, Mongo-backed credential lookup, a single session, and safe cancellation.
2. **Start with a Truex parity set.** Cover a normal streamed answer, follow-up steering, stop, restart/resume, per-profile key separation, one HTTP MCP read, one failed connector, document upload/read/create, a visualization, and a long-running tool operation. Include private canary data and verify it does not appear in public diagnostics or another session.
3. **Measure on identical workloads.** Use the same prompts, model, reasoning effort, endpoint, tool permissions and budget for both runtimes. Record task success, input/output/cache tokens, actual provider spend, number of turns, first visible token, completion time, failures and recovery outcomes. Repeat tasks enough to expose variance; benchmark totals alone are not enough.
4. **Canary before cutover.** Compare internal sessions side by side, then route a small opt-in cohort only after security, feature parity, restart recovery and cost/quality results meet Truex's own acceptance criteria. Keep the Codex runtime and old session access available until rollback and history handling are proven.

## Decision

**Proceed with a proof of concept; do not replace the production Truex Codex runtime based solely on the public benchmark claim.** Unreal Agent's async harness and cost results make it a credible candidate. For this application, the value depends on whether a custom integration can preserve provider isolation, business MCP behavior, streaming, documents/visualizations, persistence and security while producing measurable savings on Truex's real workloads.

## Sources

- [Unreal Agent repository at reviewed commit](https://github.com/unreallabsai/unreal-agent/tree/b7c9bf1c5c2fa4127255c07727a7c8413e23944a) and its [README](https://github.com/unreallabsai/unreal-agent/blob/b7c9bf1c5c2fa4127255c07727a7c8413e23944a/README.md)
- [Unreal Labs announcement and benchmark tables](https://unreallabs.ai/blog/unreal-agent/)
- Public Harbor trial pages linked above
- Truex source and validation notes linked above; reviewed locally on 23 September 2026

**Review limitations:** this is a source and published-evidence review. The Unreal Agent code was inspected at the pinned commit, but its tests were not run, no adapter was implemented, and no matched Truex workload benchmark was performed.
