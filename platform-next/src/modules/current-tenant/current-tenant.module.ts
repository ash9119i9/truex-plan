import { Module } from "@nestjs/common";
import { TenantGuard } from "../../common/access/tenant.guard";
import { MembershipsModule } from "../memberships/memberships.module";
import { SessionsModule } from "../sessions/sessions.module";
import { TenantsModule } from "../tenants/tenants.module";
import { CurrentTenantController } from "./current-tenant.controller";

@Module({
  imports: [SessionsModule, MembershipsModule, TenantsModule],
  controllers: [CurrentTenantController],
  providers: [TenantGuard],
})
export class CurrentTenantModule {}
