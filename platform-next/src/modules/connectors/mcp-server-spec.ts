// The MCP server spec the run executor (slice 4) passes to the runtime
// adapter on StartRunRequest.mcp. This MUST match the adapter's McpServerSpec
// (runtime-adapter, Build contract) exactly: the two packages are built in
// parallel against this frozen shape. Changing it means updating both sides.
export interface McpServerSpec {
  // /^[a-z][a-z0-9_]{1,30}$/, unique in the list; the Codex server name. The
  // connector slug is used verbatim.
  name: string;
  // https only; no credentials, query or fragment.
  url: string;
  // Fixed non-secret headers merged with the per-user Authorization header.
  headers: Record<string, string>;
  // → Codex enabled_tools (defence in depth); the connector's allowedTools.
  enabledTools?: string[];
  // Tools the member allowed for this chat (chat.toolApprovals). The adapter
  // answers their approval requests itself; it can only skip a question, never
  // widen enabledTools. Not part of the adapter's MCP fingerprint, so growing
  // it does not restart the chat's Codex process. Included only when non-empty.
  approvedTools?: string[];
  // The connector's criticalTools: they ask every time, never covered by
  // approvedTools. Included only when non-empty.
  criticalTools?: string[];
  toolTimeoutSec: number;
  startupTimeoutSec: number;
}
