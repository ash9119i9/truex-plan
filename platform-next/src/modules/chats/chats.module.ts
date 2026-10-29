import { Module } from "@nestjs/common";
import { TenantGuard } from "../../common/access/tenant.guard";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import { AgentsModule } from "../agents/agents.module";
import { AuditModule } from "../audit/audit.module";
import { ConnectorsModule } from "../connectors/connectors.module";
import { MembershipsModule } from "../memberships/memberships.module";
import { ModelsModule } from "../models/models.module";
import { NetworkModule } from "../network/network.module";
import { SessionsModule } from "../sessions/sessions.module";
import { SkillsModule } from "../skills/skills.module";
import { TenantsModule } from "../tenants/tenants.module";
import { ChatFilesService, FILE_STORE, fileStoreFor } from "./chat-files";
import { ChatStore } from "./chat-store";
import { ChatUploadsService } from "./chat-uploads";
import { ChatsController } from "./chats.controller";
import { ChatsService } from "./chats.service";
import { RecoverySweep } from "./recovery-sweep";
import { RUNTIME_CLIENT, RunExecutor } from "./run-executor";
import { RuntimeClient } from "./runtime-client";
import { UploadsController } from "./uploads.controller";

@Module({
  imports: [
    SessionsModule,
    MembershipsModule,
    TenantsModule,
    AgentsModule,
    ModelsModule,
    ConnectorsModule,
    SkillsModule,
    NetworkModule,
    AuditModule,
  ],
  controllers: [ChatsController, UploadsController],
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
    {
      provide: FILE_STORE,
      inject: [APP_CONFIG],
      // Null without CHAT_FILES_S3_BUCKET: no files are stored or listed.
      useFactory: fileStoreFor,
    },
    ChatFilesService,
    ChatUploadsService,
    ChatStore,
    RunExecutor,
    ChatsService,
    RecoverySweep,
    TenantGuard,
  ],
  // The GoalWatcher (goals module) saves goal runs through these.
  exports: [RUNTIME_CLIENT, RunExecutor, ChatsService],
})
export class ChatsModule {}
