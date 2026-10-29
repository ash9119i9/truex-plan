// Discovers a connector's OAuth endpoints from its MCP server URL, with no
// provider URL hard-coded in code (RFC 9728 protected-resource metadata → RFC
// 8414 authorization-server metadata). Every discovered endpoint must be https
// unless loopback is allowed (tests/local dev). Responses are size- and
// time-bounded. The result is cached in memory per connector revision.

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// The authorization-server details the connect and callback flows need.
export interface DiscoveredEndpoints {
  // The protected-resource (the MCP server) identifier.
  resource: string;
  // The authorization-server issuer, checked against the callback's iss.
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  // The OpenID Connect userinfo endpoint, when the AS advertises one. Used to
  // name the connected account for servers with no "who am I" tool.
  userinfoEndpoint?: string;
  // Whether the AS requires iss on the redirect (RFC 9207). When true, a
  // callback without iss is refused.
  issParameterSupported: boolean;
  // Client registration the AS advertises (MCP spec, client registration).
  // Reported by the connector probe; connect uses pre-registered apps only.
  // An unsafe registration_endpoint is left out rather than failing.
  registrationEndpoint?: string;
  clientIdMetadataDocumentSupported?: true;
}

// Discovery could not complete: the server did not advertise metadata the way
// the spec requires, or a discovered endpoint was not https. A fixed reason;
// no provider text is carried into it.
export class DiscoveryError extends Error {
  constructor(reason: string) {
    super(`connector discovery failed: ${reason}`);
    this.name = "DiscoveryError";
  }
}

// The discovered server could not be reached in time or answered with 5xx.
export class DiscoveryUnavailableError extends Error {
  constructor() {
    super("the connector's server could not be reached");
    this.name = "DiscoveryUnavailableError";
  }
}

interface HttpResult {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
}

// Lets tests inject a fetch stub; defaults to global fetch.
export type FetchLike = typeof fetch;

function isHttps(url: URL, allowLoopback: boolean): boolean {
  if (url.protocol === "https:") return true;
  return (
    allowLoopback &&
    url.protocol === "http:" &&
    LOOPBACK_HOSTS.has(url.hostname)
  );
}

// Requires an absolute URL that is https (or loopback http when allowed), with
// no credentials. Returns the parsed URL or throws DiscoveryError.
function requireSafeUrl(
  value: unknown,
  field: string,
  allowLoopback: boolean,
): URL {
  if (typeof value !== "string" || value.length > 2048)
    throw new DiscoveryError(`${field} is not a URL`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DiscoveryError(`${field} is not a URL`);
  }
  if (url.username || url.password)
    throw new DiscoveryError(`${field} carries credentials`);
  if (!isHttps(url, allowLoopback))
    throw new DiscoveryError(`${field} is not https`);
  return url;
}

async function request(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<HttpResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new DiscoveryUnavailableError();
  }
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_RESPONSE_BYTES)
    throw new DiscoveryUnavailableError();
  const text = Buffer.from(bytes).toString("utf8");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, headers: res.headers, body, text };
}

// Parses the resource_metadata URL out of a WWW-Authenticate header. The
// header is a comma-separated parameter list; we read resource_metadata only.
function resourceMetadataUrl(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /resource_metadata\s*=\s*"([^"]+)"/i.exec(header);
  return match?.[1];
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Builds the RFC 8414 authorization-server metadata URL for an issuer with a
// path component: the well-known segment is inserted after the origin, before
// the path (e.g. https://host/login/oauth →
// https://host/.well-known/oauth-authorization-server/login/oauth).
function asMetadataUrls(issuer: URL): string[] {
  const path = issuer.pathname.replace(/\/+$/, "");
  const base = `${issuer.origin}/.well-known/oauth-authorization-server`;
  if (path && path !== "/")
    return [
      `${base}${path}`,
      `${issuer.origin}/.well-known/oauth-authorization-server`,
    ];
  return [`${issuer.origin}/.well-known/oauth-authorization-server`];
}

// RFC 9728 fallback: the protected-resource metadata URL from the resource URL
// when the 401 did not carry resource_metadata.
function protectedResourceUrls(resource: URL): string[] {
  const path = resource.pathname.replace(/\/+$/, "");
  const base = `${resource.origin}/.well-known/oauth-protected-resource`;
  if (path && path !== "/")
    return [
      `${base}${path}`,
      `${resource.origin}/.well-known/oauth-protected-resource`,
    ];
  return [`${resource.origin}/.well-known/oauth-protected-resource`];
}

export interface DiscoverOptions {
  connectorUrl: string;
  allowLoopback: boolean;
  fetchImpl?: FetchLike;
}

// Runs the full discovery chain and returns the authorization-server details.
export async function discoverEndpoints(
  options: DiscoverOptions,
): Promise<DiscoveredEndpoints> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const allowLoopback = options.allowLoopback;
  const connectorUrl = requireSafeUrl(
    options.connectorUrl,
    "connector url",
    allowLoopback,
  );

  // 1. Unauthenticated MCP initialize, usually a 401 with WWW-Authenticate.
  const probe = await request(fetchImpl, connectorUrl.href, {
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
  if (probe.status >= 500) throw new DiscoveryUnavailableError();

  // 2. Protected-resource metadata: from the 401's header, else the RFC 9728
  //    well-known fallback. Some servers (Google's Gmail MCP) answer
  //    initialize and tools/list without a token and only require one on
  //    tools/call, so a non-401 probe also falls back to the well-known URL.
  const headerUrl =
    probe.status === 401
      ? resourceMetadataUrl(probe.headers.get("www-authenticate"))
      : undefined;
  const candidates = headerUrl
    ? [headerUrl]
    : protectedResourceUrls(connectorUrl);
  const prm = await fetchFirst(fetchImpl, candidates, allowLoopback);
  const resourceMeta = asObject(prm.body);
  if (!resourceMeta)
    throw new DiscoveryError("protected-resource metadata is not an object");

  const servers = resourceMeta.authorization_servers;
  if (!Array.isArray(servers) || servers.length === 0)
    throw new DiscoveryError("no authorization_servers advertised");
  const issuerUrl = requireSafeUrl(
    servers[0],
    "authorization server",
    allowLoopback,
  );
  // RFC 8707 resource, sent to the authorization server on every authorize
  // and token request, so a value the metadata names must be a safe absolute
  // URL without a fragment. Kept exactly as spelled (like the issuer): URL
  // normalisation could add a trailing slash the server never named.
  let resource = connectorUrl.href;
  if (resourceMeta.resource !== undefined) {
    requireSafeUrl(resourceMeta.resource, "resource", allowLoopback);
    resource = resourceMeta.resource as string;
    // URL.hash is empty for a bare "#", so the text is checked.
    if (resource.includes("#"))
      throw new DiscoveryError("resource has a fragment");
  }

  // 3. RFC 8414 authorization-server metadata, with path insertion.
  const asMeta = asObject(
    (await fetchFirst(fetchImpl, asMetadataUrls(issuerUrl), allowLoopback))
      .body,
  );
  if (!asMeta)
    throw new DiscoveryError("authorization-server metadata is not an object");

  // 4. PKCE S256 must be advertised.
  const pkce = asMeta.code_challenge_methods_supported;
  if (!Array.isArray(pkce) || !pkce.includes("S256"))
    throw new DiscoveryError(
      "the authorization server does not support PKCE S256",
    );

  // The issuer is kept exactly as the metadata spells it: RFC 9207 compares
  // the callback's iss to it by simple string comparison, and URL
  // normalisation would add a trailing slash (https://accounts.google.com →
  // https://accounts.google.com/) that the provider never sends.
  requireSafeUrl(asMeta.issuer, "issuer", allowLoopback);
  const issuer = asMeta.issuer as string;
  const authorizationEndpoint = requireSafeUrl(
    asMeta.authorization_endpoint,
    "authorization_endpoint",
    allowLoopback,
  ).href;
  const tokenEndpoint = requireSafeUrl(
    asMeta.token_endpoint,
    "token_endpoint",
    allowLoopback,
  ).href;
  const endpoints: DiscoveredEndpoints = {
    resource,
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    issParameterSupported:
      asMeta.authorization_response_iss_parameter_supported === true,
  };
  if (asMeta.revocation_endpoint !== undefined)
    endpoints.revocationEndpoint = requireSafeUrl(
      asMeta.revocation_endpoint,
      "revocation_endpoint",
      allowLoopback,
    ).href;
  if (asMeta.userinfo_endpoint !== undefined)
    endpoints.userinfoEndpoint = requireSafeUrl(
      asMeta.userinfo_endpoint,
      "userinfo_endpoint",
      allowLoopback,
    ).href;
  if (asMeta.registration_endpoint !== undefined)
    try {
      endpoints.registrationEndpoint = requireSafeUrl(
        asMeta.registration_endpoint,
        "registration_endpoint",
        allowLoopback,
      ).href;
    } catch (error) {
      // Nothing registers yet, so an unsafe endpoint is just not offered.
      if (!(error instanceof DiscoveryError)) throw error;
    }
  if (asMeta.client_id_metadata_document_supported === true)
    endpoints.clientIdMetadataDocumentSupported = true;
  return endpoints;
}

// Fetches the first URL that returns a usable JSON body. Each candidate URL is
// re-checked for https before the request.
async function fetchFirst(
  fetchImpl: FetchLike,
  urls: string[],
  allowLoopback: boolean,
): Promise<HttpResult> {
  let lastError: unknown;
  for (const candidate of urls) {
    const url = requireSafeUrl(candidate, "metadata url", allowLoopback);
    try {
      const result = await request(fetchImpl, url.href, {
        method: "GET",
        headers: { accept: "application/json" },
      });
      if (result.status === 200 && asObject(result.body)) return result;
      lastError = new DiscoveryError("metadata request did not return JSON");
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof DiscoveryError) throw lastError;
  throw new DiscoveryUnavailableError();
}
