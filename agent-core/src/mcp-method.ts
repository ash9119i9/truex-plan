export type McpMethod = "direct" | "adaptive_v2" | "omni";

/** Operator setting, read at startup. An explicit value overrides legacy settings. */
export function mcpMethod(env: NodeJS.ProcessEnv = process.env): McpMethod {
  const value = env.MCP_METHOD;
  if (value !== undefined) {
    if (value === "direct" || value === "adaptive_v2" || value === "omni")
      return value;
    throw new Error("MCP_METHOD must be direct, adaptive_v2 or omni");
  }
  if (
    env.MCP_ROUTING_MODE &&
    !["direct", "omni", "adaptive"].includes(env.MCP_ROUTING_MODE)
  )
    throw new Error("MCP_ROUTING_MODE must be direct, omni or adaptive");
  if (env.MCP_ROUTING_MODE === "adaptive") return "adaptive_v2";
  if (env.MCP_ROUTING_MODE === "omni" || env.TRUEX_MCP_GATEWAY_MODE === "omni")
    return "omni";
  return "direct";
}
