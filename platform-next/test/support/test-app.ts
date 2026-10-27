import type { NestExpressApplication } from "@nestjs/platform-express";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { createApp } from "../../src/app";
import type { AppConfig } from "../../src/config/app-config";
import { testAuthConfig, testGoogleConfig } from "./test-auth";

// A replica set, because later features rely on MongoDB transactions.
export async function startReplicaSet(): Promise<MongoMemoryReplSet> {
  return MongoMemoryReplSet.create({ replSet: { count: 1 } });
}

export interface RunningApp {
  app: NestExpressApplication;
  baseUrl: string;
  close(): Promise<void>;
}

// Starts the real application on a free port with logging silenced.
export async function startApp(
  overrides: Partial<AppConfig> & Pick<AppConfig, "mongodbUri">,
): Promise<RunningApp> {
  const config: AppConfig = {
    port: 0,
    catalogDbName: "truex_next_test_catalog",
    auth: testAuthConfig(),
    google: testGoogleConfig(),
    ...overrides,
  };
  const app = await createApp(config, { logger: false });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  if (typeof address !== "object" || address === null)
    throw new Error("test app did not bind a TCP port");
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => app.close(),
  };
}
