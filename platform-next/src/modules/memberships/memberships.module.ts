import { Module } from "@nestjs/common";
import { TenantsModule } from "../tenants/tenants.module";
import { MembershipsService } from "./memberships.service";

@Module({
  imports: [TenantsModule],
  providers: [MembershipsService],
  exports: [MembershipsService],
})
export class MembershipsModule {}
