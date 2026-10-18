import { ConsoleLogger, Logger } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { createApp } from "./app";
import { ConfigError, loadConfig } from "./config/app-config";
import { loadEnvFileIfPresent } from "./config/env-file";
import { DatabaseService } from "./database/database.service";
import { TenantsService } from "./modules/tenants/tenants.service";

// Long enough for a cold connection to a remote cluster.
const STARTUP_CHECK_CONNECT_MS = 60_000;

async function main(): Promise<void> {
  loadEnvFileIfPresent();
  const config = loadConfig(process.env);
  const app = await createApp(config, {
    logger: new ConsoleLogger({ json: true }),
  });
  await app.listen(config.port);
  Logger.log(`platform-next listening on port ${config.port}`, "Bootstrap");
  void checkDatabase(app);
}

// Reports, without blocking startup, what would make chat fail later: a
// MongoDB older than 8.0 (starting and sending use client bulkWrite) and
// tenants whose indexes were never built for this release (retries could
// then duplicate chats). Two queries, whatever the number of tenants.
async function checkDatabase(app: INestApplication): Promise<void> {
  const logger = new Logger("Bootstrap");
  try {
    const database = app.get(DatabaseService);
    await database.waitUntilConnected(STARTUP_CHECK_CONNECT_MS);
    const [major, stale] = await Promise.all([
      database.serverMajorVersion(),
      app.get(TenantsService).countStaleIndexes(),
    ]);
    if (major < 8)
      logger.error({
        message: "MongoDB 8.0 or later is required: chats cannot start",
        serverMajorVersion: major,
      });
    if (stale > 0)
      logger.error({
        message: "tenants are missing this release's indexes",
        tenants: stale,
        fix: "operator ensure-tenant-indexes --operator <name> --all",
      });
  } catch (error) {
    logger.warn({
      message: "startup database check did not run",
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
