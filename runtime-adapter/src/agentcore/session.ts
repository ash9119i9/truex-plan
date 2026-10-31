import { createHash } from "node:crypto";

// One AgentCore runtime session (one microVM) per chat. The ID is derived
// from the chat, never stored, so any caller that knows the chat reaches the
// same session. The platform's AgentCore transport computes the same value;
// both sides pin it with one test vector.

// The header AgentCore sets on every request to an HTTP-protocol runtime.
export const SESSION_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id";

// "chat-" + 64 hex = 69 characters (AgentCore needs at least 33). Tenant and
// chat IDs can't contain "/", so the hashed text is unambiguous.
export function agentCoreSessionId(tenantId: string, chatId: string): string {
  return `chat-${createHash("sha256").update(`${tenantId}/${chatId}`).digest("hex")}`;
}
