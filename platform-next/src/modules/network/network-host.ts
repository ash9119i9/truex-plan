import { invalid } from "../../common/validation";

// Host names a sandbox command may be allowed to reach: connector egress
// hosts, the tenant admin allowlist and the baseline registries. Exact DNS
// names only. The pin's proxy lets an allowlisted IP literal through even
// when it is private (P0 probe: 169.254.169.254), so literals, wildcards and
// names that are private by definition are refused here, before they can
// reach a run. A public name that resolves to a private address is refused by
// the proxy at connect time.

export const MAX_HOST_LENGTH = 253;

// Lowercase labels of letters, digits and hyphens, not starting or ending
// with a hyphen; punycode (xn--) passes.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// A top-level label is alphabetic (or punycode), which also rules out every
// dotted IPv4 form.
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

// Suffixes that only ever name private, local or special-use addresses
// (RFC 6761, RFC 6762, RFC 8375, common internal zones, cloud metadata).
const PRIVATE_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "lan",
  "home",
  "corp",
  "home.arpa",
  "arpa",
  "test",
  "invalid",
  "example",
  "onion",
];

// Returns the host lowercased, or refuses it naming `field`. Never echoes the
// value: a rejected host may be an internal name.
export function egressHost(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    invalid(`${field} must be a host name.`);
  const host = value.toLowerCase();
  if (host.length > MAX_HOST_LENGTH)
    invalid(`${field} must be at most ${MAX_HOST_LENGTH} characters.`);
  if (host.includes("*"))
    invalid(`${field} must be an exact host name, without wildcards.`);
  if (host.includes(":") || host.startsWith("["))
    invalid(`${field} must be a host name, not an address or a host:port.`);
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label)))
    invalid(
      `${field} must be a host name such as api.example.com (letters, digits, hyphens and dots).`,
    );
  if (!TLD.test(labels[labels.length - 1]!))
    invalid(`${field} must be a host name, not an IP address.`);
  if (
    PRIVATE_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    )
  )
    invalid(`${field} names a private or local network host.`);
  return host;
}

// A list of hosts: each checked, duplicates refused (a duplicate is almost
// always a typo for another host).
export function egressHosts(
  value: unknown,
  field: string,
  max: number,
  min = 0,
): string[] {
  if (!Array.isArray(value)) invalid(`${field} must be an array of hosts.`);
  if (value.length < min || value.length > max)
    invalid(
      min > 0
        ? `${field} must have ${min}-${max} hosts.`
        : `${field} must have at most ${max} hosts.`,
    );
  const hosts = value.map((host, index) =>
    egressHost(host, `${field}[${index}]`),
  );
  if (new Set(hosts).size !== hosts.length)
    invalid(`${field} lists a host twice.`);
  return hosts;
}
