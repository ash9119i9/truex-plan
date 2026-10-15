import { ConsoleLogger, Logger } from "@nestjs/common";
import { createApp } from "./app";
import { ConfigError, loadConfig } from "./config/app-config";
import { loadEnvFileIfPresent } from "./config/env-file";

async function main(): Promise<void> {
  loadEnvFileIfPresent();
  const config = loadConfig(process.env);
  const app = await createApp(config, {
    logger: new ConsoleLogger({ json: true }),
  });
  await app.listen(config.port);
  Logger.log(`platform-next listening on port ${config.port}`, "Bootstrap");
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
});
