import { lookup as dnsLookup } from "node:dns/promises";
import {
  Agent as HttpAgent,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

// Every request the gateway sends to a provider goes through here: the MCP
// server itself, and OAuth discovery and token refresh. The gateway resolves
// the host itself, refuses any non-public address, and then connects to the
// exact address it checked, so a DNS answer that changes between the check
// and the connection (rebinding) can't move the request somewhere else. The
// original host is kept for the Host header and TLS (SNI and certificate
// checks).
//
// Redirects are never followed: a 3xx is returned to the caller as is.
// Plain http and loopback addresses are allowed only with `allowLoopback`,
// for fixture servers in tests and local dev (config.ts keeps it out of
// production).

// Addresses that aren't the public internet. IPv4-mapped IPv6 addresses are
// checked against the IPv4 ranges by BlockList itself.
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  BLOCKED.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  BLOCKED.addSubnet(network, prefix, "ipv6");

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface EgressOptions {
  readonly allowLoopback?: boolean;
  // Every address a host resolves to. Tests replace it.
  readonly resolve?: (host: string) => Promise<ResolvedAddress[]>;
}

export interface EgressInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

// The request was refused before any connection was made. A fixed reason,
// safe to log.
export class EgressBlockedError extends Error {
  constructor(readonly reason: string) {
    super(`The Truex gateway doesn't connect there (${reason}).`);
    this.name = "EgressBlockedError";
  }
}

export interface Egress {
  readonly allowLoopback: boolean;
  fetch(url: string, init?: EgressInit): Promise<Response>;
}

export function isBlockedAddress(address: string): boolean {
  return matches(BLOCKED, address) ?? true;
}

function isLoopback(address: string): boolean {
  return matches(LOOPBACK, address) ?? false;
}

// undefined when `address` isn't an IP address at all.
function matches(list: BlockList, address: string): boolean | undefined {
  // A zone ID (fe80::1%en0) names an interface, not part of the address.
  const zone = address.indexOf("%");
  const ip = zone < 0 ? address : address.slice(0, zone);
  const family = isIP(ip);
  if (family === 0) return undefined;
  return list.check(ip, family === 4 ? "ipv4" : "ipv6");
}

async function systemResolve(host: string): Promise<ResolvedAddress[]> {
  const answers = await dnsLookup(host, { all: true });
  return answers.map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));
}

export function createEgress(options: EgressOptions = {}): Egress {
  const allowLoopback = options.allowLoopback ?? false;
  const resolve = options.resolve ?? systemResolve;
  // Kept-alive connections save a TLS handshake per tool call. A pooled
  // connection only ever goes to an address that was checked when it opened.
  const agents = {
    http: new HttpAgent({ keepAlive: true }),
    https: new HttpsAgent({ keepAlive: true }),
  };

  async function egressFetch(
    target: string,
    init: EgressInit = {},
  ): Promise<Response> {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new EgressBlockedError("not_a_url");
    }
    if (url.username || url.password)
      throw new EgressBlockedError("credentials");
    const plain = url.protocol === "http:";
    if (url.protocol !== "https:" && !(plain && allowLoopback))
      throw new EgressBlockedError("scheme");
    const host = url.hostname.startsWith("[")
      ? url.hostname.slice(1, -1)
      : url.hostname;
    const literal = isIP(host);
    const addresses: ResolvedAddress[] =
      literal !== 0
        ? [{ address: host, family: literal === 6 ? 6 : 4 }]
        : await resolve(host);
    if (addresses.length === 0) throw new Error(`${host} has no address.`);
    for (const { address } of addresses) {
      const loopback = isLoopback(address);
      // http only ever reaches a local fixture.
      if (plain && !loopback) throw new EgressBlockedError("http_not_loopback");
      if (isBlockedAddress(address) && !(allowLoopback && loopback))
        throw new EgressBlockedError("address");
    }
    return send(url, host, plain, addresses[0]!, init);
  }

  function send(
    url: URL,
    host: string,
    plain: boolean,
    checked: ResolvedAddress,
    init: EgressInit,
  ): Promise<Response> {
    // Connects to the checked address whatever DNS says now.
    const lookup: LookupFunction = (_name, lookupOptions, callback) => {
      if (lookupOptions.all)
        callback(null, [{ address: checked.address, family: checked.family }]);
      else callback(null, checked.address, checked.family);
    };
    // Without this the provider may compress, and nothing here decodes.
    const headers: Record<string, string> = {
      "accept-encoding": "identity",
      ...init.headers,
    };
    if (init.body !== undefined)
      headers["content-length"] = String(Buffer.byteLength(init.body));
    const requestOptions: RequestOptions = {
      protocol: url.protocol,
      hostname: host,
      ...(url.port ? { port: Number(url.port) } : {}),
      path: `${url.pathname}${url.search}`,
      method: init.method ?? "GET",
      headers,
      lookup,
      agent: plain ? agents.http : agents.https,
      ...(init.signal ? { signal: init.signal } : {}),
    };
    return new Promise<Response>((resolveResponse, reject) => {
      const req = (plain ? httpRequest : httpsRequest)(
        requestOptions,
        (res) => {
          try {
            resolveResponse(toResponse(res, requestOptions.method!));
          } catch (error) {
            res.destroy();
            reject(error);
          }
        },
      );
      req.on("error", reject);
      req.end(init.body);
    });
  }

  return { allowLoopback, fetch: egressFetch };
}

// Throws on a status a Response can't carry; the caller treats it as an
// unreachable server.
function toResponse(res: IncomingMessage, method: string): Response {
  const status = res.statusCode ?? 0;
  if (status < 200 || status > 599)
    throw new Error(`Unexpected status ${status}.`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value])
      headers.append(name, item);
  }
  const empty =
    method === "HEAD" || status === 204 || status === 205 || status === 304;
  if (empty) res.resume();
  const body = empty
    ? null
    : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
  return new Response(body, {
    status,
    statusText: res.statusMessage ?? "",
    headers,
  });
}
