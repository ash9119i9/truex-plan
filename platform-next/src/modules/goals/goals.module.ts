import { Module } from "@nestjs/common";
import { TenantGuard } from "../../common/access/tenant.guard";
import { AuditModule } from "../audit/audit.module";
import { ChatsModule } from "../chats/chats.module";
import { MembershipsModule } from "../memberships/memberships.module";
import { SessionsModule } from "../sessions/sessions.module";
import { TenantsModule } from "../tenants/tenants.module";
import { ChatEventsController } from "./chat-events.controller";
import { GoalStore } from "./goal-store";
import { GoalWatcher } from "./goal-watcher";
import { GoalsController } from "./goals.controller";
import { GoalsService } from "./goals.service";

@Module({
  imports: [
    ChatsModule,
    TenantsModule,
    SessionsModule,
    MembershipsModule,
    AuditModule,
  ],
  controllers: [GoalsController, ChatEventsController],
  providers: [GoalStore, GoalWatcher, GoalsService, TenantGuard],
  exports: [GoalStore, GoalWatcher],
})
export class GoalsModule {}
