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
