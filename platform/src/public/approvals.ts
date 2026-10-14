import { ALLOW_FOR_CHAT, AUTO_MODE_REASON } from "../../../shared/contracts";
// Codex asks for MCP tool approval through requestUserInput with this id
// prefix and a question naming the server and raw tool id. Those names are
// internal, so the public copy describes the action instead.
const TOOL_APPROVAL_PREFIX = "mcp_tool_call_approval";
const TOOL_APPROVAL_QUESTION = /^Allow .+ to run tool "([^"]+)"\??$/s;
// Option labels are the values Codex matches on; only descriptions change.
const TOOL_APPROVAL_OPTIONS: Record<string, string> = {
  Allow: "Run it this one time.",
  "Allow for this session": "Don't ask again for this action in this chat.",
  [ALLOW_FOR_CHAT]: "Don't ask again for this action in this chat.",
  "Allow and don't ask me again": "Always allow this action.",
  Cancel: "Skip this action.",
};
export function toolAction(tool: string): string {
  const words = tool
    .replace(/^mcp__.+?__/, "")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (!words.length) return "";
  const text = words.join(" ");
  return text[0].toUpperCase() + text.slice(1);
}
function question(q: any) {
  const options = q.options?.map((o: any) => ({
    label: o.label,
    description: o.description,
  }));
  if (typeof q.id === "string" && q.id.startsWith(TOOL_APPROVAL_PREFIX)) {
    const tool = TOOL_APPROVAL_QUESTION.exec(String(q.question || ""))?.[1];
    const action = tool ? toolAction(tool) : "";
    return {
      id: q.id,
      kind: "toolApproval",
      header: "Permission needed",
      question: "The assistant wants to use a connected business service.",
      ...(action ? { action } : {}),
      isOther: false,
      isSecret: false,
      options: options?.map((o: any) => ({
        label: o.label,
        description: TOOL_APPROVAL_OPTIONS[o.label] ?? o.description,
      })),
    };
  }
  return {
    id: q.id,
    header: q.header,
    question: q.question,
    isOther: q.isOther === true,
    isSecret: q.isSecret === true,
    options,
  };
}
const TOOL_DECISIONS: Record<string, string> = {
  Allow: "allowedOnce",
  "Allow for this session": "allowedSession",
  [ALLOW_FOR_CHAT]: "allowedChat",
  "Allow and don't ask me again": "allowedAlways",
  Cancel: "declined",
};
const USER_NOTE = "user_note: ";
// A resolved input request as the chat's audit trail shows it. Tool approvals
// reuse the public question projection, so raw server and tool ids stay out.
export function publicApproval(a: any) {
  if (a?.method !== "item/tool/requestUserInput") return null;
  const questions = (a.detail?.questions || []).map(question);
  // Records saved before questions were kept have nothing to show.
  if (!questions.length) return null;
  const answers = a.result?.answers || {};
  const reason = typeof a.reason === "string" ? a.reason : "";
  // Settled by the chat's approval mode, e.g. "auto-mode:readOnly".
  const autoMode = reason.startsWith(AUTO_MODE_REASON)
    ? reason.slice(AUTO_MODE_REASON.length)
    : undefined;
  // Anything other than a user answer means the request went unanswered.
  const outcome =
    a.reason === "user"
      ? "answered"
      : a.reason === "auto-recommended" || autoMode !== undefined
        ? "auto"
        : a.reason === "expired"
          ? "expired"
          : "interrupted";
  const expired = outcome !== "answered" && outcome !== "auto";
  return {
    requestId: a.requestId,
    at: typeof a.at === "string" ? a.at : undefined,
    turnId: typeof a.turnId === "string" ? a.turnId : undefined,
    outcome,
    ...(autoMode ? { autoMode } : {}),
    items: questions.map((q: any, i: number) => {
      const raw = a.detail?.questions?.[i];
      // Free-text feedback on a picked option arrives as a separate
      // "user_note: " entry (for example Revise on plan approval).
      const values: string[] = (answers[q.id]?.answers || []).filter(
        (v: unknown): v is string => typeof v === "string",
      );
      const answer = values.find((v) => !v.startsWith(USER_NOTE)) ?? "";
      const note = values
        .find((v) => v.startsWith(USER_NOTE))
        ?.slice(USER_NOTE.length)
        .trim();
      if (q.kind === "toolApproval")
        return {
          kind: "toolApproval",
          ...(q.action ? { action: q.action } : {}),
          decision: expired ? outcome : TOOL_DECISIONS[answer] || "declined",
        };
      return {
        kind: "question",
        question: q.question,
        // Secret answers are never repeated back.
        ...(raw?.isSecret === true
          ? { secret: true }
          : !expired
            ? { ...(answer ? { answer } : {}), ...(note ? { note } : {}) }
            : {}),
      };
    }),
  };
}
export function request(p: any) {
  if (p.method !== "item/tool/requestUserInput") return null;
  return {
    requestId: p.requestId,
    method: p.method,
    expiresAt: p.expiresAt,
    responseSchema: null,
    detail: {
      questions: (p.detail?.questions || []).map(question),
    },
  };
}
