import { DynamicModule, Module } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "./app-config";

// Makes the validated startup configuration injectable everywhere.
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      global: true,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
