import { Module } from "@nestjs/common";
import { TenantGuard } from "../../common/access/tenant.guard";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import { AgentsModule } from "../agents/agents.module";
import { ConnectorsModule } from "../connectors/connectors.module";
import { MembershipsModule } from "../memberships/memberships.module";
import { ModelsModule } from "../models/models.module";
import { SessionsModule } from "../sessions/sessions.module";
import { TenantsModule } from "../tenants/tenants.module";
import { ChatStore } from "./chat-store";
import { ChatsController } from "./chats.controller";
import { ChatsService } from "./chats.service";
import { RecoverySweep } from "./recovery-sweep";
import { RUNTIME_CLIENT, RunExecutor } from "./run-executor";
import { RuntimeClient } from "./runtime-client";

@Module({
  imports: [
    SessionsModule,
    MembershipsModule,
    TenantsModule,
    AgentsModule,
    ModelsModule,
    ConnectorsModule,
  ],
  controllers: [ChatsController],
  providers: [
    {
      provide: RUNTIME_CLIENT,
      inject: [APP_CONFIG],
      // Null when chat is not configured; chat endpoints then answer 503.
      useFactory: (config: AppConfig) =>
        config.chat
          ? new RuntimeClient(config.chat.adapterUrl, config.chat.adapterToken)
          : null,
    },
    ChatStore,
    RunExecutor,
    ChatsService,
    RecoverySweep,
    TenantGuard,
  ],
})
export class ChatsModule {}
