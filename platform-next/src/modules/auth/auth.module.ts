import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { MembershipsModule } from "../memberships/memberships.module";
import { SessionsModule } from "../sessions/sessions.module";
import { TenantsModule } from "../tenants/tenants.module";
import { UsersModule } from "../users/users.module";
import { AuthService } from "./auth.service";
import { GoogleAuthController } from "./google-auth.controller";
import { GoogleOidcClient } from "./google-oidc";

@Module({
  imports: [
    UsersModule,
    TenantsModule,
    MembershipsModule,
    SessionsModule,
    AuditModule,
  ],
  controllers: [GoogleAuthController],
  providers: [AuthService, GoogleOidcClient],
})
export class AuthModule {}
