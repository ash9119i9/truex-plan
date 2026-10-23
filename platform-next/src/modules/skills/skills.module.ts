import { Module } from "@nestjs/common";
import { TenantGuard } from "../../common/access/tenant.guard";
import { APP_CONFIG } from "../../config/app-config";
import { fileStoreFor } from "../chats/chat-files";
import { MembershipsModule } from "../memberships/memberships.module";
import { SessionsModule } from "../sessions/sessions.module";
import { TenantsModule } from "../tenants/tenants.module";
import { SkillsController } from "./skills.controller";
import { SKILL_STORE, SkillsService } from "./skills.service";

@Module({
  imports: [SessionsModule, MembershipsModule, TenantsModule],
  controllers: [SkillsController],
  providers: [
    {
      provide: SKILL_STORE,
      inject: [APP_CONFIG],
      // The chat files bucket; null without CHAT_FILES_S3_BUCKET.
      useFactory: fileStoreFor,
    },
    SkillsService,
    TenantGuard,
  ],
  exports: [SkillsService],
})
export class SkillsModule {}
