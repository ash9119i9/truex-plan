# MCP Apps in Truex

A connector tool can come with a page of its own: a chart, a form, an order card.
When such a tool finishes, Truex shows the page in the conversation, above the
assistant's answer, fed the tool's input and result. This follows the
[MCP Apps](https://github.com/modelcontextprotocol/ext-apps) standard (spec
2026-01-26) for HTTP connectors.

## Using it

Nothing to switch on. A connector opts in by declaring a UI resource on a tool:

```json
{
  "name": "get_order",
  "_meta": { "ui": { "resourceUri": "ui://sap/order.html" } }
}
```

and serving that `ui://` resource with the type `text/html;profile=mcp-app`. After
the tool runs, the page appears under the connector and tool name. It stays in the
conversation: reloading, or an assistant restart, brings it back.

## What an app can and cannot do

|                                                                            |                                                |
| -------------------------------------------------------------------------- | ---------------------------------------------- |
| Receives its tool call's input and result                                  | Yes                                            |
| Follows the Truex theme, light or dark, without reloading                  | Yes                                            |
| Sets its own height (80–2000 px)                                           | Yes                                            |
| Calls tools, reads resources, sends messages, opens links, downloads files | **No** (refused with an error; not advertised) |
| Network, other frames, popups, storage, navigation of Truex                | **No**                                         |

The app is a display of what the tool returned. Making an app able to act (for
example, call a tool on its own server) needs an approval design and is not
included.

Limits: the page is at most 1 MiB; the tool input and result handed to it at most
256 KiB each; 20 apps are remembered per conversation. The runtime itself shortens
a very large tool result (to about 64 KiB, dropping an oversized
`structuredContent`) before Truex sees it, so an app may be given less than the
tool returned.

## Data exposure (a deliberate exception)

[TRUEX_RUNTIME.md](TRUEX_RUNTIME.md) keeps raw runtime items out of the browser.
An app needs its tool's input and result, so this feature makes one narrow
exception, and only for tools that declared a page:

- The event stream and snapshot carry only a safe app id and the connector and
  tool names. Never the data, the page, or the model provider's tool call id (the
  id the browser sees is a hash of it).
- Input, result and page are fetched with `GET /api/sessions/:id/mcp-apps/:appId`,
  which checks the session like every other session route, and are delivered only
  to the app's sandboxed frame.
- A tool without a declared page behaves exactly as before.

Anyone who can open the conversation can open its apps. Connectors must enforce
their own access scope, as before.

## Rendering boundary

An app is a complete HTML document written by the connector. A policy cannot be
spliced into its text safely (a comment can hide the splice point), so Truex serves
its own page that carries the policy and embeds the app in a nested frame:

```text
Truex ── iframe (scripts only) ── Truex wrapper + policy ── iframe (the app)
```

The nested frame is made from `srcdoc`, so it takes on the wrapper's policy: no
network (`connect-src 'none'`), no remote images, fonts, frames or workers, no
`<base>` or form posts. Both frames are sandboxed to scripts only, so the app has
no origin, no storage, no popups and cannot navigate Truex. The wrapper relays
bridge messages and nothing else, and Truex accepts a message only from the
wrapper's own window, so the app cannot post to Truex directly.

`_meta.ui.csp` and `permissions` that an app declares are **not** honoured: every
app runs with no network and no device permissions.

The page is read through the runtime from the connector, and only for a call the
conversation recorded: the request is built from that call's own server and
address, and the runtime's request gate stays closed to everything else.

## Verification

- Real pinned runtime, simulated connector (`agent-core/test/mcp-app.test.ts`): a
  tool with a declared page is offered with its page and data; the result's
  `_meta: null` is removed; the app list survives an agent-core restart; unknown,
  malformed and other-conversation ids are refused; a tool without a page is not
  an app; a wrong page type, an empty or oversized page, and oversized input are
  refused.
- Real Chrome with the official `@modelcontextprotocol/ext-apps` SDK as the app:
  the handshake completes against Truex's host, tool input and result arrive, a
  theme change arrives as only the changed field, the size is followed, and an
  unsupported `tools/call` is rejected rather than left hanging. The same page
  tried `fetch`, a remote image, popups, storage, same-origin access, navigating
  Truex and posting straight to Truex; all were blocked or rejected.
- Public projections, ids and the AgentCore path allow-list are unit tested.

Not verified: an app from a real production connector, and the page in a deployed
AgentCore runtime.
