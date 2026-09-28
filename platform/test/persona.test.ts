import { test } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Store } from "../src/store";
import { PlatformService } from "../src/service";
import { insertFixtures } from "./fixtures";

test(
  "agent persona and scope come from the agent record and are validated",
  { timeout: 120000 },
  async (t) => {
    const mongo = await MongoMemoryServer.create();
    const store = await new Store(mongo.getUri(), "persona-test").connect();
    t.after(async () => {
      await store.client.close();
      await mongo.stop();
    });
    await insertFixtures(store);
    const service = new PlatformService(store);

    // Existing agents are unchanged: no persona or scope is sent.
    const plain: any = await service.configuration("assistant");
    assert.equal(plain.persona, undefined);
    assert.equal(plain.scope, undefined);

    await store.agents.updateOne(
      { _id: "assistant" as any },
      { $set: { persona: "You are Nova.", scope: "general" } },
    );
    const general: any = await service.configuration("assistant");
    assert.equal(general.persona, "You are Nova.");
    assert.equal(general.scope, "general");

    // Unknown scopes and blank personas fall back to the defaults.
    await store.agents.updateOne(
      { _id: "assistant" as any },
      { $set: { persona: "   ", scope: "anything" } },
    );
    const invalid: any = await service.configuration("assistant");
    assert.equal(invalid.persona, undefined);
    assert.equal(invalid.scope, undefined);
  },
);
