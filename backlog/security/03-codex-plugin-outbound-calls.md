# Codex calls chatgpt.com from chats

Status: open · Medium · decide before AgentCore launch · Added 2026-10-20 · Source: context stress test (side finding)

## Observed

At least 37 chats' Codex logs show requests to `chatgpt.com/backend-api/plugins`, each answered with 401. Nothing in the product asks for this; it is Codex's plugin sync.

## Why it matters

Unplanned outbound traffic from the runtime to a third party. It sends at least request metadata, adds latency or failures when egress is blocked, and on AgentCore needs either an egress rule or a fix. See also `backlog/performance/04-codex-injected-context.md` (analytics).

## Do

- Find in the pin which setting turns off the plugin sync; set it in the adapter's config.
- Add a test that runs a chat with outbound network blocked (or watched) and asserts no request goes anywhere except the model gateway.

## Done when

No request to `chatgpt.com` (or any host other than the gateway) appears in a chat's log, covered by the test, on every pin upgrade.
