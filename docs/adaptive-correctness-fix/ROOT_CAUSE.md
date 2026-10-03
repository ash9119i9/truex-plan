# Phase 1: observed causes and remaining uncertainty

This document precedes implementation changes for the correctness fix. Investigation is read-only: no model calls, business actions, database writes, environment edits, or Codex edits.

## What the existing live evidence proves

The failed five-message Adaptive startup did not reach catalog discovery. Its Qlik connector timed out after approximately **30,012 ms** during hydration; the gateway then exposed an empty business registry. A separate fresh-session probe using the existing V1 transport timed out after **30,004 ms** inside the HTTP `initialize` request **before receiving any HTTP response headers**. No `notifications/initialized` or `tools/list` request followed.

Evidence:

- [Five-message Adaptive capture](../five-message-mcp-v2/adaptive/adaptive-capture.json): startup `unavailable` event, `phase: hydration`, and `adaptiveRegistry: []`.
- [Catalog health probe](../five-message-mcp-v2/catalog-health.json): one `initialize` request; `TimeoutError`; no response status or headers.
- [Independent five-message validation](../five-message-mcp-v2/validation.json): both gateway arms failed to retrieve business data; their lower token totals do not establish equivalent-work savings.

This establishes the observed timeout boundary. It does **not** prove a remote service outage, an authorization failure, a protocol incompatibility, or a schema-index problem. The request has not reached the response parser when the injected fetch function itself is still awaiting headers. Increasing startup timeouts alone would not explain or correct this behavior.

## Confirmed implementation defects after that failure

| Defect                                                         | Causal evidence                                                                                                                                                                                                                               | Effect                                                                                                   | Minimal correction                                                                                                                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Failed hydration becomes a successfully cached empty registry  | `AdaptiveMcpGatewayV2.initializeRegistry` collects connector failures with `Promise.allSettled`, records `unavailable`, then resolves `this.hydration`; later calls return existing bindings without retrying a failed connector.             | One transient failure persists as zero discoverable tools for the session.                               | Track connector readiness/failure explicitly; do not cache failure as an empty successful catalog; permit bounded read-only discovery recovery.                                           |
| Local gateway readiness is conflated with downstream readiness | `mcpServerStatus/list` reports the local proxy's four fallback tools while Qlik hydration has failed and the business registry is empty.                                                                                                      | A healthy loopback proxy looks like a healthy Qlik connector.                                            | Expose/read separate local proxy readiness, downstream availability and catalog readiness; routing must not infer business readiness from proxy tool count.                               |
| Permission filtering can become cached metadata                | Hydration calls the exposure authorizer before committing binding metadata; a denied tool can disappear from the cached registry.                                                                                                             | A later permission grant cannot reveal its schema without invalidation.                                  | Cache catalog/schema metadata independently; evaluate permissions afresh on exposure and execution.                                                                                       |
| Named-app explanation selects only the listing tool            | [Healthy-registry router preflight](../five-message-mcp-v2/routing-preflight.json), exact query `Explain this qlik app T_DCF_BANKREC_P`: only `get_apps`, score 1. The single-intent selection logic suppresses other same-source candidates. | A listing/lookup is exposed but app details and other required explanation capabilities are unavailable. | Calibrate multi-capability task routing against named-app explanation fixtures; preserve enough relevant tools for lookup and details, and use discovery when task coverage is uncertain. |

These defects can be corrected from local code and captured evidence without claiming an unproven cause for the first network timeout. Business action retries must remain forbidden: recovery concerns initialization and catalog discovery, not repeating an action whose remote completion is unknown.

## Targeted network/protocol comparison completed

The new [diagnostic script](../../platform/scripts/diagnose-mcp-hydration.ts) compares Node `fetch`, Node `https.request`, and curl HTTP/1.1 using the same authenticated, read-only initialization payload. It records DNS A/AAAA results, proxy-environment presence without values, connection/header/body stages, negotiated protocol, session fingerprints, catalog counts, and SSE cancellation completion. It tests the gateway's initial `2025-03-26` proposal and pinned Codex's default legacy `2025-06-18` proposal. No credential or raw session value is persisted.

The [saved diagnostic](hydration-diagnostic.json) records six initialization probes: all three clients timed out before HTTP headers for both proposals. Node `https.request` resolved DNS in 4–13 ms, connected TCP in 233–250 ms, and completed TLS in 595–698 ms. It then received no HTTP response headers within 20 seconds. Curl independently reported zero received bytes; Node fetch connected to the same address and timed out at the same boundary.

DNS resolved one IPv4 address; AAAA returned `ENODATA`. None of the tested proxy environment variables was set. These observations rule out failure to establish DNS/TCP/TLS, an IPv6 selection problem, and a Node-fetch-only failure as explanations for these six attempts. Changing only the proposal from March to June did not resolve the failure. The matching result cannot identify whether the subsequent wait is inside the remote application, its reverse proxy, or another layer after TLS.

The first live matrix used an identical gateway initialization body across clients. A separate [pinned-binary local wire capture](codex-protocol-capture.json) then established the actual Rust initialization shape: protocol June 18, RPC ID 0, form/URL elicitation capabilities, Codex client metadata, its user agent/Accept order, and **no MCP protocol header on the initialize request**. No inference request was made; the only auxiliary local HTTP request was OAuth metadata discovery.

The [second live matrix](hydration-rust-counterfactual.json) replayed that captured Rust initialization body/header shape through Node fetch, Node HTTPS and curl, alongside an unchanged gateway baseline and body/header controls. All six again timed out before HTTP headers. The captured SDK request-shape differences did not resolve the observed wait.

The [direct pinned-Rust catalog-only probe](direct-rust-catalog-health.json) also failed: Codex emitted `mcpServer/startupStatus/updated` with `status: failed` and an explicit 20-second startup timeout. Its server status had no server info and zero tools. The complete probe took approximately 27.4 seconds including runtime startup. **No inference request occurred.** Thus the current failure is reproduced with the actual Direct Rust stack, not only JavaScript clients or replayed HTTP/1.1 requests. This does not prove which remote/network layer is responsible.

Earlier healthy Direct catalogs and gateway catalogs demonstrate prior availability, not current availability. No successful `tools/list` or response-parser/cancellation stage was reached in the live HTTP matrices.

The underlying cause of the first timeout remains unknown. The independently proven local cache/readiness/permission/routing defects can be fixed without that assumption. Do not increase the timeout as a substitute for stage evidence, or spend another model replay while read-only catalog initialization remains unavailable.

## Required checks before live model replay

1. A read-only initialize/initialized/tools-list sequence completes and yields the expected Qlik catalog.
2. Failed catalog hydration can recover without rebuilding the application session or retrying business actions.
3. Discovery reports downstream failure explicitly rather than a misleading successful empty tool set.
4. Permission changes are checked on every exposure/execution, independently of schema caches.
5. The exact named-app explanation prompt routes to adequate capabilities or an honest discovery fallback.
6. Projection preserves required app metadata and pagination; narrower output must not manufacture answer completeness.

The earlier Direct named-app reply was itself partial: script, lineage and sheet calls timed out. It also claimed a second script timeout and confirmed absence of sheets that the trace does not support. Correctness checks must verify reply claims against returned data, not simply count completed model turns.
