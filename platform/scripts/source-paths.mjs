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
};

export function resolvePlatformSource(root, file, fallback) {
  const requested = resolve(root, file);
  if (existsSync(requested)) return requested;
  const moved = relocated[file];
  if (moved && existsSync(resolve(root, moved))) return resolve(root, moved);
  if (fallback) return resolvePlatformSource(root, fallback);
  return requested;
}
