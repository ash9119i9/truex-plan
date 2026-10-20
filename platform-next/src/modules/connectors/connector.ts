import type { ObjectId } from "mongodb";
import {
  cleanText,
  integer,
  invalid,
  objectWith,
} from "../../common/validation";

// A directory connector in the catalog's `truex_mcp_connectors`, written only
// by the product team through the operator CLI. GitHub is the first entry; the
// shape is generic so a new connector is one more document, not new code.
// Users never see the auth block; they see only ConnectorView.
export const CONNECTORS_COLLECTION = "truex_mcp_connectors";

// v1 handles OAuth user sign-in only. The other values name later auth types
// so a document that asks for one is refused clearly rather than stored.
export const AUTH_TYPES = ["oauth_user"] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

// How the OAuth client was registered. v1 accepts only a pre-registered app
// (GitHub has no dynamic registration); the others are placeholders.
export const REGISTRATIONS = ["preregistered"] as const;
export type Registration = (typeof REGISTRATIONS)[number];

// Only this discovery mode is supported: the authorization server and token
// endpoints are found from the connector URL's protected-resource metadata,
// never hard-coded, so no provider URL lives in code.
export const DISCOVERIES = ["protected_resource_metadata"] as const;
export type Discovery = (typeof DISCOVERIES)[number];

export const REVOKE_KINDS = ["github_app_grant", "rfc7009"] as const;
export type RevokeKind = (typeof REVOKE_KINDS)[number];

// Where the client secret lives. An ARN is resolved from Secrets Manager in
// production; an env name reads process.env for local development only.
export type ClientSecretRef = { arn: string } | { env: string };

// Timeout ranges match the adapter's McpServerSpec (Build contract).
export const MIN_TOOL_TIMEOUT_SEC = 1;
export const MAX_TOOL_TIMEOUT_SEC = 300;
export const MIN_STARTUP_TIMEOUT_SEC = 1;
export const MAX_STARTUP_TIMEOUT_SEC = 60;
export const DEFAULT_TOOL_TIMEOUT_SEC = 60;
export const DEFAULT_STARTUP_TIMEOUT_SEC = 15;

// At most this many tools may be pre-enabled (mirrors the adapter's cap).
const MAX_ALLOWED_TOOLS = 200;
// At most this many tools may change data (a subset of allowedTools).
const MAX_WRITE_TOOLS = 50;
const MAX_FIXED_HEADERS = 16;

export interface ConnectorRevoke {
  kind: RevokeKind;
  // The revocation endpoint, supplied in data so no provider URL is in code.
  // github_app_grant: DELETE this url with {client_id} substituted, Basic
  // client_id:client_secret, JSON body {access_token}. rfc7009: POST here.
  url: string;
}

// Extra authorize-request parameters a provider needs beyond the OAuth core
// (Google issues a refresh token only with access_type=offline, and again on
// a reconnect only with prompt=consent). An allowlist with fixed values, so
// catalog data can never override client_id, redirect_uri, state or PKCE.
export const AUTHORIZE_PARAMS: Readonly<Record<string, readonly string[]>> = {
  access_type: ["online", "offline"],
  prompt: ["none", "consent", "select_account", "login"],
};

export interface ConnectorAuth {
  type: AuthType;
  registration: Registration;
  clientId: string;
  clientSecret: ClientSecretRef;
  scopes: string[];
  discovery: Discovery;
  revoke?: ConnectorRevoke;
  // A read-only tool whose result names the connected account, called once at
  // connect to show "Connected as @octocat". { name: "get_me", field: "login" }
  accountTool?: { name: string; field: string };
  // For servers with no such tool: read this claim from the authorization
  // server's OpenID Connect userinfo endpoint instead, e.g. { field: "email" }.
  // Needs the openid scope (plus the claim's own, e.g. email). Exclusive with
  // accountTool.
  accountUserinfo?: { field: string };
  // Allowlisted extra authorize parameters (AUTHORIZE_PARAMS).
  authorizeParams?: Record<string, string>;
  // Shown when a connection needs an organization admin to approve the app.
  adminHelp?: { text: string; url: string };
}

// Everything the product team supplies for one connector.
export interface ConnectorSpec {
  slug: string;
  displayName: string;
  description: string;
  icon: string;
  url: string;
  fixedHeaders: Record<string, string>;
  auth: ConnectorAuth;
  allowedTools?: string[];
  // Tools that change data (a subset of allowedTools). A read-only agent has
  // these removed from its enabledTools; a read_write agent keeps them, and
  // each call waits for the member's per-call approval. Absent means every
  // allowed tool is read-only.
  writeTools?: string[];
  toolTimeoutSec: number;
  startupTimeoutSec: number;
  toolTokenEstimate?: number;
  sortOrder: number;
}

export interface ConnectorDoc extends ConnectorSpec {
  _id: ObjectId;
  // Soft delete: connections pin a connector's ID, so documents are never
  // removed. A disabled connector leaves the API but stays readable.
  enabled: boolean;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: string;
}

// The slug is the Codex server name and never changes once chosen.
export const CONNECTOR_IDENTITY_FIELDS = ["slug"] as const;

// What a member may see: no URL, no client id, no auth secrets.
export interface ConnectorView {
  slug: string;
  displayName: string;
  description: string;
  icon: string;
  // The tools that change data, so the agent dialog can offer a read/write
  // choice only when the connector has any. Always present ([] when none).
  writeTools: string[];
  toolTokenEstimate?: number;
  adminHelp?: { text: string; url: string };
}

const SLUG = /^[a-z][a-z0-9_]{1,30}$/;
const ICON = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SCOPE = /^[\x21-\x7e]{1,200}$/;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
// Header names RFC 7230 token characters; a safe, conservative subset.
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
// Header values: printable, up to 8192 (matches the adapter's limit).
const HEADER_VALUE = /^[\x20-\x7e]{1,8192}$/;
const CLIENT_ID = /^[\x21-\x7e]{1,256}$/;
// The env name holding a client secret, for local development.
const SECRET_ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const SECRET_ARN =
  /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}$/;

// Header names a connector must never set: they carry credentials, which must
// come only from a user's stored token at run time, never from catalog data.
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);
// A fixed-header value that looks like a credential, refused so a secret can
// never be smuggled into a non-user-editable header. Kept deliberately
// simple: a bearer/basic scheme prefix or a long opaque token-like run.
const CREDENTIAL_VALUE = /^(bearer\s|basic\s|token\s)/i;
const TOKEN_LIKE = /^[A-Za-z0-9._~+/-]{32,}={0,2}$/;

const SPEC_FIELDS = [
  "slug",
  "displayName",
  "description",
  "icon",
  "url",
  "fixedHeaders",
  "auth",
  "allowedTools",
  "writeTools",
  "toolTimeoutSec",
  "startupTimeoutSec",
  "toolTokenEstimate",
  "sortOrder",
];

const AUTH_FIELDS = [
  "type",
  "registration",
  "clientId",
  "clientSecret",
  "scopes",
  "discovery",
  "revoke",
  "accountTool",
  "accountUserinfo",
  "authorizeParams",
  "adminHelp",
];

function optional<T>(value: unknown, parse: (v: unknown) => T): T | undefined {
  return value === undefined ? undefined : parse(value);
}

// An absolute https URL with no credentials, query or fragment. The same rule
// the models and chat configs apply to a base URL.
function httpsUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 2048)
    invalid(`${field} must be a URL.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid(`${field} must be a URL.`);
  }
  if (url.protocol !== "https:") invalid(`${field} must use https.`);
  if (url.username || url.password || url.search || url.hash)
    invalid(`${field} must not contain credentials, a query or a fragment.`);
  return url.href.replace(/\/+$/, "");
}

function clientSecretOf(value: unknown): ClientSecretRef {
  const raw = objectWith(value, ["arn", "env"], "auth.clientSecret");
  const hasArn = raw.arn !== undefined;
  const hasEnv = raw.env !== undefined;
  if (hasArn === hasEnv)
    invalid("auth.clientSecret must set exactly one of arn or env.");
  if (hasArn) {
    if (typeof raw.arn !== "string" || !SECRET_ARN.test(raw.arn))
      invalid("auth.clientSecret.arn must be a Secrets Manager secret ARN.");
    return { arn: raw.arn };
  }
  if (typeof raw.env !== "string" || !SECRET_ENV_NAME.test(raw.env))
    invalid(
      "auth.clientSecret.env must be an UPPER_SNAKE_CASE environment variable name (2-64 characters).",
    );
  return { env: raw.env };
}

function revokeOf(value: unknown): ConnectorRevoke {
  const raw = objectWith(value, ["kind", "url"], "auth.revoke");
  if (
    typeof raw.kind !== "string" ||
    !(REVOKE_KINDS as readonly string[]).includes(raw.kind)
  )
    invalid(`auth.revoke.kind must be one of: ${REVOKE_KINDS.join(", ")}.`);
  return {
    kind: raw.kind as RevokeKind,
    url: httpsUrl(raw.url, "auth.revoke.url"),
  };
}

function accountToolOf(value: unknown): { name: string; field: string } {
  const raw = objectWith(value, ["name", "field"], "auth.accountTool");
  if (typeof raw.name !== "string" || !TOOL_NAME.test(raw.name))
    invalid(
      "auth.accountTool.name must be 1-64 letters, digits, dots, hyphens or underscores.",
    );
  if (typeof raw.field !== "string" || !TOOL_NAME.test(raw.field))
    invalid(
      "auth.accountTool.field must be 1-64 letters, digits, dots, hyphens or underscores.",
    );
  return { name: raw.name, field: raw.field };
}

function accountUserinfoOf(value: unknown): { field: string } {
  const raw = objectWith(value, ["field"], "auth.accountUserinfo");
  if (typeof raw.field !== "string" || !TOOL_NAME.test(raw.field))
    invalid(
      "auth.accountUserinfo.field must be 1-64 letters, digits, dots, hyphens or underscores.",
    );
  return { field: raw.field };
}

// Each parameter must be allowlisted and set to one of its fixed values;
// prompt may be a space-separated set of its values (OpenID Connect).
function authorizeParamsOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("auth.authorizeParams must be a JSON object.");
  const params: Record<string, string> = {};
  for (const [name, param] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const allowed = Object.hasOwn(AUTHORIZE_PARAMS, name)
      ? AUTHORIZE_PARAMS[name]
      : undefined;
    if (!allowed)
      invalid(
        `auth.authorizeParams may set only: ${Object.keys(AUTHORIZE_PARAMS).join(", ")}.`,
      );
    const parts = typeof param === "string" ? param.split(" ") : [];
    const valid =
      parts.length > 0 &&
      parts.every((part) => allowed.includes(part)) &&
      new Set(parts).size === parts.length &&
      (name === "prompt" || parts.length === 1) &&
      !(parts.includes("none") && parts.length > 1);
    if (!valid)
      invalid(
        `auth.authorizeParams.${name} must be one of: ${allowed.join(", ")}.`,
      );
    params[name] = param as string;
  }
  return params;
}

function adminHelpOf(value: unknown): { text: string; url: string } {
  const raw = objectWith(value, ["text", "url"], "auth.adminHelp");
  return {
    text: cleanText(raw.text, "auth.adminHelp.text", 500),
    url: httpsUrl(raw.url, "auth.adminHelp.url"),
  };
}

function authOf(value: unknown): ConnectorAuth {
  const raw = objectWith(value, AUTH_FIELDS, "auth");
  if (
    typeof raw.type !== "string" ||
    !(AUTH_TYPES as readonly string[]).includes(raw.type)
  )
    invalid(
      `auth.type must be one of: ${AUTH_TYPES.join(", ")} (others are not supported yet).`,
    );
  if (
    typeof raw.registration !== "string" ||
    !(REGISTRATIONS as readonly string[]).includes(raw.registration)
  )
    invalid(
      `auth.registration must be one of: ${REGISTRATIONS.join(", ")} (others are not supported yet).`,
    );
  if (typeof raw.clientId !== "string" || !CLIENT_ID.test(raw.clientId))
    invalid("auth.clientId must be 1-256 visible characters with no spaces.");
  if (
    typeof raw.discovery !== "string" ||
    !(DISCOVERIES as readonly string[]).includes(raw.discovery)
  )
    invalid(`auth.discovery must be one of: ${DISCOVERIES.join(", ")}.`);
  if (!Array.isArray(raw.scopes))
    invalid("auth.scopes must be an array of strings.");
  const scopes = raw.scopes.map((scope, index) => {
    if (typeof scope !== "string" || !SCOPE.test(scope))
      invalid(`auth.scopes[${index}] must be 1-200 visible characters.`);
    return scope;
  });
  if (scopes.length > 50) invalid("auth.scopes must have at most 50 entries.");

  const auth: ConnectorAuth = {
    type: raw.type as AuthType,
    registration: raw.registration as Registration,
    clientId: raw.clientId,
    clientSecret: clientSecretOf(raw.clientSecret),
    scopes,
    discovery: raw.discovery as Discovery,
  };
  const revoke = optional(raw.revoke, revokeOf);
  if (revoke !== undefined) auth.revoke = revoke;
  const accountTool = optional(raw.accountTool, accountToolOf);
  if (accountTool !== undefined) auth.accountTool = accountTool;
  const accountUserinfo = optional(raw.accountUserinfo, accountUserinfoOf);
  if (accountUserinfo !== undefined) {
    if (accountTool !== undefined)
      invalid("auth may set accountTool or accountUserinfo, not both.");
    auth.accountUserinfo = accountUserinfo;
  }
  const authorizeParams = optional(raw.authorizeParams, authorizeParamsOf);
  if (authorizeParams !== undefined && Object.keys(authorizeParams).length > 0)
    auth.authorizeParams = authorizeParams;
  const adminHelp = optional(raw.adminHelp, adminHelpOf);
  if (adminHelp !== undefined) auth.adminHelp = adminHelp;
  return auth;
}

// A connector must not pin a credential into a header: those come only from
// the user's token at run time. Refuses credential header names and values
// that look like a secret, naming the field without echoing the value.
function fixedHeadersOf(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("fixedHeaders must be a JSON object.");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_FIXED_HEADERS)
    invalid(`fixedHeaders must have at most ${MAX_FIXED_HEADERS} entries.`);
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of entries) {
    if (!HEADER_NAME.test(name))
      invalid(
        `fixedHeaders name "${name.slice(0, 64)}" must be 1-64 letters, digits or hyphens.`,
      );
    if (CREDENTIAL_HEADERS.has(name.toLowerCase()))
      invalid(`fixedHeaders must not set the "${name}" header.`);
    if (typeof headerValue !== "string" || !HEADER_VALUE.test(headerValue))
      invalid(
        `fixedHeaders "${name}" must be 1-8192 printable characters without control characters.`,
      );
    if (CREDENTIAL_VALUE.test(headerValue) || TOKEN_LIKE.test(headerValue))
      invalid(`fixedHeaders "${name}" must not contain a credential.`);
    headers[name] = headerValue;
  }
  return headers;
}

function allowedToolsOf(value: unknown): string[] {
  if (!Array.isArray(value))
    invalid("allowedTools must be an array of tool names.");
  if (value.length > MAX_ALLOWED_TOOLS)
    invalid(`allowedTools must have at most ${MAX_ALLOWED_TOOLS} entries.`);
  return value.map((tool, index) => {
    if (typeof tool !== "string" || !TOOL_NAME.test(tool))
      invalid(
        `allowedTools[${index}] must be 1-64 letters, digits, dots, hyphens or underscores.`,
      );
    return tool;
  });
}

// The tools that change data: a subset of allowedTools, so a read-only agent
// has a concrete list to subtract. Refused without allowedTools (there would
// be nothing to subtract from) and when any entry is not in allowedTools.
function writeToolsOf(
  value: unknown,
  allowedTools: readonly string[] | undefined,
): string[] {
  if (!Array.isArray(value))
    invalid("writeTools must be an array of tool names.");
  if (allowedTools === undefined)
    invalid("writeTools needs allowedTools to subtract from.");
  if (value.length > MAX_WRITE_TOOLS)
    invalid(`writeTools must have at most ${MAX_WRITE_TOOLS} entries.`);
  const allowed = new Set(allowedTools);
  return value.map((tool, index) => {
    if (typeof tool !== "string" || !TOOL_NAME.test(tool))
      invalid(
        `writeTools[${index}] must be 1-64 letters, digits, dots, hyphens or underscores.`,
      );
    if (!allowed.has(tool))
      invalid(`writeTools[${index}] "${tool}" must be one of allowedTools.`);
    return tool;
  });
}
export function parseConnectorSpec(input: unknown): ConnectorSpec {
  const raw = objectWith(input, SPEC_FIELDS, "The connector definition");

  if (typeof raw.slug !== "string" || !SLUG.test(raw.slug))
    invalid(
      "slug must be 2-31 characters: a lowercase letter then lowercase letters, digits or underscores.",
    );
  if (typeof raw.icon !== "string" || !ICON.test(raw.icon))
    invalid(
      "icon must be 1-64 lowercase letters, digits, hyphens or underscores.",
    );

  const spec: ConnectorSpec = {
    slug: raw.slug,
    displayName: cleanText(raw.displayName, "displayName", 60),
    description: cleanText(raw.description, "description", 500),
    icon: raw.icon,
    url: httpsUrl(raw.url, "url"),
    fixedHeaders: fixedHeadersOf(raw.fixedHeaders ?? {}),
    auth: authOf(raw.auth),
    toolTimeoutSec: integer(
      raw.toolTimeoutSec ?? DEFAULT_TOOL_TIMEOUT_SEC,
      "toolTimeoutSec",
      MIN_TOOL_TIMEOUT_SEC,
      MAX_TOOL_TIMEOUT_SEC,
    ),
    startupTimeoutSec: integer(
      raw.startupTimeoutSec ?? DEFAULT_STARTUP_TIMEOUT_SEC,
      "startupTimeoutSec",
      MIN_STARTUP_TIMEOUT_SEC,
      MAX_STARTUP_TIMEOUT_SEC,
    ),
    sortOrder: integer(raw.sortOrder ?? 100, "sortOrder", 0, 100_000),
  };
  const allowedTools = optional(raw.allowedTools, allowedToolsOf);
  if (allowedTools !== undefined) spec.allowedTools = allowedTools;
  const writeTools = optional(raw.writeTools, (v) =>
    writeToolsOf(v, allowedTools),
  );
  if (writeTools !== undefined) spec.writeTools = writeTools;
  const estimate = optional(raw.toolTokenEstimate, (v) =>
    integer(v, "toolTokenEstimate", 0, 10_000_000),
  );
  if (estimate !== undefined) spec.toolTokenEstimate = estimate;
  return spec;
}

export function connectorView(connector: ConnectorDoc): ConnectorView {
  const view: ConnectorView = {
    slug: connector.slug,
    displayName: connector.displayName,
    description: connector.description,
    icon: connector.icon,
    writeTools: connector.writeTools ?? [],
  };
  if (connector.toolTokenEstimate !== undefined)
    view.toolTokenEstimate = connector.toolTokenEstimate;
  if (connector.auth.adminHelp !== undefined)
    view.adminHelp = connector.auth.adminHelp;
  return view;
}
