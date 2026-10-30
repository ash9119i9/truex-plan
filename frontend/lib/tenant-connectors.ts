// Directory connectors (MCP) in the tenant workspace (platform-next
// /api/v1/connectors). Wire parsers, thin API wrappers and the pure helpers
// the connected-tools screen, the agent-dialog picker and the chat tool cards
// render from, so the components only render. Every request names this tab's
// tenant through api(). The business user never sees a URL, a token or the
// word "MCP"; connectors have a display name ("GitHub") and read-only tools.
import { api, ApiRequestError } from "./api.ts";
import { mask } from "./mask.ts";

// A connection's status, as the platform reports it (slice 2/4 contract).
// "not_connected": the member has never signed in to this connector; "active":
// a verified connection; "needs_reconnect": the token aged out or was revoked;
// "needs_admin_approval": an org has not installed the app for the member.
export type ConnectionStatus =
  "not_connected" | "active" | "needs_reconnect" | "needs_admin_approval";

export interface ConnectorConnection {
  status: ConnectionStatus;
  account: { login: string } | null;
  toolCount: number | null;
  lastVerifiedAt: string | null;
}

// Whether an agent lets a connector's write tools run. "read_write" (the
// default, absent on the wire) allows them, each guarded by a per-call
// approval; "read_only" strips them (write access contract, 2026-10-20).
export type ConnectorAccess = "read_write" | "read_only";

export interface Connector {
  slug: string;
  displayName: string;
  description: string;
  icon: string;
  // Measured when a member connects; shown while attaching ("~8k tokens per
  // message"). Absent until someone has connected at least once.
  toolTokenEstimate: number | null;
  // The connector's tools that change data (always present, [] when none).
  // The agent dialog shows an access choice only when this is non-empty.
  writeTools: string[];
  // Shown on the needs_admin_approval state: how to ask an admin to install
  // the app. Absent when the connector needs no admin step.
  adminHelp: { text: string; url: string } | null;
  connection: ConnectorConnection;
}

// A connector as it appears on an agent or chat: the catalog identity plus
// whether the product team still offers it. `available: false` means
// connecting cannot help (slice 4/5 contract).
export interface ConnectorRef {
  slug: string;
  displayName: string;
  icon: string;
  available: boolean;
  // Whether the agent attaches this connector read-only. Absent on the wire
  // means "read_write" (so older documents keep their meaning).
  access: ConnectorAccess;
}

// At most this many connectors on one agent or chat (v1 cap; keeps the
// per-turn tool-schema cost bounded, plan "Risks").
export const MAX_CONNECTORS = 3;

// The sessionStorage key a chat Connect card stores its return path under, so
// the member lands back on the chat after signing in to the connector.
export const RETURN_KEY = "truex.connectors.return";

// A stored return path, or null unless it is a same-origin path ("/t/…").
// Rejects "//host", "/\\host" and anything with a scheme, so the back link
// can never leave the app or run script.
export function safeReturnPath(value: string | null): string | null {
  if (!value || value.length > 2048) return null;
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/\\")
  )
    return null;
  return /[\u0000-\u001f]/.test(value) ? null : value;
}

const SLUG = /^[a-z][a-z0-9_]{1,30}$/;
// A connector tool name, matching the adapter's enabledTools charset.
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const CONNECTION_STATUSES: readonly ConnectionStatus[] = [
  "not_connected",
  "active",
  "needs_reconnect",
  "needs_admin_approval",
];

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Raw)
    : null;
const str = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length <= max ? value : null;
const slugOf = (value: unknown): string | null =>
  typeof value === "string" && SLUG.test(value) ? value : null;
const date = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : null;
const nonNeg = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
const oneOf = <T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null => (allowed.includes(value as T) ? (value as T) : null);

// A list of connector tool names, dropping anything that is not a valid name.
const toolNames = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter(
        (v): v is string => typeof v === "string" && TOOL_NAME.test(v),
      )
    : [];

function parseConnection(value: unknown): ConnectorConnection {
  const c = record(value);
  const account = record(c?.account);
  const login = str(account?.login, 200);
  return {
    status: oneOf(c?.status, CONNECTION_STATUSES) ?? "not_connected",
    account: login ? { login } : null,
    toolCount: nonNeg(c?.toolCount),
    lastVerifiedAt: date(c?.lastVerifiedAt),
  };
}

// A malformed connector from the server is dropped rather than rendered.
export function parseConnector(value: unknown): Connector | null {
  const c = record(value);
  const slug = slugOf(c?.slug);
  const displayName = str(c?.displayName, 200);
  if (!c || !slug || !displayName) return null;
  const help = record(c.adminHelp);
  const helpText = str(help?.text, 500);
  const helpUrl = str(help?.url, 2048);
  return {
    slug,
    displayName,
    description: str(c.description, 1000) ?? "",
    icon: str(c.icon, 100) ?? "plug",
    toolTokenEstimate: nonNeg(c.toolTokenEstimate),
    writeTools: toolNames(c.writeTools),
    adminHelp:
      help && helpText && helpUrl ? { text: helpText, url: helpUrl } : null,
    connection: parseConnection(c.connection),
  };
}

// A connector reference on an agent or chat. Missing `available` is read as
// unavailable, so a stale reference never shows a live Connect button.
export function parseConnectorRef(value: unknown): ConnectorRef | null {
  const c = record(value);
  const slug = slugOf(c?.slug);
  const displayName = str(c?.displayName, 200);
  if (!c || !slug || !displayName) return null;
  return {
    slug,
    displayName,
    icon: str(c.icon, 100) ?? "plug",
    available: c.available === true,
    // Only "read_only" narrows access; anything else (absent included) is the
    // read_write default.
    access: c.access === "read_only" ? "read_only" : "read_write",
  };
}

const list = <T>(value: unknown, parse: (v: unknown) => T | null): T[] =>
  Array.isArray(value)
    ? value.flatMap((v) => {
        const parsed = parse(v);
        return parsed ? [parsed] : [];
      })
    : [];

export const parseConnectorRefs = (value: unknown): ConnectorRef[] =>
  list(value, parseConnectorRef);

// ---- Status presentation ----

// How a connection status reads on the Connected tools screen: a short label,
// a tone for the status dot/pill (never colour-only — the label carries the
// meaning for screen readers), and the primary action it offers.
export type StatusTone = "neutral" | "good" | "warn";
export type ConnectorAction = "connect" | "reconnect" | "admin" | "manage";

export interface StatusView {
  label: string;
  tone: StatusTone;
  action: ConnectorAction;
}

export function statusView(connection: ConnectorConnection): StatusView {
  switch (connection.status) {
    case "active":
      return { label: "Connected", tone: "good", action: "manage" };
    case "needs_reconnect":
      return { label: "Reconnect needed", tone: "warn", action: "reconnect" };
    case "needs_admin_approval":
      return { label: "Needs admin approval", tone: "warn", action: "admin" };
    default:
      return { label: "Not connected", tone: "neutral", action: "connect" };
  }
}

// The one-line detail under a connector's status: who it is connected as and
// how many tools it offers, or an empty string when nothing is known yet.
export function connectionDetail(connection: ConnectorConnection): string {
  const parts: string[] = [];
  if (connection.account?.login)
    parts.push(`Connected as @${connection.account.login}`);
  if (connection.toolCount != null)
    parts.push(
      connection.toolCount === 1 ? "1 tool" : `${connection.toolCount} tools`,
    );
  return parts.join(" · ");
}

// The "~8k tokens per message" hint shown while attaching a connector to an
// agent, or an empty string when no estimate has been measured yet. Rounded
// to a readable scale so the picker reads as guidance, not a precise count.
export function tokenEstimateHint(estimate: number | null): string {
  if (estimate == null || estimate <= 0) return "";
  const rounded =
    estimate >= 1000
      ? `${Math.round(estimate / 1000)}k`
      : `${Math.round(estimate / 100) * 100}`;
  return `~${rounded} tokens per message`;
}

// ---- Catalog state: not configured vs a list ----

// GET /api/v1/connectors answers either a connector list or, when the feature
// is off, 503 CONNECTORS_NOT_CONFIGURED. The screen shows a calm "not
// available" state for the latter, not an error.
export type ConnectorsResult =
  { kind: "list"; connectors: Connector[] } | { kind: "not_configured" };

// True when an error means the connectors feature is turned off, not a
// failure to show.
export function isNotConfigured(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    error.code === "CONNECTORS_NOT_CONFIGURED"
  );
}

// ---- Callback result (the connected-tools page) ----

// The safe error codes the OAuth callback can land with. No provider text and
// no raw code is shown to the member; each maps to a human sentence.
export type CallbackErrorCode =
  | "cancelled"
  | "state_invalid"
  | "expired"
  | "not_member"
  | "exchange_failed"
  | "verify_failed"
  | "permissions_missing"
  | "unavailable";

// What a callback outcome says, with the connector's display name folded in
// when it is known. `name` is the display name ("GitHub") or a neutral
// fallback when the slug is not in the catalog.
export function callbackErrorMessage(
  code: string,
  name = "the connector",
): string {
  switch (code) {
    case "cancelled":
      return `Sign-in to ${name} was cancelled. You can try again when you're ready.`;
    case "state_invalid":
    case "expired":
      return `That sign-in link to ${name} expired. Start again from Connected tools.`;
    case "not_member":
      return `You're no longer a member of this workspace, so ${name} couldn't be connected.`;
    case "exchange_failed":
      return `${name} couldn't complete sign-in. Try connecting again.`;
    case "verify_failed":
      return `We connected to ${name} but couldn't confirm access. Try connecting again.`;
    case "permissions_missing":
      return `${name} didn't grant all the access Truex needs. Connect again and leave every permission selected.`;
    case "unavailable":
      return `${name} is temporarily unavailable. Try connecting again in a moment.`;
    default:
      return `${name} couldn't be connected. Try connecting again.`;
  }
}

// The callback success / error, read from the page's query string. On success
// `connected` is the slug; on failure `error` is a safe code and `connector`
// the slug it concerns (both optional on the non-tenant fallback page).
export type CallbackOutcome =
  | { kind: "connected"; slug: string }
  | { kind: "error"; code: string; slug: string | null }
  | { kind: "none" };

export function readCallback(search: string): CallbackOutcome {
  const params = new URLSearchParams(search);
  const connected = slugOf(params.get("connected"));
  if (connected) return { kind: "connected", slug: connected };
  const error = params.get("error");
  if (error)
    return {
      kind: "error",
      // The code is shown only as a small reference; keep it short and safe.
      code: str(error, 60) ?? "unknown",
      slug: slugOf(params.get("connector")),
    };
  return { kind: "none" };
}

// ---- 409 CONNECTION_REQUIRED (the chat Connect card) ----

// Sending to a chat whose agent attaches a connector the member hasn't
// connected fails with 409 CONNECTION_REQUIRED, carrying the connectors to
// connect. The typed draft is kept; the card is shown above the composer.
export interface ConnectionRequired {
  message: string;
  connectors: ConnectorRef[];
}

// Reads a 409 CONNECTION_REQUIRED out of a failed send, or null when the
// failure is something else. The platform nests the connectors under
// error.details.connectors (slice 4/5 contract); api() surfaces the code and,
// now, the details.
export function connectionRequired(error: unknown): ConnectionRequired | null {
  if (
    !(error instanceof ApiRequestError) ||
    error.code !== "CONNECTION_REQUIRED"
  )
    return null;
  const connectors = parseConnectorRefs(record(error.details)?.connectors);
  // A 409 with no readable connectors is useless as a Connect card; fall back
  // to the generic failure so the member at least sees why.
  if (!connectors.length) return null;
  return { message: error.message, connectors };
}

// What the Connect card says above the composer. Keeps provider names human
// and lists them in order ("GitHub", "GitHub and Jira", …).
export function connectCardText(connectors: ConnectorRef[]): string {
  const names = connectors.map((c) => c.displayName);
  return `This agent uses ${joinNames(names)}. Connect to continue.`;
}

// "A", "A and B", "A, B and C".
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// ---- Live tool-call cards (the transcript) ----

// A connector tool call as the stream reports it, or as a saved tool message
// carries it. `status` is in flight or settled; `errorCode` is one of the
// adapter's safe codes (slice 3 contract) and is never provider text.
export type ToolStatus = "inProgress" | "completed" | "failed";
export type ToolErrorCode = "REFUSED" | "TOOL_ERROR" | "TIMEOUT" | "UNKNOWN";

export interface ToolCall {
  // The connector's display name is resolved for rendering; the call itself
  // carries the slug.
  connector: string;
  // The raw tool name (snake_case); humanized for display.
  tool: string;
  status: ToolStatus;
  durationMs: number | null;
  errorCode: ToolErrorCode | null;
}

const TOOL_STATUSES: readonly ToolStatus[] = [
  "inProgress",
  "completed",
  "failed",
];
const TOOL_ERROR_CODES: readonly ToolErrorCode[] = [
  "REFUSED",
  "TOOL_ERROR",
  "TIMEOUT",
  "UNKNOWN",
];

// snake_case / camelCase tool name → words a person reads: "list_issues" →
// "list issues", "pull_request_read" → "pull request read". The provider's
// own casing is not trusted to be readable, so it is normalised.
export function humanizeToolName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export const sentence = (text: string) =>
  text ? text.charAt(0).toUpperCase() + text.slice(1) : text;

// A tool step's name, masked (D12): "GitHub · Create branch".
export function toolStepName(connector: string, tool: string): string {
  return `${mask(connector)} · ${sentence(humanizeToolName(mask(tool)))}`;
}

// A duration for a tool card: "1.2 s", "0.4 s", "12 s". Mirrors the chat's own
// usageLine seconds() so a tool card reads like the rest of the transcript.
export function toolDuration(durationMs: number | null): string {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0)
    return "";
  return durationMs < 10_000
    ? `${(durationMs / 1000).toFixed(1)} s`
    : `${Math.round(durationMs / 1000)} s`;
}

// The compact label a tool-call card shows, in the connector's own voice:
//   running   "Using GitHub · get issue"
//   done      "Used GitHub · list issues · 1.2 s"
//   failed    "GitHub · search issues didn't work"  (REFUSED → "not allowed",
//             TIMEOUT → "took too long")
// Duration is omitted when unknown.
export function toolCardLabel(call: ToolCall): string {
  const connector = call.connector;
  const tool = humanizeToolName(call.tool);
  if (call.status === "inProgress") return `Using ${connector} · ${tool}`;
  if (call.status === "completed") {
    const duration = toolDuration(call.durationMs);
    return duration
      ? `Used ${connector} · ${tool} · ${duration}`
      : `Used ${connector} · ${tool}`;
  }
  // failed
  switch (call.errorCode) {
    case "REFUSED":
      return `${connector} · ${tool} wasn't allowed`;
    case "TIMEOUT":
      return `${connector} · ${tool} took too long`;
    default:
      return `${connector} · ${tool} didn't work`;
  }
}

// ---- Connector status banners (a connector failed mid-reply) ----

// A connector server failing during a reply (slice 3 `connector.status`):
// "auth" means the token needs renewing; "unreachable" means the server was
// down and the reply went on without it.
export type ConnectorFailureReason = "auth" | "unreachable" | "unknown";
export type ConnectorStreamStatus = "starting" | "ready" | "failed";

const CONNECTOR_STREAM_STATUSES: readonly ConnectorStreamStatus[] = [
  "starting",
  "ready",
  "failed",
];
const CONNECTOR_FAILURE_REASONS: readonly ConnectorFailureReason[] = [
  "auth",
  "unreachable",
  "unknown",
];

export interface ConnectorBanner {
  connector: string;
  reason: ConnectorFailureReason;
  message: string;
  // An auth failure links the member to Connected tools to reconnect; an
  // unreachable one is informational only.
  reconnect: boolean;
}

// The banner for a connector that failed during a reply, or null when the
// status is not a failure a member should see.
export function connectorBanner(
  status: ConnectorStreamStatus,
  reason: ConnectorFailureReason,
  displayName: string,
): ConnectorBanner | null {
  if (status !== "failed") return null;
  if (reason === "auth")
    return {
      connector: displayName,
      reason,
      message: `${displayName} needs you to reconnect.`,
      reconnect: true,
    };
  if (reason === "unreachable")
    return {
      connector: displayName,
      reason,
      message: `${displayName} couldn't be reached; answering without it.`,
      reconnect: false,
    };
  return {
    connector: displayName,
    reason: "unknown",
    message: `${displayName} had a problem; answering without it.`,
    reconnect: false,
  };
}

// ---- Stream events (lib/tenant-chat-stream.ts delivers these) ----

// A `tool` stream event, normalised. itemId ties started → completed; the
// connector slug and tool name are carried for the card.
export interface ToolEvent {
  itemId: string;
  connector: string;
  tool: string;
  status: ToolStatus;
  durationMs: number | null;
  errorCode: ToolErrorCode | null;
}

export function parseToolEvent(value: unknown): ToolEvent | null {
  const e = record(value);
  const itemId = str(e?.itemId, 200);
  const connector = slugOf(e?.connector);
  const tool = str(e?.tool, 200);
  const status = oneOf(e?.status, TOOL_STATUSES);
  if (!e || !itemId || !connector || !tool || !status) return null;
  return {
    itemId,
    connector,
    tool,
    status,
    durationMs: nonNeg(e.durationMs),
    errorCode: oneOf(e.errorCode, TOOL_ERROR_CODES),
  };
}

// A `connector` stream event, normalised.
export interface ConnectorEvent {
  connector: string;
  status: ConnectorStreamStatus;
  reason: ConnectorFailureReason;
}

export function parseConnectorEvent(value: unknown): ConnectorEvent | null {
  const e = record(value);
  const connector = slugOf(e?.connector);
  const status = oneOf(e?.status, CONNECTOR_STREAM_STATUSES);
  if (!e || !connector || !status) return null;
  return {
    connector,
    status,
    reason: oneOf(e.reason, CONNECTOR_FAILURE_REASONS) ?? "unknown",
  };
}

// ---- Per-call write-tool approvals (write access contract, 2026-10-20) ----

// The member's answer to a write-tool approval, or the way it was closed
// without one. "pending" is the open card; the five decisions settle it.
export type ApprovalDecision =
  "allow" | "allow_for_chat" | "deny" | "expired" | "cancelled";
// The three answers a member can post; the other two decisions only arrive
// from the platform (a timeout or a stop/steer).
export type ApprovalAnswer = "allow" | "allow_for_chat" | "deny";
export type ApprovalStatus = "pending" | ApprovalDecision;

// At most this many params on a card; bounded so a long call can't flood the
// transcript (the adapter caps at 12, this is a defensive mirror).
export const MAX_APPROVAL_PARAMS = 12;
// Each value is model-written and untrusted; it is rendered as plain text and
// cut to this length (the adapter's own cap).
export const MAX_APPROVAL_PARAM_CHARS = 500;

const APPROVAL_DECISIONS: readonly ApprovalDecision[] = [
  "allow",
  "allow_for_chat",
  "deny",
  "expired",
  "cancelled",
];

// One name/value row on an approval card. The model writes these, so the
// value is always a string, trimmed to the cap, and shown as plain text.
export interface ApprovalParam {
  name: string;
  value: string;
}

// An `approval` stream event, normalised. A pending event opens the card at
// its tool row (`itemId`); a settled event carries the `decision` and whether
// the platform answered it automatically (`auto`, an allow-for-chat replay).
export interface ApprovalEvent {
  approvalId: string;
  itemId: string;
  // mcp: a connector tool call. command: a command in the chat's workspace
  // (connector "@workspace"); edits there never ask.
  kind: ApprovalKind;
  connector: string;
  tool: string;
  params: ApprovalParam[];
  status: ApprovalStatus;
  expiresAt: string | null;
  auto: boolean;
  // False when the card must not offer Allow for this chat (a push).
  allowForChat: boolean;
}

export type ApprovalKind = "mcp" | "command";

// A command is shown whole on its card; other values are cut.
const MAX_APPROVAL_COMMAND_CHARS = 4_000;

// The params list, each value stringified and cut. Never HTML: the caller
// renders them as plain text.
export function parseApprovalParams(
  value: unknown,
  commandCard = false,
): ApprovalParam[] {
  if (!Array.isArray(value)) return [];
  const params: ApprovalParam[] = [];
  for (const entry of value) {
    const p = record(entry);
    const name = str(p?.name, 200);
    if (!p || name === null) continue;
    const raw = p.value;
    const text =
      typeof raw === "string"
        ? raw
        : raw == null
          ? ""
          : // A non-string value is stringified so a card never shows
            // "[object Object]" or breaks on it.
            JSON.stringify(raw);
    params.push({
      name,
      value: text.slice(
        0,
        commandCard && name === "command"
          ? MAX_APPROVAL_COMMAND_CHARS
          : MAX_APPROVAL_PARAM_CHARS,
      ),
    });
    if (params.length >= MAX_APPROVAL_PARAMS) break;
  }
  return params;
}

export function parseApprovalEvent(value: unknown): ApprovalEvent | null {
  const e = record(value);
  const approvalId = str(e?.approvalId, 200);
  const itemId = str(e?.itemId, 200);
  const kind: ApprovalKind = e?.kind === "command" ? "command" : "mcp";
  // A command only ever comes from the workspace.
  const connector =
    kind === "mcp"
      ? slugOf(e?.connector)
      : e?.connector === "@workspace"
        ? "@workspace"
        : null;
  const tool = str(e?.tool, 200);
  if (!e || !approvalId || !itemId || !connector || !tool) return null;
  // A missing/unknown status is read as "pending" so a half-formed event
  // never silently settles a card.
  const status =
    e.status === "pending"
      ? "pending"
      : (oneOf(e.status, APPROVAL_DECISIONS) ?? "pending");
  return {
    approvalId,
    itemId,
    kind,
    connector,
    tool,
    params: parseApprovalParams(e.params, kind === "command"),
    status,
    expiresAt: date(e.expiresAt),
    auto: e.auto === true,
    allowForChat: e.allowForChat !== false,
  };
}

// The one-line outcome a settled approval shows in place of the card, or on a
// saved tool row. "pending" has no outcome (the card is still shown).
export function approvalOutcomeLabel(status: ApprovalStatus): string | null {
  switch (status) {
    case "allow":
      return "Allowed";
    case "allow_for_chat":
      return "Allowed for this chat";
    case "deny":
      return "Denied";
    case "expired":
      return "Expired — not run";
    case "cancelled":
      return "Cancelled";
    default:
      return null;
  }
}

// A saved tool message's `tool` payload (role "tool", text ""): the settled
// call stored with the chat. A still-running call saved at settle is
// `failed`/`UNKNOWN` (slice 4/5 contract), so a saved tool is never shown as
// in progress.
export interface SavedTool {
  connector: string;
  name: string;
  status: "completed" | "failed";
  durationMs: number | null;
  errorCode: ToolErrorCode | null;
  // The member's decision, when this call needed approval. Absent on
  // read-only calls (no approval was asked).
  approval?: ApprovalDecision;
}

export function parseSavedTool(value: unknown): SavedTool | null {
  const t = record(value);
  const connector = slugOf(t?.connector);
  const name = str(t?.name, 200);
  const status =
    t?.status === "failed"
      ? "failed"
      : t?.status === "completed"
        ? "completed"
        : null;
  if (!t || !connector || !name || !status) return null;
  const approval = oneOf(t.approval, APPROVAL_DECISIONS);
  return {
    connector,
    name,
    status,
    durationMs: nonNeg(t.durationMs),
    errorCode: oneOf(t.errorCode, TOOL_ERROR_CODES),
    ...(approval ? { approval } : {}),
  };
}

// The label a saved tool row shows for its approval decision, or null when it
// carries none. A denied/expired/cancelled call never ran, so it reads "Not
// run"; an allowed one shows the same outcome label as the live card.
export function savedApprovalLabel(approval: ApprovalDecision): string {
  if (approval === "deny" || approval === "expired" || approval === "cancelled")
    return "Not run";
  return approvalOutcomeLabel(approval) ?? "";
}

// The display name for a connector slug, from a catalog or reference list; the
// slug itself (capitalised) when it is not known, so a card never shows a raw
// lowercase slug.
export function connectorName(
  slug: string,
  known: ReadonlyArray<{ slug: string; displayName: string }>,
): string {
  const match = known.find((c) => c.slug === slug);
  if (match) return match.displayName;
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

// ---- API wrappers ----

// The catalog merged with my connection status. 503 CONNECTORS_NOT_CONFIGURED
// is not an error here: the feature is off, and the screen says so calmly.
export async function fetchConnectors(): Promise<ConnectorsResult> {
  try {
    const data = record(await api("/api/v1/connectors"));
    return { kind: "list", connectors: list(data?.connectors, parseConnector) };
  } catch (error) {
    if (isNotConfigured(error)) return { kind: "not_configured" };
    throw error;
  }
}

// Starts sign-in: the platform returns the authorize URL and sets the sealed
// flow cookie; the browser then navigates. The URL is not stored or logged.
export async function startConnect(slug: string): Promise<string> {
  const data = record(
    await api(`/api/v1/connectors/${encodeURIComponent(slug)}/connect`, {}),
  );
  const url = str(data?.authorizeUrl, 4096);
  if (!url)
    throw new Error("The connector returned an unreadable sign-in link.");
  return url;
}

// Re-checks a saved connection; the fresh status replaces the row's.
export async function verifyConnection(
  slug: string,
): Promise<ConnectorConnection> {
  const data = record(
    await api(
      `/api/v1/connectors/${encodeURIComponent(slug)}/connection/verify`,
      {},
    ),
  );
  return parseConnection(data?.connection);
}

// Disconnects. `revoked: false` means the grant could not be revoked at the
// provider (the record is still deleted), so the member is shown the manual
// "remove at <provider>" hint.
export async function disconnect(slug: string): Promise<{ revoked: boolean }> {
  const data = record(
    await api(
      `/api/v1/connectors/${encodeURIComponent(slug)}/connection`,
      undefined,
      undefined,
      "DELETE",
    ),
  );
  return { revoked: data?.revoked === true };
}

// Posting an answer to a write-tool approval. "ok" carries the decision the
// platform recorded; "resolved" / "not_found" are the first-answer-wins
// races (409 APPROVAL_RESOLVED / 404 APPROVAL_NOT_FOUND), which the card
// turns into "Already answered" / "Expired". "failed" is anything else
// (e.g. a 503 the member can retry), carrying a message to show.
export type ApprovalPostResult =
  | { kind: "ok"; decision: ApprovalAnswer }
  | { kind: "resolved" }
  | { kind: "not_found" }
  | { kind: "failed"; message: string };

// Reads a failed approval POST into one of the first-answer outcomes, or null
// when the failure is not an approval race (so the caller treats it as
// "failed").
export function approvalRaceOutcome(
  error: unknown,
): "resolved" | "not_found" | null {
  if (!(error instanceof ApiRequestError)) return null;
  if (error.code === "APPROVAL_RESOLVED") return "resolved";
  if (error.code === "APPROVAL_NOT_FOUND") return "not_found";
  return null;
}

// Answers one approval. The route is owner-only and records the chat allow on
// a 200; the first answer wins, so a late answer to a settled approval comes
// back 409/404 and is reported as such rather than thrown.
export async function postApproval(
  chatId: string,
  runId: string,
  approvalId: string,
  decision: ApprovalAnswer,
): Promise<ApprovalPostResult> {
  const path =
    `/api/v1/chats/${encodeURIComponent(chatId)}` +
    `/runs/${encodeURIComponent(runId)}` +
    `/approvals/${encodeURIComponent(approvalId)}`;
  try {
    const data = record(await api(path, { decision }));
    // The platform echoes the decision; fall back to the one posted so a
    // terse 200 still settles the card correctly.
    const echoed = oneOf(data?.decision, [
      "allow",
      "allow_for_chat",
      "deny",
    ] as const);
    return { kind: "ok", decision: echoed ?? decision };
  } catch (error) {
    const race = approvalRaceOutcome(error);
    if (race) return { kind: race };
    return {
      kind: "failed",
      message:
        error instanceof ApiRequestError
          ? error.message
          : "This answer couldn't be sent. Try again.",
    };
  }
}
