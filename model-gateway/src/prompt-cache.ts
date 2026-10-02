import { createHash } from "node:crypto";
import type { PromptCachePolicy } from "../../shared/prompt-cache";

// Validate stored configuration before sending any request to the provider.
// Errors name fields only, never include profile values or prompt content.
export function cachePolicyError(
  value: unknown,
  wireApi?: string,
): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "promptCache must be an object.";
  const p = value as Record<string, unknown>;
  if (p.type !== wireApi || (p.type !== "chat" && p.type !== "anthropic"))
    return "promptCache.type must match a chat or anthropic profile.";
  const allowed =
    p.type === "chat"
      ? ["type", "keyScope", "retention"]
      : ["type", "enabled", "ttl", "conversationBreakpoint"];
  if (Object.keys(p).some((key) => !allowed.includes(key)))
    return "promptCache contains unsupported fields.";
  if (p.type === "chat") {
    if (
      p.keyScope !== undefined &&
      p.keyScope !== "session" &&
      p.keyScope !== "prefix"
    )
      return "promptCache.keyScope must be session or prefix.";
    if (
      p.retention !== undefined &&
      p.retention !== "in_memory" &&
      p.retention !== "24h"
    )
      return "promptCache.retention must be in_memory or 24h.";
  } else {
    if (p.ttl !== undefined && p.ttl !== "5m" && p.ttl !== "1h")
      return "promptCache.ttl must be 5m or 1h.";
    for (const key of ["enabled", "conversationBreakpoint"])
      if (p[key] !== undefined && typeof p[key] !== "boolean")
        return `promptCache.${key} must be a boolean.`;
  }
  return null;
}

// Object-key normalization is used only for hashing. Never rewrite actual
// prompt content, messages, tool definitions or their ordering.
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

export function chatCacheOptions(
  policy: PromptCachePolicy | undefined,
  input: any,
  body: Record<string, any>,
  scope: { profileId: string; tenantId?: string },
): Record<string, string> {
  if (policy?.type !== "chat") return {};
  const options: Record<string, string> = {};
  if (policy.retention) options.prompt_cache_retention = policy.retention;
  const prefix = {
    model: body.model,
    tools: body.tools ?? [],
    system: body.messages.filter((m: any) => m.role === "system"),
  };
  const session =
    typeof input.prompt_cache_key === "string" && input.prompt_cache_key
      ? input.prompt_cache_key
      : undefined;
  // Missing session keys do not silently broaden sharing to a whole tenant.
  if (policy.keyScope !== "prefix" && !session) return options;
  options.prompt_cache_key =
    "truex:" +
    createHash("sha256")
      .update(
        JSON.stringify(
          canonical({
            tenant: scope.tenantId ?? "default",
            profile: scope.profileId,
            prefix,
            ...(policy.keyScope === "prefix" ? {} : { session }),
          }),
        ),
      )
      .digest("hex");
  return options;
}
