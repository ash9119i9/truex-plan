// Synthetic catalog definitions for tests. The ARN is fake; nothing calls AWS.
export const TEST_SECRET_ARN =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:truex/test-AbC123";

export function modelDefinition(overrides: Record<string, unknown> = {}) {
  return {
    slug: "claude-sonnet",
    displayName: "Claude Sonnet 4.5",
    shortLabel: "sonnet 4.5",
    family: "anthropic",
    wireApi: "anthropic",
    baseUrl: "https://api.anthropic.com",
    modelName: "claude-sonnet-4-5",
    apiKeySecretArn: TEST_SECRET_ARN,
    maxOutputTokens: 16_000,
    contextWindow: 200_000,
    autoCompactTokenLimit: 160_000,
    thinking: true,
    promptCache: { type: "anthropic", enabled: true, ttl: "5m" },
    sortOrder: 10,
    ...overrides,
  };
}

export function geminiDefinition(overrides: Record<string, unknown> = {}) {
  return modelDefinition({
    slug: "gemini-pro",
    displayName: "Gemini 2.5 Pro",
    shortLabel: "gemini 2.5",
    family: "google",
    wireApi: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelName: "gemini-2.5-pro",
    contextWindow: 1_000_000,
    autoCompactTokenLimit: 800_000,
    promptCache: undefined,
    sortOrder: 20,
    ...overrides,
  });
}

export function builtinDefinition(overrides: Record<string, unknown> = {}) {
  return {
    slug: "general",
    name: "General Agent",
    description: "Helps with anything.",
    instructions: "You are a helpful assistant for this workspace.",
    model: "claude-sonnet",
    look: 2,
    tint: "ice",
    sortOrder: 10,
    ...overrides,
  };
}
