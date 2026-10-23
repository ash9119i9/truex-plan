import { api, ApiRequestError } from "./api.ts";

// A sandbox request Truex blocked (block, then ask): the agent's command
// tried a site that isn't allowed, or tried to change something through a
// connection. Nothing reached the site. The chat's owner answers the card on
// the saved reply, and an allow applies from the chat's next reply.

export type NetworkKind = "unlisted" | "write" | "read_only" | "refused";
export type NetworkGrant = "chat" | "once" | "none";
export type NetworkDecision = "allow_once" | "allow_for_chat" | "keep_blocked";

export interface NetworkBlock {
  host: string;
  method: string;
  kind: NetworkKind;
  connector: { name: string; displayName: string; account?: string } | null;
  critical: boolean;
  // The widest answer the card offers.
  grant: NetworkGrant;
  // The owner's answer, once given.
  decision: NetworkDecision | null;
}

const KINDS: readonly NetworkKind[] = [
  "unlisted",
  "write",
  "read_only",
  "refused",
];
const GRANTS: readonly NetworkGrant[] = ["chat", "once", "none"];
const DECISIONS: readonly NetworkDecision[] = [
  "allow_once",
  "allow_for_chat",
  "keep_blocked",
];
const HOST = /^[a-z0-9.\-:[\]]{1,253}$/;
const METHOD = /^[A-Z]{3,10}$/;

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Raw)
    : null;
const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : null;
const oneOf = <T extends string>(value: unknown, options: readonly T[]) =>
  options.includes(value as T) ? (value as T) : null;

export function parseNetworkBlock(value: unknown): NetworkBlock | null {
  const n = record(value);
  const host = text(n?.host, 253);
  const method = text(n?.method, 10);
  const kind = oneOf(n?.kind, KINDS);
  const grant = oneOf(n?.grant, GRANTS);
  if (!n || !host || !HOST.test(host) || !method || !METHOD.test(method))
    return null;
  if (!kind || !grant) return null;
  const c = record(n.connector);
  const name = text(c?.name, 120);
  const displayName = text(c?.displayName, 120);
  const account = text(c?.account, 120);
  return {
    host,
    method,
    kind,
    connector:
      name && displayName
        ? { name, displayName, ...(account ? { account } : {}) }
        : null,
    critical: n.critical === true,
    grant,
    decision: oneOf(n.decision, DECISIONS),
  };
}

// The card's one-line title, in plain words.
export function networkTitle(block: NetworkBlock): string {
  const who = block.connector?.displayName ?? block.host;
  switch (block.kind) {
    case "unlisted":
      return `Blocked a connection to ${block.host}`;
    case "write":
      return block.critical
        ? `Blocked an important change to ${who}`
        : `Blocked a change to ${who}`;
    case "read_only":
      return `Blocked a change to ${who}`;
    case "refused":
      return `Blocked a connection to ${block.host}`;
  }
}

// What the card explains under the title.
export function networkDetail(block: NetworkBlock): string {
  switch (block.kind) {
    case "unlisted":
      return "This site isn't on the chat's allowed list, so nothing was sent to it.";
    case "write": {
      const as = block.connector?.account
        ? ` as ${block.connector.account}`
        : "";
      return block.critical
        ? `The agent tried to send ${block.method} to ${block.host}${as}. Important changes are allowed one at a time.`
        : `The agent tried to send ${block.method} to ${block.host}${as}. Nothing was changed.`;
    }
    case "read_only":
      return "This agent can only read this connection, so changes are never sent.";
    case "refused":
      return "Private and internal addresses are never allowed.";
  }
}

export function networkOutcome(decision: NetworkDecision): string {
  return decision === "allow_for_chat"
    ? "Allowed for this chat"
    : decision === "allow_once"
      ? "Allowed for the next reply"
      : "Kept blocked";
}

export type NetworkPostResult =
  | { kind: "ok"; decision: NetworkDecision }
  | { kind: "resolved" }
  | { kind: "failed"; message: string };

// Answers one card. Owner-only; the first answer wins, so a different answer
// later comes back 409 and is reported as "resolved".
export async function postNetworkDecision(
  chatId: string,
  messageId: string,
  decision: NetworkDecision,
): Promise<NetworkPostResult> {
  const path =
    `/api/v1/chats/${encodeURIComponent(chatId)}` +
    `/messages/${encodeURIComponent(messageId)}/network`;
  try {
    const data = record(await api(path, { decision }));
    return {
      kind: "ok",
      decision: oneOf(data?.decision, DECISIONS) ?? decision,
    };
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === "APPROVAL_RESOLVED")
      return { kind: "resolved" };
    return {
      kind: "failed",
      message:
        error instanceof ApiRequestError
          ? error.message
          : "Your answer couldn't be sent. Try again.",
    };
  }
}
