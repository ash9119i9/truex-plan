import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { AppConfig } from "../../src/config/app-config";
import { DatabaseService } from "../../src/database/database.service";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (typeof address !== "object" || address === null)
    throw new Error("no port");
  return address.port;
}

function serviceFor(port: number): DatabaseService {
  return new DatabaseService({
    mongodbUri: `mongodb://127.0.0.1:${port}/?directConnection=true`,
    catalogDbName: "truex_next_test_catalog",
  } as AppConfig);
}

describe("DatabaseService.waitUntilConnected", () => {
  // One-shot commands (the operator CLI) must not run their first operation
  // before a slow cold connection finishes, which outlasts server selection.
  test("waits for a database that becomes reachable after startup", async () => {
    const port = await freePort();
    const database = serviceFor(port);
    database.onModuleInit();
    const waiting = database.waitUntilConnected(30_000);
    // Long enough for the first attempt to fail and a retry to be scheduled.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const mongo = await MongoMemoryServer.create({ instance: { port } });
    try {
      await waiting;
      await database.ping();
      // Already connected: resolves immediately.
      await database.waitUntilConnected(1);
    } finally {
      await database.onApplicationShutdown();
      await mongo.stop();
    }
  });

  test("fails with a clear error when the database stays unreachable", async () => {
    const database = serviceFor(await freePort());
    database.onModuleInit();
    try {
      await assert.rejects(
        database.waitUntilConnected(500),
        /not reachable within 500 ms/,
      );
    } finally {
      await database.onApplicationShutdown();
    }
  });
});
