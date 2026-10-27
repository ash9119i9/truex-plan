import type { ObjectId } from "mongodb";
import { invalid, objectWith } from "../../common/validation";
import { egressHost } from "./network-host";
import {
  REQUEST_METHODS,
  type RequestMethod,
  type RunNetworkConnector,
  type RunNetworkPolicy,
} from "./network-policy";

// Block, then ask (tasks/coding-agent-plan.md § Decisions 6). The proxy
// refuses a sandbox request it may not send; the runtime reports it as a
// `network.blocked` event, which the run saves as a tool message carrying a
// MessageNetwork. The chat owner then answers the card, and an allow becomes
// a ChatNetworkGrant that widens the chat's later runs. Nothing here trusts
// the runtime's classification: the widest answer is recomputed from the
// block (blockGrant), and every grant is checked again against the run's
// own policy when it is applied (applyNetworkGrants).

//   unlisted   a site not in the policy
//   write      a connector request outside its reads
//   read_only  a write to a connection the agent may only read
//   refused    a private address, a denied name or anything else
export const NETWORK_BLOCK_KINDS = [
  "unlisted",
  "write",
  "read_only",
  "refused",
] as const;
export type NetworkBlockKind = (typeof NETWORK_BLOCK_KINDS)[number];

// The widest answer a card may offer: Allow for this chat, Allow once, or
// nothing but Keep blocked.
export type NetworkGrantScope = "chat" | "once" | "none";

export const NETWORK_DECISIONS = [
  "allow_once",
  "allow_for_chat",
  "keep_blocked",
] as const;
export type NetworkDecision = (typeof NETWORK_DECISIONS)[number];

// A refused sandbox request as the member sees it, saved on a role `tool`
// message. `method` is CONNECT for a site refused before any request was
// seen. Paths are never known (the proxy reports host and method only).
export interface MessageNetwork {
  host: string;
  method: string;
  kind: NetworkBlockKind;
  connector?: { name: string; displayName: string; account?: string };
  critical: boolean;
  grant: NetworkGrantScope;
  // The owner's answer, once given. Absent while the card is open.
  decision?: NetworkDecision;
  decidedAt?: Date;
}

// One allow on a chat. `connector` and `method` are set for a write to a
// connection, absent for an unlisted site. A `once` grant is used by the next
// run that starts after it and then removed.
export interface ChatNetworkGrant {
  messageId: ObjectId;
  host: string;
  connector?: string;
  method?: RequestMethod;
  scope: "once" | "chat";
  at: Date;
}

// At most this many grants per chat, so a member cannot grow a chat's policy
// without bound.
export const MAX_CHAT_NETWORK_GRANTS = 50;

const BLOCK_HOST = /^[a-z0-9.\-:[\]]{1,253}$/;
const BLOCK_METHOD = /^[A-Z]{3,10}$/;
const MAX_NAME = 120;

// The widest answer for a block, from the block alone. A site may be allowed
// for the chat only when it is a public host name; a connector write only
// when the connection may write, and critical ones only once.
export function blockGrant(
  kind: NetworkBlockKind,
  host: string,
  method: string,
  critical: boolean,
): NetworkGrantScope {
  if (kind === "unlisted") return publicHost(host) ? "chat" : "none";
  if (kind === "write")
    return isRequestMethod(method) ? (critical ? "once" : "chat") : "none";
  return "none";
}

// The runtime's block event or item, checked. Null when it is malformed.
export function networkBlockOf(
  value: Record<string, unknown>,
): Omit<MessageNetwork, "decision" | "decidedAt"> | null {
  const { host, method, kind } = value;
  if (typeof host !== "string" || !BLOCK_HOST.test(host)) return null;
  if (typeof method !== "string" || !BLOCK_METHOD.test(method)) return null;
  if (
    typeof kind !== "string" ||
    !(NETWORK_BLOCK_KINDS as readonly string[]).includes(kind)
  )
    return null;
  const blockKind = kind as NetworkBlockKind;
  const critical = value.critical === true;
  let connector: MessageNetwork["connector"];
  const raw = value.connector as Record<string, unknown> | null | undefined;
  if (raw && typeof raw === "object") {
    if (
      typeof raw.name !== "string" ||
      typeof raw.displayName !== "string" ||
      raw.name.length === 0 ||
      raw.name.length > MAX_NAME ||
      raw.displayName.length > MAX_NAME
    )
      return null;
    connector = {
      name: raw.name,
      displayName: raw.displayName,
      ...(typeof raw.account === "string" && raw.account.length <= MAX_NAME
        ? { account: raw.account }
        : {}),
    };
  }
  // A write names its connector; nothing else does.
  if ((blockKind === "write" || blockKind === "read_only") !== !!connector)
    return null;
  return {
    host,
    method,
    kind: blockKind,
    ...(connector ? { connector } : {}),
    critical,
    grant: blockGrant(blockKind, host, method, critical),
  };
}

export function parseNetworkDecision(body: unknown): NetworkDecision {
  const raw = objectWith(body, ["decision"], "Request body");
  if (!(NETWORK_DECISIONS as readonly unknown[]).includes(raw.decision))
    invalid(`decision must be one of: ${NETWORK_DECISIONS.join(", ")}.`);
  return raw.decision as NetworkDecision;
}

// A block checked against the policy the run was given: a connector write's
// `critical` flag and access come from the connection's own catalog rules,
// never from the runtime, so the card can't offer more than a grant would
// later apply. A write naming a connection or host the run didn't have can't
// be allowed.
export function reconcileBlock(
  block: Omit<MessageNetwork, "decision" | "decidedAt">,
  policy: RunNetworkPolicy | undefined,
): Omit<MessageNetwork, "decision" | "decidedAt"> {
  if (!block.connector) return block;
  const connector = policy?.connectors.find(
    (c) => c.name === block.connector!.name,
  );
  if (!connector || !connector.hosts.includes(block.host))
    return { ...block, critical: false, grant: "none" };
  const kind = connector.access === "read_only" ? "read_only" : block.kind;
  const critical =
    isRequestMethod(block.method) &&
    isCritical(connector, block.host, block.method);
  return {
    ...block,
    kind,
    critical,
    grant: blockGrant(kind, block.host, block.method, critical),
  };
}

// Whether the decision is one the card offered.
export function decisionAllowed(
  grant: NetworkGrantScope,
  decision: NetworkDecision,
): boolean {
  if (decision === "keep_blocked") return true;
  if (decision === "allow_once") return grant !== "none";
  return grant === "chat";
}

// The run's policy widened by the chat's grants, and the `once` grants it
// used (removed when the run ends). A grant only ever adds what its block
// asked for: an unlisted public host, or one method on one host of a
// connection that is in this run's policy and may write. A critical request
// is never added by a `chat` grant, even if one was stored.
export function applyNetworkGrants(
  policy: RunNetworkPolicy,
  grants: readonly ChatNetworkGrant[] | undefined,
): { policy: RunNetworkPolicy; onceIds: ObjectId[] } {
  if (!grants || grants.length === 0) return { policy, onceIds: [] };
  const hosts = new Set(policy.hosts);
  const owned = new Set(policy.connectors.flatMap((c) => c.hosts));
  const connectors = new Map<string, RunNetworkConnector>(
    policy.connectors.map((c) => [
      c.name,
      { ...c, reads: c.reads.map((r) => ({ ...r })) },
    ]),
  );
  const onceIds: ObjectId[] = [];
  for (const grant of grants) {
    let applied = false;
    if (grant.connector === undefined) {
      if (publicHost(grant.host) && !owned.has(grant.host)) {
        hosts.add(grant.host);
        applied = true;
      }
    } else {
      const connector = connectors.get(grant.connector);
      const method = grant.method;
      if (
        connector &&
        method &&
        connector.access === "read_write" &&
        connector.hosts.includes(grant.host) &&
        (grant.scope === "once" || !isCritical(connector, grant.host, method))
      ) {
        connector.reads.push({ methods: [method], hosts: [grant.host] });
        applied = true;
      }
    }
    if (applied && grant.scope === "once") onceIds.push(grant.messageId);
  }
  return {
    policy: {
      hosts: [...hosts].sort(),
      connectors: [...connectors.values()],
    },
    onceIds,
  };
}

// The block names a host and a method, never a path, so a method a critical
// rule covers on this host is critical whatever the path (the adapter's
// classifyBlock applies the same rule).
function isCritical(
  connector: RunNetworkConnector,
  host: string,
  method: RequestMethod,
): boolean {
  return connector.critical.some(
    (rule) =>
      rule.methods.includes(method) &&
      (rule.hosts ?? connector.hosts).includes(host),
  );
}

function isRequestMethod(method: string): method is RequestMethod {
  return (REQUEST_METHODS as readonly string[]).includes(method);
}

function publicHost(host: string): boolean {
  try {
    return egressHost(host, "host") === host;
  } catch {
    return false;
  }
}
