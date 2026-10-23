import { invalid, objectWith } from "../../common/validation";
import { egressHost, egressHosts } from "./network-host";

// The network a sandbox command may reach in one run, built by the platform
// and passed to the runtime adapter as StartRunBody.network. Nothing the
// model, the message or the workspace says can add to it: hosts come from
// the baseline below, the tenant admin allowlist and the chat owner's active
// connections. Design: tasks/coding-agent-plan.md § Network and credentials.

// Package registries every coding run may download from, with no token.
export const BASELINE_HOSTS: readonly string[] = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
];

export const REQUEST_METHODS = [
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;
export type RequestMethod = (typeof REQUEST_METHODS)[number];

export const CREDENTIAL_AUTH = ["bearer", "token", "basic"] as const;
export type CredentialAuth = (typeof CREDENTIAL_AUTH)[number];

const MAX_CONNECTOR_HOSTS = 20;
const MAX_RULES = 20;
const MAX_RULE_PATHS = 20;
const MAX_URL_PREFIXES = 10;
const MAX_TOKEN_PATTERN = 256;
// Path prefixes as the proxy matches them: a literal prefix, or a glob where
// `*` stays within one segment and `**` spans segments.
const RULE_PATH = /^\/[A-Za-z0-9._~\-/*%@:+]{0,255}$/;

// Requests to a connector's hosts. Each list matches when the method is one
// of `methods`, the host is one of `hosts` (all the connector's hosts when
// absent) and the path starts with one of `paths` (any path when absent).
export interface RequestRule {
  methods: RequestMethod[];
  hosts?: string[];
  paths?: string[];
}

// How the member's token goes with sandbox requests. The proxy adds it only
// for URLs under `urlPrefixes`; commands see a stand-in that matches
// `tokenPattern` (the provider's token format, a Rust-compatible regular
// expression the adapter hands to Codex's credential broker).
export interface ConnectorCredential {
  auth: CredentialAuth[];
  urlPrefixes: string[];
  tokenPattern: string;
}

// A connector's network data, written by the product team with the catalog
// document. Absent means the connector is reachable only as MCP tools.
export interface ConnectorEgress {
  hosts: string[];
  credential?: ConnectorCredential;
  // Requests that pass without asking. Anything else to these hosts asks
  // (decision 2). Defaults to GET and HEAD everywhere.
  reads: RequestRule[];
  // Requests that ask every time, even after Allow for this chat.
  critical: RequestRule[];
}

export const DEFAULT_READS: readonly RequestRule[] = [
  { methods: ["GET", "HEAD"] },
];

// One connection in a run's policy: the connector's egress data plus the
// member's token. `access: "read_only"` means every write is refused, never
// offered for approval.
export interface RunNetworkConnector {
  name: string;
  displayName: string;
  account?: string;
  access: "read_only" | "read_write";
  hosts: string[];
  reads: RequestRule[];
  critical: RequestRule[];
  credential?: ConnectorCredential & { token: string };
}

// The adapter contract (runtime-adapter src/contract.ts NetworkPolicy).
// `hosts` are reachable with no token and no method check.
export interface RunNetworkPolicy {
  hosts: string[];
  connectors: RunNetworkConnector[];
}

// Baseline plus tenant hosts, then the connections. A host a connection
// declares is that connection's, so it leaves the plain list and gets the
// connection's method rules.
export function buildNetworkPolicy(input: {
  tenantHosts: readonly string[];
  connectors: readonly RunNetworkConnector[];
}): RunNetworkPolicy {
  const owned = new Set(input.connectors.flatMap((c) => c.hosts));
  const hosts = [...new Set([...BASELINE_HOSTS, ...input.tenantHosts])]
    .filter((host) => !owned.has(host))
    .sort();
  return { hosts, connectors: [...input.connectors] };
}

function methodsOf(value: unknown, field: string): RequestMethod[] {
  if (!Array.isArray(value) || value.length === 0)
    invalid(`${field} must be a non-empty array of HTTP methods.`);
  const methods = value.map((method, index) => {
    if (
      typeof method !== "string" ||
      !(REQUEST_METHODS as readonly string[]).includes(method)
    )
      invalid(
        `${field}[${index}] must be one of: ${REQUEST_METHODS.join(", ")}.`,
      );
    return method as RequestMethod;
  });
  if (new Set(methods).size !== methods.length)
    invalid(`${field} lists a method twice.`);
  return methods;
}

function pathsOf(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_RULE_PATHS
  )
    invalid(`${field} must have 1-${MAX_RULE_PATHS} paths.`);
  return value.map((path, index) => {
    if (
      typeof path !== "string" ||
      !RULE_PATH.test(path) ||
      path.includes("***")
    )
      invalid(
        `${field}[${index}] must start with / and use letters, digits, / and * (up to 256 characters).`,
      );
    return path;
  });
}

function rulesOf(
  value: unknown,
  field: string,
  hosts: ReadonlySet<string>,
): RequestRule[] {
  if (!Array.isArray(value) || value.length > MAX_RULES)
    invalid(`${field} must be an array of at most ${MAX_RULES} rules.`);
  return value.map((entry, index) => {
    const at = `${field}[${index}]`;
    const raw = objectWith(entry, ["methods", "hosts", "paths"], at);
    const rule: RequestRule = {
      methods: methodsOf(raw.methods, `${at}.methods`),
    };
    if (raw.hosts !== undefined) {
      const ruleHosts = egressHosts(
        raw.hosts,
        `${at}.hosts`,
        MAX_CONNECTOR_HOSTS,
        1,
      );
      for (const host of ruleHosts)
        if (!hosts.has(host))
          invalid(`${at}.hosts must be some of egress.hosts.`);
      rule.hosts = ruleHosts;
    }
    if (raw.paths !== undefined) rule.paths = pathsOf(raw.paths, `${at}.paths`);
    return rule;
  });
}

// An https URL prefix on one of the connector's hosts, ending in "/" so
// `https://api.example.com/repos` cannot also match `/repository`.
function urlPrefixOf(
  value: unknown,
  field: string,
  hosts: ReadonlySet<string>,
): string {
  if (typeof value !== "string" || value.length > 2048)
    invalid(`${field} must be an https URL prefix.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid(`${field} must be an https URL prefix.`);
  }
  if (url.protocol !== "https:" || url.port !== "")
    invalid(`${field} must use https on the default port.`);
  if (url.username || url.password || url.search || url.hash)
    invalid(`${field} must not contain credentials, a query or a fragment.`);
  if (!hosts.has(url.hostname))
    invalid(`${field} must be on one of egress.hosts.`);
  if (!url.pathname.endsWith("/")) invalid(`${field} must end with "/".`);
  if (url.href !== value)
    invalid(`${field} must be written in canonical form.`);
  return url.href;
}

// The broker generates stand-ins from this pattern and only injects a token
// the pattern fully matches, so it must be a real, bounded token format.
function tokenPatternOf(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > MAX_TOKEN_PATTERN ||
    /[\p{Cc}\s]/u.test(value) ||
    /^\^|\$$/.test(value)
  )
    invalid(
      `${field} must be a regular expression of 4-${MAX_TOKEN_PATTERN} characters, without anchors or spaces.`,
    );
  let pattern: RegExp;
  try {
    pattern = new RegExp(`^(?:${value})$`, "u");
  } catch {
    invalid(`${field} must be a valid regular expression.`);
  }
  // Quantifiers outside character classes and escapes must be bounded.
  const bare = value.replace(/\\./g, "").replace(/\[[^\]]*\]/g, "");
  if (pattern.test("") || pattern.test("x") || /[*+]|\{\d+,\}/.test(bare))
    invalid(
      `${field} must describe a bounded token (use {n} or {m,n}, not *, + or {n,}).`,
    );
  return value;
}

function credentialOf(
  value: unknown,
  hosts: ReadonlySet<string>,
): ConnectorCredential {
  const raw = objectWith(
    value,
    ["auth", "urlPrefixes", "tokenPattern"],
    "egress.credential",
  );
  if (!Array.isArray(raw.auth) || raw.auth.length === 0)
    invalid("egress.credential.auth must be a non-empty array.");
  const auth = raw.auth.map((method, index) => {
    if (
      typeof method !== "string" ||
      !(CREDENTIAL_AUTH as readonly string[]).includes(method)
    )
      invalid(
        `egress.credential.auth[${index}] must be one of: ${CREDENTIAL_AUTH.join(", ")}.`,
      );
    return method as CredentialAuth;
  });
  if (new Set(auth).size !== auth.length)
    invalid("egress.credential.auth lists a method twice.");
  if (
    !Array.isArray(raw.urlPrefixes) ||
    raw.urlPrefixes.length === 0 ||
    raw.urlPrefixes.length > MAX_URL_PREFIXES
  )
    invalid(
      `egress.credential.urlPrefixes must have 1-${MAX_URL_PREFIXES} entries.`,
    );
  const urlPrefixes = raw.urlPrefixes.map((prefix, index) =>
    urlPrefixOf(prefix, `egress.credential.urlPrefixes[${index}]`, hosts),
  );
  if (new Set(urlPrefixes).size !== urlPrefixes.length)
    invalid("egress.credential.urlPrefixes lists a prefix twice.");
  return {
    auth,
    urlPrefixes,
    tokenPattern: tokenPatternOf(
      raw.tokenPattern,
      "egress.credential.tokenPattern",
    ),
  };
}

// `mcpUrl` is the connector's MCP endpoint: its host must be declared, so the
// catalog document names every host the connector talks to.
export function parseConnectorEgress(
  value: unknown,
  mcpUrl: string,
): ConnectorEgress {
  const raw = objectWith(
    value,
    ["hosts", "credential", "reads", "critical"],
    "egress",
  );
  const hostList = egressHosts(
    raw.hosts,
    "egress.hosts",
    MAX_CONNECTOR_HOSTS,
    1,
  );
  const hosts = new Set(hostList);
  if (!hosts.has(egressHost(new URL(mcpUrl).hostname, "url")))
    invalid("egress.hosts must include the host of url.");
  const egress: ConnectorEgress = {
    hosts: hostList,
    reads:
      raw.reads === undefined
        ? DEFAULT_READS.map((rule) => ({ methods: [...rule.methods] }))
        : rulesOf(raw.reads, "egress.reads", hosts),
    critical:
      raw.critical === undefined
        ? []
        : rulesOf(raw.critical, "egress.critical", hosts),
  };
  if (raw.credential !== undefined)
    egress.credential = credentialOf(raw.credential, hosts);
  return egress;
}
