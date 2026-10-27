import { Module } from "@nestjs/common";
import { TenantGuard } from "../../common/access/tenant.guard";
import { AuditModule } from "../audit/audit.module";
import { ConnectorsModule } from "../connectors/connectors.module";
import { MembershipsModule } from "../memberships/memberships.module";
import { ModelsModule } from "../models/models.module";
import { SessionsModule } from "../sessions/sessions.module";
import { SkillsModule } from "../skills/skills.module";
import { TenantsModule } from "../tenants/tenants.module";
import { AgentsController } from "./agents.controller";
import { AgentsService } from "./agents.service";
import { BuiltinAgentsService } from "./builtin-agents.service";

@Module({
  imports: [
    SessionsModule,
    MembershipsModule,
    TenantsModule,
    AuditModule,
    ModelsModule,
    ConnectorsModule,
    SkillsModule,
  ],
  controllers: [AgentsController],
  providers: [AgentsService, BuiltinAgentsService, TenantGuard],
  exports: [AgentsService, BuiltinAgentsService],
})
export class AgentsModule {}
