// Diagnostic tooling can target either the original or organized checkout.
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const relocated = {
  "platform/src/service.ts": "platform/src/app/platform-service.ts",
  "platform/src/store.ts": "platform/src/persistence/store.ts",
  "platform/src/runtime-transport.ts": "platform/src/runtime/transport.ts",
  "platform/src/http.ts": "platform/src/http/handlers.ts",
  "platform/src/user.ts": "platform/src/identity/user.ts",
  "platform/src/tenant.ts": "platform/src/tenancy/tenant.ts",
  "platform/src/mcp.ts": "platform/src/mcp/profiles.ts",
  "platform/src/public.ts": "platform/src/public/policy.ts",
  "agent-core/src/manager.ts": "agent-core/src/threads/manager.ts",
  "agent-core/src/business-runtime.ts":
    "agent-core/src/runtime/business-runtime.ts",
  "agent-core/src/client.ts": "agent-core/src/runtime/client.ts",
  "agent-core/src/redact.ts": "agent-core/src/telemetry/redact.ts",
  "agent-core/src/trace.ts": "agent-core/src/telemetry/trace.ts",
  "agent-core/src/approval-modes.ts":
    "agent-core/src/threads/approval-policy.ts",
  "agent-core/src/tenancy.ts": "agent-core/src/runtime/tenancy.ts",
  "agent-core/src/schema.ts": "agent-core/src/protocol/schema.ts",
  "agent-core/src/requests.ts": "agent-core/src/protocol/requests.ts",
};

export function resolvePlatformSource(root, file, fallback) {
  const requested = resolve(root, file);
  const moved = relocated[file];
  if (moved && existsSync(resolve(root, moved))) return resolve(root, moved);
  if (existsSync(requested)) return requested;
  if (fallback) return resolvePlatformSource(root, fallback);
  return requested;
}
