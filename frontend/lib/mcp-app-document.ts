// The document an MCP App runs in. An app is a complete HTML document written
// by a connector, so a policy cannot be spliced into its text (a comment can
// hide the spot it is spliced into). Instead Truex serves its own page, which
// carries the policy, and puts the app in a nested frame. A frame made from
// `srcdoc` takes on the policy of the page that holds it, and the nested frame
// is sandboxed to scripts only, so the app has no origin of its own, no
// network, no navigation and no popups.
//
//   Truex page ── iframe (sandbox: scripts) ── this document ── iframe (the app)
//
// This document relays bridge messages between the two frames and does nothing
// else. Truex accepts a message only if it came from this document's window,
// so the app cannot post to Truex directly.

export const MCP_APP_CHANNEL = "truex-mcp-app";

/** No network, no frames of its own, no workers; inline code and data only. */
export const mcpAppCsp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

const escapeAttribute = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export function mcpAppDocument(appHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${mcpAppCsp}"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe id="app" title="App" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeAttribute(appHtml)}"></iframe><script>
(() => {
  const inner = document.getElementById("app");
  addEventListener("message", (event) => {
    const data = event.data;
    if (event.source === inner.contentWindow) {
      parent.postMessage({ channel: "${MCP_APP_CHANNEL}", dir: "up", message: data }, "*");
    } else if (event.source === parent && data && data.channel === "${MCP_APP_CHANNEL}" && data.dir === "down") {
      inner.contentWindow.postMessage(data.message, "*");
    }
  });
})();
</script></body></html>`;
}
