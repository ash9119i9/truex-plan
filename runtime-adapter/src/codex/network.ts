import { randomBytes } from "node:crypto";
import type {
  NetworkConnector,
  NetworkMethod,
  NetworkPolicy,
  NetworkRule,
} from "../contract";
import { networkHost } from "../contract";
import type { BlockedRequest } from "./rpc";

// The sandbox network for a coding run: the platform's policy (contract.ts
// NetworkPolicy) turned into the pin's network proxy settings. Verified on
// the pin (test/codex/network.test.ts; findings in tasks/coding-agent-todo.md
// P0):
//
// - Every host in the policy is an allowlist entry; anything else is refused
//   by the proxy, and so is any name that resolves to a private, loopback or
//   link-local address. Metadata addresses also get explicit deny entries,
//   because an allowlisted IP literal would otherwise pass.
// - A connector's hosts are inspected (MITM): a host with hooks admits only
//   requests that match one, so the connector's `reads` become hooks and
//   every other request is refused. A host no read rule covers gets one hook
//   that nothing sends, so it is inspected (and refused) too.
// - A connector's token is a credential-broker provider: commands see a
//   stand-in in TRUEX_TOKEN_<NAME>, and the proxy puts the real token in only
//   for URLs under the connector's prefixes.
//
// The proxy cannot ask before it sends, so a refused request becomes a
// `network.blocked` event (`classifyBlock`) and the member's answer applies
// from the next reply.

export interface NetworkSettings {
  // `features.*` keys for the thread config.
  readonly features: Record<string, unknown>;
  // The permissions profile's `network` table.
  readonly profile: Record<string, unknown>;
  // Command environment: the token variables and git's credential helper.
  // Holds real tokens; only ever passed to Codex in thread params.
  readonly env: Record<string, string>;
}

// Addresses that answer instance-credential requests. The proxy refuses
// them by name resolution anyway; the deny entries keep them refused even if
// one ends up on an allowlist.
export const METADATA_DENY = [
  "169.254.169.254",
  "169.254.170.2",
  "metadata.google.internal",
] as const;

// git sends a username with Basic auth; the broker swaps only the password.
// "x-access-token" is what GitHub documents for token use and other hosts
// ignore the name.
const GIT_USERNAME = "x-access-token";

export function tokenVariable(connector: string): string {
  return `TRUEX_TOKEN_${connector.toUpperCase()}`;
}

export function networkSettings(
  policy: NetworkPolicy,
  options: { readonly upstreamProxy?: boolean } = {},
): NetworkSettings {
  const domains: Record<string, string> = {};
  for (const host of policy.hosts) domains[host] = "allow";
  for (const connector of policy.connectors)
    for (const host of connector.hosts) domains[host] = "allow";
  for (const host of METADATA_DENY) domains[host] = "deny";

  // Unknown methods never come from a command that does not know the run's
  // nonce, which lives only in the thread config.
  const never = `TRUEX-NONE-${randomBytes(8).toString("hex").toUpperCase()}`;
  const hooks: Record<string, unknown> = {};
  for (const connector of policy.connectors) {
    const covered = new Set<string>();
    connector.reads.forEach((rule, index) => {
      for (const host of rule.hosts ?? connector.hosts) {
        covered.add(host);
        hooks[`${connector.name}_${index}_${hostKey(host)}`] = {
          host,
          methods: [...rule.methods],
          path_prefixes: (rule.paths ?? ["/"]).map(pathMatcher),
          action: ["pass"],
        };
      }
    });
    for (const host of connector.hosts)
      if (!covered.has(host))
        hooks[`${connector.name}_none_${hostKey(host)}`] = {
          host,
          methods: [never],
          path_prefixes: ["/"],
          action: ["pass"],
        };
  }

  const credentials: Record<string, unknown> = {};
  const env: Record<string, string> = {};
  const gitHelpers: Array<[string, string]> = [];
  for (const connector of policy.connectors) {
    const credential = connector.credential;
    if (!credential) continue;
    const variable = tokenVariable(connector.name);
    credentials[connector.name] = {
      env: [variable],
      patterns: [credential.tokenPattern],
      url_prefixes: [...credential.urlPrefixes],
      auth: [...credential.auth],
    };
    env[variable] = credential.token;
    if (credential.auth.includes("basic"))
      for (const prefix of credential.urlPrefixes)
        gitHelpers.push([
          `credential.${prefix.replace(/\/$/, "")}.helper`,
          `!f() { echo username=${GIT_USERNAME}; echo "password=$${variable}"; }; f`,
        ]);
  }
  if (gitHelpers.length > 0) {
    env.GIT_CONFIG_COUNT = String(gitHelpers.length);
    gitHelpers.forEach(([key, value], index) => {
      env[`GIT_CONFIG_KEY_${index}`] = key;
      env[`GIT_CONFIG_VALUE_${index}`] = value;
    });
  }
  // A refused request must fail, not wait for a password.
  env.GIT_TERMINAL_PROMPT = "0";

  const hasCredentials = Object.keys(credentials).length > 0;
  return {
    features: {
      "features.network_proxy": {
        enabled: true,
        ...(hasCredentials ? { credentials } : {}),
      },
      ...(hasCredentials ? { "features.credential_masking": true } : {}),
    },
    profile: {
      enabled: true,
      mode: "full",
      allow_local_binding: false,
      ...(options.upstreamProxy ? { allow_upstream_proxy: true } : {}),
      domains,
      ...(Object.keys(hooks).length > 0
        ? {
            mitm: {
              hooks,
              // A hook must name an action; this one changes nothing.
              actions: { pass: { strip_request_headers: ["x-truex-none"] } },
            },
          }
        : {}),
    },
    env,
  };
}

// Path rules are prefixes, or globs where they contain `*`.
function pathMatcher(path: string): string {
  return path.includes("*") ? `pattern:${path}` : path;
}

function hostKey(host: string): string {
  return host.replace(/[^a-z0-9]/g, "_");
}

// What a refused request means for the member, as the card shows it.
//   unlisted   a site not in the policy; may be allowed once or for the chat
//   write      a connector request outside its reads; critical ones only once
//   read_only  a write to a connection the agent may only read; never allowed
//   refused    a private address, a denied name or anything else
export type BlockKind = "unlisted" | "write" | "read_only" | "refused";
export type BlockGrant = "chat" | "once" | "none";

export interface NetworkBlock {
  readonly host: string;
  // CONNECT for a site that was refused before any request was seen.
  readonly method: string;
  readonly kind: BlockKind;
  readonly connector?: {
    readonly name: string;
    readonly displayName: string;
    readonly account?: string;
  };
  readonly critical: boolean;
  // The widest answer the card may offer.
  readonly grant: BlockGrant;
}

export function classifyBlock(
  policy: NetworkPolicy,
  blocked: BlockedRequest,
): NetworkBlock {
  const host = blocked.host;
  const method = blocked.method ?? "CONNECT";
  const connector = policy.connectors.find((c) => c.hosts.includes(host));
  if (connector && blocked.reason === "mitm_hook_denied") {
    const named = {
      name: connector.name,
      displayName: connector.displayName,
      ...(connector.account ? { account: connector.account } : {}),
    };
    if (connector.access === "read_only")
      return {
        host,
        method,
        kind: "read_only",
        connector: named,
        critical: false,
        grant: "none",
      };
    const critical = isCritical(connector, host, method);
    return {
      host,
      method,
      kind: "write",
      connector: named,
      critical,
      grant: critical ? "once" : "chat",
    };
  }
  if (blocked.reason === "not_allowed" && publicName(host))
    return { host, method, kind: "unlisted", critical: false, grant: "chat" };
  return { host, method, kind: "refused", critical: false, grant: "none" };
}

// The block names a host and a method, never a path, so a method a critical
// rule covers on this host is critical whatever the path.
function isCritical(
  connector: NetworkConnector,
  host: string,
  method: string,
): boolean {
  return connector.critical.some(
    (rule: NetworkRule) =>
      (rule.methods as readonly string[]).includes(method as NetworkMethod) &&
      (rule.hosts ?? connector.hosts).includes(host),
  );
}

function publicName(host: string): boolean {
  try {
    networkHost(host, "host");
    return true;
  } catch {
    return false;
  }
}

// One card per site and method in a run, whatever the command retried.
export function blockKey(block: NetworkBlock): string {
  return `${block.kind}:${block.host}:${block.kind === "unlisted" ? "" : block.method}`;
}
