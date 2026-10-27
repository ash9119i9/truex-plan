import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { MembershipsModule } from "../memberships/memberships.module";
import { TenantsModule } from "../tenants/tenants.module";
import { UsersModule } from "../users/users.module";
import { SessionsController } from "./sessions.controller";
import { SessionsService } from "./sessions.service";

@Module({
  imports: [UsersModule, MembershipsModule, TenantsModule, AuditModule],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
