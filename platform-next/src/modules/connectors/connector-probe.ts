import { createHash } from "node:crypto";
import { TOOL_NAME } from "./connector";
import { verifyConnection } from "./mcp-verify";
import { discoverEndpoints, type FetchLike } from "./oauth-discovery";

// What an operator learns about an MCP server before adding it to the
// catalog (`operator connector-probe`). It reports the server's OAuth
// discovery and the client registration modes it supports, and, given a test
// token, drafts the catalog's tool fields: allowedTools, suggested
// writeTools and the reviewed definition hashes the MCP gateway checks
// (mcp-gateway/src/policy.ts). It sends only initialize and tools/list,
// never a tools/call, and never prints the token.
//
// The draft is a suggestion. A tool counts as a write unless the server marks
// it readOnlyHint: true, and that hint is still only the server's claim: a
// person classifies every tool in a PR before connector-put.

export type RegistrationMode = "cimd" | "dcr" | "preregistered";

export interface ProbeOptions {
  readonly url: string;
  // Lists the tools when given. Never printed.
  readonly accessToken?: string;
  readonly fixedHeaders?: Record<string, string>;
  // From an existing definition: only these tools are drafted.
  readonly allowedTools?: readonly string[];
  readonly allowLoopback: boolean;
  readonly fetchImpl?: FetchLike;
}

export interface ProbeDiscovery {
  resource: string;
  // RFC 9728 §3.3: the metadata's resource must name the server it came
  // from. False means it names another server; check before trusting it.
  resourceMatchesUrl: boolean;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  userinfoEndpoint?: string;
  // Discovery refuses a server without it, so a report always says true.
  pkceS256: true;
  issParameterSupported: boolean;
  registrationEndpoint?: string;
}

export interface ToolDraft {
  allowedTools: string[];
  writeTools: string[];
  toolHashes: Record<string, string>;
}

export interface ProbeTools {
  // Every entry tools/list returned, across all pages.
  listed: number;
  draft: ToolDraft;
  // Drafted tools the server marks readOnlyHint: true (left out of
  // writeTools, still to be confirmed by a person).
  markedReadOnly: string[];
  // With an existing definition: allowed tools the server didn't list, and
  // listed tools the definition doesn't allow.
  missing?: string[];
  notAllowed?: string[];
  skipped: Array<{
    name: string;
    reason: "invalid_name" | "duplicate" | "unhashable";
  }>;
}

export interface ProbeReport {
  url: string;
  discovery: ProbeDiscovery;
  registration: {
    // In the order to use them for a new connector (MCP spec, client
    // registration: CIMD, then DCR; pre-registration always works).
    supported: RegistrationMode[];
    recommended: RegistrationMode;
  };
  tools?: ProbeTools;
  reminder: string;
}

export async function probeConnector(
  options: ProbeOptions,
): Promise<ProbeReport> {
  const fetchImpl = options.fetchImpl ? { fetchImpl: options.fetchImpl } : {};
  const endpoints = await discoverEndpoints({
    connectorUrl: options.url,
    allowLoopback: options.allowLoopback,
    ...fetchImpl,
  });
  const discovery: ProbeDiscovery = {
    resource: endpoints.resource,
    resourceMatchesUrl:
      endpoints.resource === options.url ||
      endpoints.resource === new URL(options.url).href,
    issuer: endpoints.issuer,
    authorizationEndpoint: endpoints.authorizationEndpoint,
    tokenEndpoint: endpoints.tokenEndpoint,
    ...(endpoints.revocationEndpoint
      ? { revocationEndpoint: endpoints.revocationEndpoint }
      : {}),
    ...(endpoints.userinfoEndpoint
      ? { userinfoEndpoint: endpoints.userinfoEndpoint }
      : {}),
    pkceS256: true,
    issParameterSupported: endpoints.issParameterSupported,
    ...(endpoints.registrationEndpoint
      ? { registrationEndpoint: endpoints.registrationEndpoint }
      : {}),
  };
  const supported: RegistrationMode[] = [];
  if (endpoints.clientIdMetadataDocumentSupported) supported.push("cimd");
  if (endpoints.registrationEndpoint) supported.push("dcr");
  supported.push("preregistered");

  let tools: ProbeTools | undefined;
  if (options.accessToken !== undefined) {
    const verified = await verifyConnection({
      url: options.url,
      accessToken: options.accessToken,
      fixedHeaders: options.fixedHeaders ?? {},
      listTools: true,
      ...fetchImpl,
    });
    tools = draftTools(verified.tools ?? [], options.allowedTools);
  }
  return {
    url: options.url,
    discovery,
    registration: { supported, recommended: supported[0]! },
    ...(tools ? { tools } : {}),
    reminder: reminderFor(discovery, supported, tools),
  };
}

// Names longer than this are cut in the report; they are invalid anyway.
const MAX_SHOWN_NAME = 100;

function draftTools(
  listed: readonly unknown[],
  allowed: readonly string[] | undefined,
): ProbeTools {
  const allowedSet = allowed ? new Set(allowed) : undefined;
  const seen = new Set<string>();
  const allowedTools: string[] = [];
  const writeTools: string[] = [];
  // Entries, not a plain object: a tool named "__proto__" must stay a key.
  const hashes: Array<[string, string]> = [];
  const markedReadOnly: string[] = [];
  const notAllowed: string[] = [];
  const skipped: ProbeTools["skipped"] = [];
  for (const tool of listed) {
    const record = isRecord(tool) ? tool : undefined;
    const name = record?.name;
    if (!record || typeof name !== "string" || !TOOL_NAME.test(name)) {
      skipped.push({
        name:
          typeof name === "string" ? name.slice(0, MAX_SHOWN_NAME) : "(none)",
        reason: "invalid_name",
      });
      continue;
    }
    if (seen.has(name)) {
      skipped.push({ name, reason: "duplicate" });
      continue;
    }
    seen.add(name);
    if (allowedSet && !allowedSet.has(name)) {
      notAllowed.push(name);
      continue;
    }
    let hash: string;
    try {
      hash = toolHash(record);
    } catch {
      skipped.push({ name, reason: "unhashable" });
      continue;
    }
    allowedTools.push(name);
    hashes.push([name, hash]);
    if (markedReadOnlyByServer(record)) markedReadOnly.push(name);
    else writeTools.push(name);
  }
  return {
    listed: listed.length,
    draft: {
      allowedTools,
      writeTools,
      toolHashes: Object.fromEntries(hashes),
    },
    markedReadOnly,
    ...(allowed
      ? { missing: allowed.filter((name) => !seen.has(name)), notAllowed }
      : {}),
    skipped,
  };
}

// Only the boolean true counts; "true", 1 or a missing hint is a write.
function markedReadOnlyByServer(tool: Record<string, unknown>): boolean {
  return isRecord(tool.annotations) && tool.annotations.readOnlyHint === true;
}

function reminderFor(
  discovery: ProbeDiscovery,
  supported: readonly RegistrationMode[],
  tools: ProbeTools | undefined,
): string {
  const lines: string[] = [];
  if (!discovery.resourceMatchesUrl)
    lines.push(
      "The protected-resource metadata names a different resource than this URL (RFC 9728). Check it before adding the connector.",
    );
  if (supported[0] !== "preregistered")
    lines.push(
      `The server supports ${supported[0] === "cimd" ? "CIMD" : "DCR"}; the catalog accepts only "registration": "preregistered" until that mode is built.`,
    );
  if (!tools)
    lines.push(
      "Run again with --token <file> holding a test account's access token to list the tools and draft allowedTools, writeTools and toolHashes.",
    );
  else
    lines.push(
      "A person must classify every tool before connector-put: confirm writeTools, add criticalTools (deletes, sends, sharing) and egress. A tool is suggested as a write unless the server marks it readOnlyHint: true, and readOnlyHint is the server's claim, never trusted on its own. Copy toolHashes as drafted: the gateway hides any tool whose live definition no longer matches.",
    );
  return lines.join(" ");
}

// The reviewed form of an MCP tool and its hash. This MUST stay identical to
// mcp-gateway/src/tool-hash.ts, which checks these hashes on every
// tools/list; platform-next builds only from its own sources, so the code is
// repeated, and the same pinned vector in both packages' tests keeps them
// equal. sha256 (hex) over the JSON of the reviewed fields, object keys
// sorted at every level, arrays in order.
const REVIEWED_FIELDS = [
  "name",
  "title",
  "description",
  "inputSchema",
  "outputSchema",
  "annotations",
] as const;
const MAX_DEPTH = 64;

export function reviewedDefinition(
  tool: Record<string, unknown>,
): Record<string, unknown> {
  const reviewed: Record<string, unknown> = {};
  for (const field of REVIEWED_FIELDS)
    if (tool[field] !== undefined) reviewed[field] = tool[field];
  return reviewed;
}

// Throws on a value deeper than MAX_DEPTH; the probe skips that tool.
export function toolHash(tool: Record<string, unknown>): string {
  return createHash("sha256")
    .update(canonicalJson(reviewedDefinition(tool), 0))
    .digest("hex");
}

function canonicalJson(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new Error("Tool definition nests too deeply.");
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
