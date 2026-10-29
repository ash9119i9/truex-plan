import { createHash } from "node:crypto";

// The reviewed form of an MCP tool and its hash. When a person classifies a
// connector's tools (Task 9 probe, then a PR), the catalog stores each tool's
// hash in `toolHashes`. The gateway offers a tool only while the provider's
// live definition still hashes the same, so a description or schema changed
// after review (tool poisoning) hides the tool until it is reviewed again.
//
// The hash is sha256 (hex) over the JSON of the reviewed fields with object
// keys sorted at every level; arrays keep their order. Only these fields are
// hashed, and only these reach Codex (server.ts rewrites tools/list to them),
// so what the model sees is exactly what was reviewed. `annotations` is in
// because Codex runs a tool marked readOnlyHint without asking.
//
// platform-next builds from its own sources, so the probe (Task 9) repeats
// this; the pinned vector in test/policy.test.ts keeps the two identical.

const REVIEWED_FIELDS = [
  "name",
  "title",
  "description",
  "inputSchema",
  "outputSchema",
  "annotations",
] as const;
// Real schemas nest a few levels; this only stops runaway recursion.
const MAX_DEPTH = 64;

export function reviewedDefinition(
  tool: Record<string, unknown>,
): Record<string, unknown> {
  const reviewed: Record<string, unknown> = {};
  for (const field of REVIEWED_FIELDS)
    if (tool[field] !== undefined) reviewed[field] = tool[field];
  return reviewed;
}

// Throws on a value deeper than MAX_DEPTH; the caller hides that tool.
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
