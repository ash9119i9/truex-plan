// Agents one person may create in a private workspace (AGENTS_PER_USER_MAX).
export function agentLimit(env: NodeJS.ProcessEnv = process.env) {
  const n = Number(env.AGENTS_PER_USER_MAX);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : 25;
}
