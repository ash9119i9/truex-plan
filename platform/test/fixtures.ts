import { Store } from "../src/store";
import { mcpNetwork } from "../src/mcp";
import { userContext, type UserRef } from "../src/user";

// The plan's test people in tenant t1: two users and a tenant admin.
export const ashok: UserRef = {
  id: "ashok",
  email: "ashok@dev.local",
  role: "user",
};
export const dharun: UserRef = {
  id: "dharun",
  email: "dharun@dev.local",
  role: "user",
};
export const admin: UserRef = {
  id: "admin",
  email: "admin@dev.local",
  role: "admin",
};
// Runs fn as that signed-in person, like userMiddleware does for /api.
export const asUser = <T>(user: UserRef, fn: () => T): T =>
  userContext.run(user, fn);

// Tests never use real DNS: MCP hosts resolve from this table (public
// addresses by default); a test edits it to simulate a rebinding.
export const fakeDns: Record<string, string[]> = {
  "example.com": ["203.0.113.10"],
  "mcp.example": ["203.0.113.11"],
};
mcpNetwork.lookup = async (host) => fakeDns[host] || [];
// A fixed test key, so MCP API keys can be stored encrypted.
export const testEncryptionKey = Buffer.alloc(32, 7).toString("base64");
process.env.MCP_ENCRYPTION_KEY ||= testEncryptionKey;

export async function insertFixtures(store: Store) {
  const profile = {
    _id: "default",
    provider: "fixture",
    baseUrl: "http://127.0.0.1:1/v1",
    modelName: "gpt-5",
    reasoningEffort: "medium",
    apikey: "test-fixture-key",
    wireApi: "responses" as const,
  };
  await store.profiles.updateOne(
    { _id: profile._id },
    { $setOnInsert: profile },
    { upsert: true },
  );
  for (const agent of [
    {
      _id: "assistant",
      name: "Assistant",
      description: "Read-only assistant",
      sandbox: "read-only" as const,
      approvalPolicy: "never" as const,
    },
    {
      _id: "developer",
      name: "Developer",
      description: "Workspace edits with approval requests",
      sandbox: "workspace-write" as const,
      approvalPolicy: "on-request" as const,
    },
  ])
    await store.agents.updateOne(
      { _id: agent._id },
      {
        $setOnInsert: {
          ...agent,
          modelProfileId: "default",
          systemPrompt: "You are a helpful assistant. Be clear and concise.",
          mcpProfileIds: [],
        },
      },
      { upsert: true },
    );
}
