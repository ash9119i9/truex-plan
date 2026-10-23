import { Module } from "@nestjs/common";
import { TenantGuard } from "../../common/access/tenant.guard";
import { AuditModule } from "../audit/audit.module";
import { MembershipsModule } from "../memberships/memberships.module";
import { SessionsModule } from "../sessions/sessions.module";
import { TenantsModule } from "../tenants/tenants.module";
import { NetworkController } from "./network.controller";
import { TenantNetworkService } from "./tenant-network.service";

// Sandbox network policy: the tenant admin allowlist, and the service chats
// use to read it for a run.
@Module({
  imports: [SessionsModule, MembershipsModule, TenantsModule, AuditModule],
  controllers: [NetworkController],
  providers: [TenantNetworkService, TenantGuard],
  exports: [TenantNetworkService],
})
export class NetworkModule {}
