import { reviewedDefinition, toolHash } from "./tool-hash";

// Which tools one chat may see and call on one connector, decided by the
// gateway on every request whatever Codex was told (Codex's own
// `enabled_tools` stays as defence in depth). A tool is offered only when:
// - the catalog allows it (`allowedTools`; absent means every reviewed tool),
// - the chat's access permits it (read-only removes `writeTools`),
// - it has a reviewed hash (`toolHashes`), and the live definition matches.
// Fields are read from the catalog record as stored and are not trusted to
// be well formed: anything malformed offers nothing.

export type ChatAccess = "read_write" | "read_only";

export interface ToolPolicy {
  // Tool name → reviewed definition hash, for the tools this chat may use.
  readonly tools: ReadonlyMap<string, string>;
  // The connector's write tools, so a refusal can say why.
  readonly writes: ReadonlySet<string>;
  readonly access: ChatAccess;
}

export interface ConnectorToolFields {
  readonly allowedTools?: unknown;
  readonly writeTools?: unknown;
  readonly toolHashes?: unknown;
}

const HASH = /^[0-9a-f]{64}$/;

export function policyOf(
  connector: ConnectorToolFields,
  access: ChatAccess,
): ToolPolicy {
  const none: ToolPolicy = { tools: new Map(), writes: new Set(), access };
  const hashes = hashesOf(connector.toolHashes);
  if (!hashes) return none;
  let allowed: ReadonlySet<string> | undefined;
  if (connector.allowedTools !== undefined) {
    const list = namesOf(connector.allowedTools);
    if (!list) return none;
    allowed = new Set(list);
  }
  let writes: ReadonlySet<string> = new Set();
  if (connector.writeTools !== undefined) {
    const list = namesOf(connector.writeTools);
    // Unreadable writeTools: which tools change data is unknown.
    if (!list) return none;
    writes = new Set(list);
  }
  const tools = new Map<string, string>();
  for (const [name, hash] of hashes) {
    if (allowed && !allowed.has(name)) continue;
    if (access === "read_only" && writes.has(name)) continue;
    tools.set(name, hash);
  }
  return { tools, writes, access };
}

export type CallVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "not_allowed" | "read_only";
      readonly message: string;
    };

export function callVerdict(
  policy: ToolPolicy,
  connector: string,
  tool: string,
): CallVerdict {
  if (policy.tools.has(tool)) return { ok: true };
  if (policy.access === "read_only" && policy.writes.has(tool))
    return {
      ok: false,
      reason: "read_only",
      message: `${tool} changes data, and this chat's access to ${connector} is read-only.`,
    };
  return {
    ok: false,
    reason: "not_allowed",
    message: `${tool} isn't available to this chat through Truex.`,
  };
}

export interface ListFilterResult {
  // The tools/list result to send Codex, or undefined when the provider's
  // result isn't a tool list.
  readonly result: Record<string, unknown> | undefined;
  readonly changed: ReadonlyArray<{
    readonly tool: string;
    readonly expected: string;
    readonly actual: string;
  }>;
  readonly hidden: number;
}

// Keeps the tools the policy offers whose live hash matches, each cut down
// to its reviewed fields. `nextCursor` is kept so Codex can page; anything
// else on the result (`_meta`) is dropped.
export function filterToolList(
  policy: ToolPolicy,
  providerResult: unknown,
): ListFilterResult {
  if (!isRecord(providerResult) || !Array.isArray(providerResult.tools))
    return { result: undefined, changed: [], hidden: 0 };
  const tools: Record<string, unknown>[] = [];
  const changed: Array<{ tool: string; expected: string; actual: string }> = [];
  let hidden = 0;
  for (const tool of providerResult.tools) {
    const name = isRecord(tool) ? tool.name : undefined;
    const expected =
      typeof name === "string" ? policy.tools.get(name) : undefined;
    if (!isRecord(tool) || typeof name !== "string" || !expected) {
      hidden++;
      continue;
    }
    let actual: string;
    try {
      actual = toolHash(tool);
    } catch {
      actual = "unhashable";
    }
    if (actual !== expected) {
      changed.push({ tool: name, expected, actual });
      hidden++;
      continue;
    }
    tools.push(reviewedDefinition(tool));
  }
  const result: Record<string, unknown> = { tools };
  if (typeof providerResult.nextCursor === "string")
    result.nextCursor = providerResult.nextCursor;
  return { result, changed, hidden };
}

function hashesOf(value: unknown): Map<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const hashes = new Map<string, string>();
  for (const [name, hash] of Object.entries(value))
    if (typeof hash === "string" && HASH.test(hash)) hashes.set(name, hash);
  return hashes;
}

function namesOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
    return undefined;
  return value as string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
