import type { ServerRequest } from "../../shared/protocol/ServerRequest";
import { inventory, validate } from "./schema";
export type ServerMethod = ServerRequest["method"];
export const defaults: Record<ServerMethod, any> = {
  "item/commandExecution/requestApproval": { decision: "decline" },
  "item/fileChange/requestApproval": { decision: "decline" },
  "item/permissions/requestApproval": { permissions: {}, scope: "turn" },
  "item/tool/requestUserInput": { answers: {} },
  "mcpServer/elicitation/request": {
    action: "decline",
    content: null,
    _meta: null,
  },
  "item/tool/call": {
    contentItems: [
      { type: "inputText", text: "No dynamic tool executor configured" },
    ],
    success: false,
  },
  "account/chatgptAuthTokens/refresh": null,
  "attestation/generate": null,
  "currentTime/read": null,
  applyPatchApproval: { decision: { denied: { rejection: "Not approved" } } },
  execCommandApproval: { decision: { denied: { rejection: "Not approved" } } },
};
export function responseSchema(method: string) {
  return (
    inventory.serverRequests.find((x) => x.method === method)?.response || null
  );
}
export function validateResponse(method: string, response: unknown) {
  const name = responseSchema(method);
  if (!name) throw new Error("Unknown request variant");
  validate(name, response);
}
const RECOMMENDED = /\(recommended\)\s*$/i;
export const AUTO_NOTE =
  "user_note: No answer arrived in time; proceeding with the recommended option.";
// When a question times out, answer with its recommended option: the one
// labelled "(Recommended)", Approve for plan approval, else the first option.
// Tool permission prompts and secret questions still fall back to declining.
export function autoAnswer(detail: any) {
  const questions: any[] = Array.isArray(detail?.questions)
    ? detail.questions
    : [];
  if (!questions.length) return null;
  const answers: Record<string, { answers: string[] }> = {};
  for (const q of questions) {
    if (typeof q?.id !== "string" || q.isSecret === true) return null;
    if (q.id.startsWith("mcp_tool_call_approval")) return null;
    const pick = recommendedOption(q);
    if (!pick) return null;
    answers[q.id] = { answers: [pick, AUTO_NOTE] };
  }
  return { answers };
}
// The option a question recommends: the one labelled "(Recommended)",
// Approve for plan approval, else the first option.
export function recommendedOption(q: any): string | null {
  const labels: string[] = (Array.isArray(q?.options) ? q.options : [])
    .map((o: any) => o?.label)
    .filter((l: unknown): l is string => typeof l === "string");
  return (
    labels.find((l) => RECOMMENDED.test(l)) ??
    (q?.id === "plan_approval" ? labels.find((l) => l === "Approve") : null) ??
    labels[0] ??
    null
  );
}
