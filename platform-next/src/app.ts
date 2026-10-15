import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { LoggerService, LogLevel } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import type { AppConfig } from "./config/app-config";
import { ErrorEnvelopeFilter } from "./common/http/error-envelope.filter";
import { assignRequestId } from "./common/http/request-id";

export const API_PREFIX = "api/v1";

export interface CreateAppOptions {
  logger?: LoggerService | LogLevel[] | false;
}

// Builds the HTTP application without listening, so tests and main.ts start
// exactly the same app.
export async function createApp(
  config: AppConfig,
  options: CreateAppOptions = {},
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(config),
    {
      abortOnError: false,
      forceCloseConnections: true,
      logger: options.logger,
    },
  );
  app.disable("x-powered-by");
  app.use(assignRequestId);
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  app.setGlobalPrefix(API_PREFIX, { exclude: ["health/live", "health/ready"] });
  app.enableShutdownHooks();
  return app;
}
