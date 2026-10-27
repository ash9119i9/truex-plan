import { Module } from "@nestjs/common";
import { TenantGuard } from "../../common/access/tenant.guard";
import { MembershipsModule } from "../memberships/memberships.module";
import { SessionsModule } from "../sessions/sessions.module";
import { TenantsModule } from "../tenants/tenants.module";
import { ModelsController } from "./models.controller";
import { ModelsService } from "./models.service";

@Module({
  imports: [SessionsModule, MembershipsModule, TenantsModule],
  controllers: [ModelsController],
  providers: [ModelsService, TenantGuard],
  exports: [ModelsService],
})
export class ModelsModule {}
