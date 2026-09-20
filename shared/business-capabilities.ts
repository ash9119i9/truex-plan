// Product operations that cannot grant host access or import arbitrary history.
export const businessCapabilities: Record<string, readonly string[]> = {
  "thread/fork": ["lastTurnId", "beforeTurnId"],
  "thread/compact/start": [],
  "thread/archive": [],
  "thread/unarchive": [],
  "thread/goal/get": [],
  "thread/goal/set": ["objective", "status", "tokenBudget"],
  "thread/goal/clear": [],
  "thread/settings/update": [
    "model",
    "effort",
    "summary",
    "serviceTier",
    "personality",
  ],
};
export function businessCapabilityParams(
  method: string,
  params: unknown,
  internal = false,
) {
  const fields = Object.hasOwn(businessCapabilities, method)
    ? businessCapabilities[method]
    : undefined;
  if (!fields || !params || typeof params !== "object" || Array.isArray(params))
    throw new Error("This operation is not available in Truex");
  if (
    Object.keys(params).some(
      (key) => !fields.includes(key) && !(internal && key === "threadId"),
    )
  )
    throw new Error("This setting is not available in Truex");
  return params as Record<string, unknown>;
}
