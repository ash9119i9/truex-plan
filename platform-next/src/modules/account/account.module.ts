import { Module } from "@nestjs/common";
import { AuthenticatedGuard } from "../../common/access/authenticated.guard";
import { MembershipsModule } from "../memberships/memberships.module";
import { SessionsModule } from "../sessions/sessions.module";
import { TenantsModule } from "../tenants/tenants.module";
import { AccountController } from "./account.controller";
import { AccountService } from "./account.service";

@Module({
  imports: [SessionsModule, MembershipsModule, TenantsModule],
  controllers: [AccountController],
  providers: [AccountService, AuthenticatedGuard],
})
export class AccountModule {}
