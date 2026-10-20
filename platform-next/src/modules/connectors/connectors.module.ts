import { Module } from "@nestjs/common";
import { TenantGuard } from "../../common/access/tenant.guard";
import { AuditModule } from "../audit/audit.module";
import { MembershipsModule } from "../memberships/memberships.module";
import { SessionsModule } from "../sessions/sessions.module";
import { TenantsModule } from "../tenants/tenants.module";
import { ClientSecretResolver } from "./client-secret.resolver";
import { ConnectorsCatalogService } from "./connectors-catalog.service";
import { ConnectorsController } from "./connectors.controller";
import { ConnectorsService } from "./connectors.service";

// Directory connectors: the catalog (operator-written), per-user connections
// with OAuth sign-in, and the executor's runSpecs (exported for slice 4). The
// catalog service is exported so the operator module can write connectors.
@Module({
  imports: [SessionsModule, MembershipsModule, TenantsModule, AuditModule],
  controllers: [ConnectorsController],
  providers: [
    ConnectorsCatalogService,
    ConnectorsService,
    ClientSecretResolver,
    TenantGuard,
  ],
  exports: [ConnectorsCatalogService, ConnectorsService],
})
export class ConnectorsModule {}
