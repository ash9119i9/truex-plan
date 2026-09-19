import { Store } from "../src/store";
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
