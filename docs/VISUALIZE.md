# Visualize in Truex

Start a new conversation and choose **Visualize** in **Capabilities, documents &
visuals**, or ask a question such as “Visualize how team size changes weekly
capacity with a slider.” The assistant can create interactive charts, diagrams,
simulations, comparisons, and explainers directly in its reply. This implements
the Codex-style interaction pattern within Truex; it does not install the Codex
application's private rendering runtime.

## Using a visual

- Adjust its native controls to explore the data. **Expand** opens a keyboard
  accessible dialog; Escape closes it. **Reload visual** reruns the saved source.
- **Ask about this visual** prepares a message with its ID and current public
  selections. Visual-proposed questions appear outside the frame and only enter
  the composer when the user selects **Add to my message**. Neither action sends
  a model request automatically.
- **Download HTML** exports a standalone, sandboxed viewer with the current state
  captured. It works offline. Follow-up controls in the export show a question to
  copy into Truex. Changes made after opening the export last for that open page;
  reopening restores the exported snapshot.
- Saved visuals also appear in the capabilities panel. Asking for a revision
  creates a new version; the original remains available. Visual references remain
  in persisted chat messages, so reopening or replaying a conversation restores
  the visual. Conversation forks copy the saved source.

Visualize requires a new conversation after this update because dynamic tools are
registered when a runtime thread starts. Existing conversations display an
availability notice. Live output quality depends on the configured model.

## Agent contract

`create_visualization` accepts `title`, `description`, `html`, optional `mode`
(`inline` or `wide`), and optional `sourceId`. It stores a self-contained HTML
fragment and returns `[truex-visualization:<uuid>]`. The assistant places that
reference on its own line. Complete references outside code fences render inline;
other Markdown remains ordinary text. Raw HTML in an assistant message is not
executed. Host paths cannot serve as references.

The fragment may contain CSS, JavaScript, SVG and canvas, with inline data and
accessible native controls. A small Truex theme and control utility set is supplied.
Remote libraries, fonts, API calls, embedded pages and CDN assets are unsupported;
there are no preloaded D3, Mermaid, Lucide or Tweak helpers. Use native SVG/HTML for
diagrams. Source is limited to 180,000 characters, with a 200,000-character bound on
the serialized tool arguments and the existing 1 MB file limit. Documents and
visuals share the 50-file / 25 MB conversation quota.

Supported `window.openai` bridge subset:

| API | Behavior |
| --- | --- |
| `widgetState` | Initial `{modelContent, privateContent}` snapshot, or null |
| `setWidgetState({modelContent, privateContent})` | Updates the snapshot, limited to 16 KiB |
| `sendFollowUpMessage({prompt, title?})` | Proposes a question of at most 2,000 characters for user review |

State is stored in this browser's local storage, scoped to conversation and visual
IDs. It is not synchronized across browsers. Only `modelContent` is included when
the user requests a follow-up; `privateContent` is used for local presentation.
Saving state never starts a turn. The bridge is a limited compatibility layer;
other Codex host APIs and state-global events are not implemented.

## Rendering boundary

HTML is fetched through an owner-routed, session-checked JSON endpoint, never
served as an unrestricted page. The iframe grants `allow-scripts` only: it has no
same-origin access, popups, form submissions, downloads or top-level navigation.
The source wrapper applies CSP before untrusted content, denying remote resource
loads, network connections, workers, nested frames and base-URL overrides. The
parent's `frame-src 'self'` policy also restricts remote frame navigation. The
export retains the sandbox. Raw visual files cannot be downloaded through the
ordinary document endpoint.

The host checks both the sending window and its opaque origin before accepting
bridge messages, validates their shape/size, clamps resize requests, and escapes
titles and initial state before inserting them into the wrapper. Frame code has
no endpoint for executing tools or sending chat messages. These controls use
[browser iframe sandboxing](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)
and [CSP frame restrictions](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-src).
They do not impose a JavaScript CPU budget; a broken or expensive generated visual
may still affect browser responsiveness. No server executes the generated HTML.

## Verification

Automated checks cover the real pinned runtime's tool call, persistence, immutable
revisions, forks, source pagination, input bounds, cross-conversation rejection,
HTTP owner routing and restart recovery, marker parsing, state bounds, wrapper
escaping and sandboxed export construction. Browser checks exercised interactive
updates, page-reload restoration, expansion, follow-up drafting and standalone
downloaded HTML. Provider output in these checks is simulated.

Run the reproducible interactive fixture with:

```sh
DEMO_VISUALIZE=1 npm run demo
```

Send any message to produce the example capacity slider. This uses disposable
MongoDB data and the real pinned runtime with a fixture provider. It does not
contact the configured production model.
