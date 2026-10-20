import { DynamicModule, Module } from "@nestjs/common";
import type { AppConfig } from "./config/app-config";
import { ConfigModule } from "./config/config.module";
import { DatabaseModule } from "./database/database.module";
import { AccountModule } from "./modules/account/account.module";
import { AgentsModule } from "./modules/agents/agents.module";
import { AuditModule } from "./modules/audit/audit.module";
import { ChatsModule } from "./modules/chats/chats.module";
import { AuthModule } from "./modules/auth/auth.module";
import { ConnectorsModule } from "./modules/connectors/connectors.module";
import { CurrentTenantModule } from "./modules/current-tenant/current-tenant.module";
import { HealthModule } from "./modules/health/health.module";
import { MembershipsModule } from "./modules/memberships/memberships.module";
import { ModelsModule } from "./modules/models/models.module";
import { OperatorModule } from "./modules/operator/operator.module";
import { SessionsModule } from "./modules/sessions/sessions.module";
import { TenantsModule } from "./modules/tenants/tenants.module";
import { UsersModule } from "./modules/users/users.module";

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        DatabaseModule,
        HealthModule,
        AuditModule,
        UsersModule,
        TenantsModule,
        MembershipsModule,
        OperatorModule,
        SessionsModule,
        AuthModule,
        AccountModule,
        CurrentTenantModule,
        ModelsModule,
        AgentsModule,
        ChatsModule,
        ConnectorsModule,
      ],
    };
  }
}
