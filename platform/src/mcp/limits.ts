// Connected tools one person may keep (MCP_PER_USER_MAX).
export function mcpLimit(env: NodeJS.ProcessEnv = process.env) {
  const n = Number(env.MCP_PER_USER_MAX);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : 20;
}
