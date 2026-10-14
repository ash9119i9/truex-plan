import { createHash } from "node:crypto";

// Same value with object keys sorted, so equal configs serialize equally.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as any)[key])]),
    );
  return value;
}

// sha256 of a thread's built mcp_servers.* entries (names, urls, headers and
// keys). Only this hash leaves the platform; agent-core reloads a loaded
// thread when it changes.
export function mcpFingerprint(config: Record<string, unknown>) {
  const servers = Object.keys(config)
    .filter((key) => key.startsWith("mcp_servers."))
    .sort()
    .map((key) => [key, canonical(config[key])]);
  return createHash("sha256").update(JSON.stringify(servers)).digest("hex");
}
