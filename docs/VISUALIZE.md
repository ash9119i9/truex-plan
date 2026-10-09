# Visualize in Truex

Start a new conversation and choose **Visualize** in **Capabilities, documents &
visuals**, or ask a question such as “Visualize how team size changes weekly
capacity with a slider.” The assistant can create interactive charts, diagrams,
simulations, comparisons, and explainers directly in its reply. This implements
the Codex-style interaction pattern within Truex; it does not install the Codex
application's private rendering runtime.

## Using a visual

- Adjust its native controls to explore the data. **Expand** opens a centered,
  keyboard accessible dialog with its actions pinned at the top; Escape closes it. A
  visual taller than most of the window says so beside the buttons. The frame is
  sized to its content with a few pixels of slack, so a visual does not get a
  scrollbar of its own inside the page. **Reload visual** reruns the saved source.
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
(`inline` or `wide`), optional integer `height` hint (80–2000), and optional `sourceId`. It stores a self-contained HTML
fragment and returns `[truex-visualization:<uuid>]`. The assistant places that
reference on its own line. Complete references outside code fences render inline;
other Markdown remains ordinary text. Raw HTML in an assistant message is not
executed. Host paths cannot serve as references.

The fragment may contain CSS, JavaScript, SVG and canvas, with inline data and
accessible native controls. A small Truex theme and control utility set is supplied.
Pages are given a small design kit so they look consistent without hand-rolled styling: `.viz-title`, `.viz-chip`, `.viz-card`, `.viz-kpi` (with `.viz-kpi-label`, `.viz-kpi-value`, `.viz-kpi-delta`, and `.viz-up` / `.viz-down`), `.viz-legend` with a `.viz-swatch` per series (colour set with `style="--c: var(--viz-series-2)"`), `.viz-split` (controls beside results from 640 px up), `.viz-tooltip`, plus `--surface`, `--positive` and `--negative` tokens that switch with the theme. Buttons and fields have hover, active and focus states, and a page fades in gently (all motion is off for readers who ask for less of it). Numbers are not broken across lines. The assistant is asked to keep a visual under about 560 px tall at the chat width (using wide mode otherwise), to give charts hover values and a stated takeaway, and not to narrate its checks in the reply.

Visuals follow the reader's light or dark theme: the supplied CSS variables switch with the app, and a frame that is already open changes theme without reloading. Pages should use those variables rather than fixed colors.

To show an image the reader uploaded, a page uses `src="truex-file:<file id>"` (or `url(truex-file:<file id>)` in CSS, or the same text in a script string). The id comes from `conversation_files`. The saved source keeps the reference; the image bytes are put in when the visual is shown or exported, so a revision starts from the short reference and the export keeps working offline. Only PNG, JPEG, GIF and WebP files of this conversation are embedded, at most 20 of them and 4 MiB in total. Anything else, including another conversation's file id, stays as written and shows as a missing image. SVG is not an upload type. Remote libraries, fonts, API calls, embedded pages and CDN assets are unsupported;
there are no preloaded D3, Mermaid, Lucide or Tweak helpers. Use native SVG/HTML for
diagrams. Source is limited to 180,000 characters, with a 200,000-character bound on
the serialized tool arguments and the existing 1 MB file limit. Documents and
visuals share the 50-file / 25 MB conversation quota.

When `VISUAL_RENDER=1` and `CHROMIUM_PATH` points to executable Chromium, new conversations also have `preview_visualization`. It accepts a self-contained HTML fragment (1–180,000 characters), an optional width (240–1600 pixels, default 728) and an optional `appearance` (`light`, the default, or `dark`) to check the page in either theme, and returns text diagnostics plus a capped PNG screenshot when possible. The diagnostics include `contentHeight`, console output, blocked requests, and `missingImages`: the images on the page that did not load, such as a remote address or a `truex-file:` reference that is not an image of this conversation. The preview saves nothing. The model should use it for complex, interactive or crowded visuals and revise console errors or blocked-resource reports before publishing. Simple pages can publish directly. Screenshots reach the Anthropic adapter and direct Responses providers; other gateway adapters replace images with `[image omitted]`, so diagnostics always remain in text.

Publishing measures heights at nine widths from 320 to 1144 pixels when rendering is available. Measurement has a six-second total cap; failure does not stop publication. Saved heights guide the iframe's first paint, then its own resize reports take over. Older visuals without heights use the existing 360-pixel initial height. Preview has a 20-second cap, at most two concurrent renders by default, a bounded queue, a 4000-pixel screenshot height cap and capped console/request diagnostics.

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
may still affect browser responsiveness. With server-side rendering enabled, AgentCore executes the same wrapper in a headless browser with an intercepted synthetic HTTP page, request denial, a blackhole proxy and host resolver rule. Each launch uses a scrubbed environment and a disposable profile in the system temp directory. Timeouts kill the spawned browser process group. `VISUAL_RENDER` is off by default; `CHROMIUM_NO_SANDBOX=1` is a separate, explicit operator choice when the runtime cannot support Chromium's OS sandbox.

The headless browser shares its AgentCore session microVM. [AWS documents](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-security-best-practices.html) that code in that VM can obtain execution-role credentials and persistent filesystem permissions are not enforced. The browser controls are defense in depth, not isolation from the conversation's files or role. POC use requires a least-privilege role, verified runtime network mode and the checks in [VISUAL_PREVIEW_DEPLOY.md](VISUAL_PREVIEW_DEPLOY.md). A separate renderer service is the stronger production boundary.

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
