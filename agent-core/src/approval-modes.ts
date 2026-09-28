import {
  ALLOW_FOR_CHAT,
  APPROVAL_MODES,
  type ApprovalMode,
} from "../../shared/contracts";
import { HttpError } from "./errors";
// Alpha approval modes: pure helpers; the manager owns thread state.
export const TOOL_QUESTION = "mcp_tool_call_approval";
// Settle reason suffix for a tool allowed by an earlier "Allow for this
// chat" answer: "auto-mode:grant", whatever the chat's mode.
export const GRANT = "grant";
export const AUTO_MODE_NOTE =
  "user_note: Answered by the chat's approval mode with the recommended option.";
export const CHAT_GRANT_OPTION = {
  label: ALLOW_FOR_CHAT,
  description: "Don't ask again for this action in this chat.",
};
export interface ToolRef {
  server: string | null;
  tool: string;
  // Who the question named when it did not name a server (a connector).
  actor?: string;
}
// server -> tool -> read-only
export type ToolIndex = Map<string, Map<string, boolean>>;
export function approvalMode(value: unknown): ApprovalMode {
  if (
    typeof value === "string" &&
    (APPROVAL_MODES as readonly string[]).includes(value)
  )
    return value as ApprovalMode;
  throw new HttpError(
    400,
    `Approval mode must be one of ${APPROVAL_MODES.join(", ")}`,
    "INVALID_APPROVAL_MODE",
  );
}
export const isToolQuestion = (q: any) =>
  typeof q?.id === "string" && q.id.startsWith(TOOL_QUESTION);
// Codex's fallback wording; custom templates or connector names may leave
// the server unknown.
const QUESTION =
  /^Allow (?:the (.+) MCP server|(this app)|(.+?)) to run tool "(.+)"\?$/;
export function parseToolQuestion(text: unknown): ToolRef | null {
  if (typeof text !== "string") return null;
  const m = QUESTION.exec(text.trim());
  if (!m) return null;
  if (m[1] || m[2]) return { server: m[1] ?? "codex_apps", tool: m[4] };
  return { server: null, tool: m[4], actor: m[3] };
}
// Tool names may be raw ("search") or qualified ("mcp__crm__search");
// candidates are tried in order.
export function toolCandidates(ref: ToolRef): ToolRef[] {
  const m = /^mcp__(.+?)__(.+)$/.exec(ref.tool);
  const out: ToolRef[] = [];
  if (m && (ref.server === null || ref.server === m[1]))
    out.push({ ...ref, server: m[1], tool: m[2] });
  out.push(ref);
  return out;
}
// A chat grant covers one server + tool; a question that names only a
// connector is keyed by that name instead.
export function grantKey(ref: ToolRef) {
  const c = toolCandidates(ref)[0];
  return `${c.server ?? "actor:" + (c.actor ?? "")}\u0000${c.tool}`;
}
const READ_VERBS = new Set([
  "get",
  "list",
  "search",
  "read",
  "fetch",
  "query",
  "find",
  "describe",
  "count",
]);
export function readOnlyName(name: string) {
  const first = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean)[0];
  return !!first && READ_VERBS.has(first.toLowerCase());
}
// Only readOnlyHint === true counts; the name heuristic applies only to a
// tool with no annotations at all.
export function readOnlyTool(name: string, tool: any, heuristic: boolean) {
  const a = tool?.annotations;
  if (a !== undefined && a !== null) return a?.readOnlyHint === true;
  return heuristic && readOnlyName(name);
}
export function indexTools(statuses: any[], heuristic: boolean): ToolIndex {
  const index: ToolIndex = new Map();
  for (const s of statuses) {
    if (typeof s?.name !== "string") continue;
    const tools = index.get(s.name) ?? new Map<string, boolean>();
    for (const [name, tool] of Object.entries(s.tools ?? {}))
      if (tool) tools.set(name, readOnlyTool(name, tool, heuristic));
    index.set(s.name, tools);
  }
  return index;
}
// Resolves a tool against the index: its read-only flag and its server
// (found by name when the question did not say which server).
export function findTool(index: ToolIndex, ref: ToolRef) {
  for (const c of toolCandidates(ref)) {
    if (c.server !== null) {
      const hit = index.get(c.server)?.get(c.tool);
      if (hit !== undefined) return { server: c.server, readOnly: hit };
      continue;
    }
    const servers = [...index].filter(([, tools]) => tools.has(c.tool));
    if (servers.length === 1)
      return {
        server: servers[0][0],
        readOnly: servers[0][1].get(c.tool) === true,
      };
  }
  return null;
}
// Adds the chat grant after "Allow" on tool approval questions.
export function withChatGrant(detail: any) {
  if (!Array.isArray(detail?.questions)) return detail;
  return {
    ...detail,
    questions: detail.questions.map((q: any) => {
      if (!isToolQuestion(q) || !Array.isArray(q.options)) return q;
      // A grant needs a tool to remember; unparsed wording gets none.
      if (!parseToolQuestion(q.question)) return q;
      if (q.options.some((o: any) => o?.label === ALLOW_FOR_CHAT)) return q;
      const at = q.options.findIndex((o: any) => o?.label === "Allow");
      if (at < 0) return q;
      const options = [...q.options];
      options.splice(at + 1, 0, CHAT_GRANT_OPTION);
      return { ...q, options };
    }),
  };
}
