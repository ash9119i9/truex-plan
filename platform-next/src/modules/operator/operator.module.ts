import { Module } from "@nestjs/common";
import { AgentsModule } from "../agents/agents.module";
import { AuditModule } from "../audit/audit.module";
import { MembershipsModule } from "../memberships/memberships.module";
import { ModelsModule } from "../models/models.module";
import { TenantsModule } from "../tenants/tenants.module";
import { UsersModule } from "../users/users.module";
import { OperatorService } from "./operator.service";

// No controllers: operator actions are reachable only from the operator CLI.
@Module({
  imports: [
    UsersModule,
    TenantsModule,
    MembershipsModule,
    AuditModule,
    ModelsModule,
    AgentsModule,
  ],
  providers: [OperatorService],
  exports: [OperatorService],
})
export class OperatorModule {}
