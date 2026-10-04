import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export class EgressDenied extends Error {
  constructor() {
    super("Public web destination required");
  }
}
export type Resolver = (
  hostname: string,
) => Promise<{ address: string; family: number }[]>;
export const resolveAll: Resolver = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

/** Fail closed on reserved, transition, mapped and non-global IP space. */
export function isPublicAddress(address: string): boolean {
  try {
    if (address.includes("%")) return false;
    const parsed = ipaddr.parse(address);
    if (parsed.range() !== "unicast") return false;
    if (parsed.kind() === "ipv6") {
      const v6 = parsed as ipaddr.IPv6;
      return (
        !v6.isIPv4MappedAddress() && v6.match(ipaddr.IPv6.parse("2000::"), 3)
      );
    }
    return true;
  } catch {
    return false;
  }
}

export function publicUrl(value: unknown): URL {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\u0000-\u0020\u007f\\]/.test(value)
  )
    throw new EgressDenied();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EgressDenied();
  }
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (
    !host ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && Number(url.port) !== (url.protocol === "http:" ? 80 : 443))
  )
    throw new EgressDenied();
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new EgressDenied();
  } else if (
    host.length > 253 ||
    !host.includes(".") ||
    !host
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    /(?:^|\.)(localhost|local|internal|lan|home|corp|test|invalid|onion|arpa)$/.test(
      host,
    )
  ) {
    throw new EgressDenied();
  }
  if (!isIP(host)) url.hostname = host;
  url.hash = "";
  if (url.href.length > 2048) throw new EgressDenied();
  return url;
}

export async function vettedDestination(
  url: URL,
  resolver: Resolver = resolveAll,
) {
  // Validate again at every socket admission, including redirects/subresources.
  url = publicUrl(url.href);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolver(hostname);
  if (
    !addresses.length ||
    addresses.some(
      (a) =>
        !isPublicAddress(a.address) ||
        ![4, 6].includes(a.family) ||
        isIP(a.address) !== a.family,
    )
  )
    throw new EgressDenied();
  return {
    ...(addresses.find((a) => a.family === 4) ?? addresses[0]),
    port: url.protocol === "https:" ? 443 : 80,
  };
}
