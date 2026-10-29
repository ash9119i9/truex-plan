import type { Db, ObjectId } from "mongodb";
import {
  RefreshRefusedError,
  type RefreshRequest,
  type TokenGrant,
} from "./credentials";
import { EgressBlockedError, type Egress, type EgressInit } from "./egress";

// The provider call behind a refresh: find the connector's token endpoint and
// trade the refresh token for a new grant, naming the MCP server it is for
// (RFC 8707 resource) unless the connector opted out (sendResource: false). Both halves are platform-next's
// (oauth-discovery.ts discoverEndpoints, oauth-exchange.ts refreshGrant), so
// the two services refresh identically until the gateway is the only one
// that does (tasks/mcp-gateway-todo.md, Task 34). Only what a refresh needs
// is discovered: the token endpoint and the resource it serves.
//
// A refusal (invalid_grant, or GitHub's error in a 200 body) is
// RefreshRefusedError, so the member signs in again. Everything else is
// RefreshUnavailableError: nothing changed at the provider, so the stored
// tokens are still the right ones. Provider text and secrets never reach an
// error message.

const CONNECTORS = "truex_mcp_connectors";
const REQUEST_TIMEOUT_MS = 5_000;
const TOKEN_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
// Discovery and the client secret must be ready within this, so that with
// the token request the whole refresh fits in the 30 s refresh lease
// (credentials.ts). A holder that overran its lease would spend a rotating
// refresh token without being able to store the new one.
const PREPARE_BUDGET_MS = 15_000;
const DISCOVERY_TTL_MS = 10 * 60_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type ClientSecretRef = { arn: string } | { env: string };

// The catalog fields a refresh reads (platform-next connector.ts).
export interface ConnectorRecord {
  _id: ObjectId;
  url: string;
  revision: number;
  auth: {
    clientId: string;
    clientSecret: ClientSecretRef;
    sendResource?: boolean;
  };
}

export interface RefreshGrantOptions {
  readonly findConnector: (id: ObjectId) => Promise<ConnectorRecord | null>;
  readonly resolveSecret: (ref: ClientSecretRef) => Promise<string>;
  // Every provider request goes through it (egress.ts). Its allowLoopback
  // also lets discovery accept loopback http endpoints, for fixtures.
  readonly egress: Egress;
}

// A fixed reason code, safe to log.
export class RefreshUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`The connector token could not be renewed (${reason}).`);
    this.name = "RefreshUnavailableError";
  }
}

interface Discovered {
  readonly resource: string;
  readonly tokenEndpoint: string;
}

// Enabled connectors only: a refresh for a connector the product team
// disabled is an outage, not a refusal.
export function connectorsIn(
  catalog: Db,
): (id: ObjectId) => Promise<ConnectorRecord | null> {
  const collection = catalog.collection<ConnectorRecord>(CONNECTORS);
  return (id) =>
    collection.findOne(
      { _id: id, enabled: true },
      {
        projection: {
          url: 1,
          revision: 1,
          "auth.clientId": 1,
          "auth.clientSecret": 1,
          "auth.sendResource": 1,
        },
      },
    );
}

export function createRefreshGrant(
  options: RefreshGrantOptions,
): (request: RefreshRequest) => Promise<TokenGrant> {
  // One entry per connector revision; a failed discovery is dropped so the
  // next refresh tries again.
  const discovered = new Map<
    string,
    { readonly value: Promise<Discovered>; readonly expires: number }
  >();

  function discover(connector: ConnectorRecord): Promise<Discovered> {
    const key = `${connector._id.toHexString()}:${connector.revision}`;
    const hit = discovered.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = discoverTokenEndpoint(connector.url, options.egress);
    discovered.set(key, { value, expires: Date.now() + DISCOVERY_TTL_MS });
    value.catch(() => {
      if (discovered.get(key)?.value === value) discovered.delete(key);
    });
    return value;
  }

  return async (request) => {
    const connector = await options.findConnector(request.connectorId);
    if (!connector || typeof connector.url !== "string" || !connector.auth)
      throw new RefreshUnavailableError("connector");
    const [endpoints, clientSecret] = await withinBudget(
      Promise.all([
        discover(connector),
        options.resolveSecret(connector.auth.clientSecret).catch(() => {
          throw new RefreshUnavailableError("client_secret");
        }),
      ]),
    );
    return tokenRequest(options.egress, endpoints.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: request.refreshToken,
      client_id: connector.auth.clientId,
      client_secret: clientSecret,
      ...(connector.auth.sendResource === false
        ? {}
        : { resource: endpoints.resource }),
    });
  };
}

async function withinBudget<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RefreshUnavailableError("prepare_timeout")),
      PREPARE_BUDGET_MS,
    );
  });
  try {
    return await Promise.race([work, budget]);
  } finally {
    clearTimeout(timer);
  }
}

// RFC 9728 protected-resource metadata (from the 401's resource_metadata, or
// the well-known URL), then RFC 8414 authorization-server metadata.
async function discoverTokenEndpoint(
  connectorUrl: string,
  egress: Egress,
): Promise<Discovered> {
  const allowLoopback = egress.allowLoopback;
  const mcp = safeUrl(connectorUrl, allowLoopback);
  const probe = await request(egress, mcp.href, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "truex", version: "1" },
      },
    }),
  });
  if (probe.status >= 500) throw new RefreshUnavailableError("discovery");
  const headerUrl =
    probe.status === 401
      ? /resource_metadata\s*=\s*"([^"]+)"/i.exec(
          probe.headers.get("www-authenticate") ?? "",
        )?.[1]
      : undefined;
  const prm = await firstJson(
    headerUrl ? [headerUrl] : wellKnown(mcp, "oauth-protected-resource"),
    egress,
  );
  const servers = prm.authorization_servers;
  if (!Array.isArray(servers) || servers.length === 0)
    throw new RefreshUnavailableError("discovery");
  const issuer = safeUrl(servers[0], allowLoopback);
  const as = await firstJson(
    wellKnown(issuer, "oauth-authorization-server"),
    egress,
  );
  // Sent to the authorization server, so it must be a safe absolute URL
  // without a fragment, kept as spelled (platform-next oauth-discovery.ts).
  let resource = mcp.href;
  if (prm.resource !== undefined) {
    safeUrl(prm.resource, allowLoopback);
    resource = prm.resource as string;
    if (resource.includes("#")) throw new RefreshUnavailableError("discovery");
  }
  return {
    resource,
    tokenEndpoint: safeUrl(as.token_endpoint, allowLoopback).href,
  };
}

// The well-known URL with the path inserted after it, then without the path.
function wellKnown(url: URL, name: string): string[] {
  const path = url.pathname.replace(/\/+$/, "");
  const base = `${url.origin}/.well-known/${name}`;
  return path && path !== "/" ? [`${base}${path}`, base] : [base];
}

async function firstJson(
  urls: readonly string[],
  egress: Egress,
): Promise<Record<string, unknown>> {
  for (const candidate of urls) {
    const url = safeUrl(candidate, egress.allowLoopback);
    try {
      const result = await request(egress, url.href, {
        method: "GET",
        headers: { accept: "application/json" },
      });
      const body = parseJson(result.text);
      if (result.status === 200 && body) return body;
    } catch (error) {
      if (!(error instanceof RefreshUnavailableError)) throw error;
    }
  }
  throw new RefreshUnavailableError("discovery");
}

function safeUrl(value: unknown, allowLoopback: boolean): URL {
  if (typeof value !== "string" || value.length > 2048)
    throw new RefreshUnavailableError("discovery");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RefreshUnavailableError("discovery");
  }
  const loopback =
    allowLoopback &&
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.has(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !loopback))
    throw new RefreshUnavailableError("discovery");
  return url;
}

// The timeout covers the body too. A redirect is never followed, and a body
// past MAX_RESPONSE_BYTES is cut off unread.
async function request(
  egress: Egress,
  url: string,
  init: EgressInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ status: number; headers: Headers; text: string }> {
  let res: Response;
  let text: string | null;
  try {
    res = await egress.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      throw new RefreshUnavailableError("redirect");
    }
    text = await readLimited(res, MAX_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof RefreshUnavailableError) throw error;
    throw new RefreshUnavailableError(
      error instanceof EgressBlockedError ? "egress_blocked" : "unreachable",
    );
  }
  if (text === null) throw new RefreshUnavailableError("oversized");
  return { status: res.status, headers: res.headers, text };
}

async function readLimited(
  res: Response,
  limit: number,
): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function tokenRequest(
  egress: Egress,
  tokenEndpoint: string,
  form: Record<string, string>,
): Promise<TokenGrant> {
  const res = await request(
    egress,
    tokenEndpoint,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
    },
    TOKEN_TIMEOUT_MS,
  );
  if (res.status >= 500) throw new RefreshUnavailableError("token_endpoint");
  const body = tokenBody(res.headers.get("content-type"), res.text);
  // GitHub can report an error with HTTP 200.
  if (res.status !== 200 || body.error || !body.access_token)
    throw new RefreshRefusedError();
  const grant: TokenGrant = { tokens: { accessToken: body.access_token } };
  if (body.refresh_token) grant.tokens.refreshToken = body.refresh_token;
  const access = seconds(body.expires_in);
  if (access !== undefined) grant.accessExpiresInSec = access;
  const refresh = seconds(body.refresh_token_expires_in);
  if (refresh !== undefined) grant.refreshExpiresInSec = refresh;
  return grant;
}

// JSON, or form-encoded (GitHub without Accept honoured).
function tokenBody(
  contentType: string | null,
  text: string,
): Record<string, string> {
  if (contentType?.includes("application/json")) {
    const value = parseJson(text);
    if (value) {
      const out: Record<string, string> = {};
      for (const [key, raw] of Object.entries(value))
        if (typeof raw === "string") out[key] = raw;
        else if (typeof raw === "number" && Number.isFinite(raw))
          out[key] = String(raw);
      return out;
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function seconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,10}$/.test(value)) return undefined;
  const n = Number(value);
  return n > 0 ? n : undefined;
}
