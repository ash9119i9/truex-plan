import { Controller, Get, Inject, UseGuards } from "@nestjs/common";
import {
  CurrentTenant,
  NO_TENANT_ACCESS,
  TenantGuard,
  type TenantContext,
} from "../../common/access/tenant.guard";
import { ApiError } from "../../common/http/api-error";
import { timed } from "../../common/http/server-timing";
import { toWireId } from "../../database/object-id";
import type { Role } from "../memberships/membership";
import { MembershipsService } from "../memberships/memberships.service";
import { TenantsService } from "../tenants/tenants.service";

// Public tenant metadata plus the caller's role, as in an entry of
// GET /me/tenants, and the tenant's goal settings. Never the database name
// or the tenant-wide active-goal cap.
export interface CurrentTenantView {
  id: string;
  name: string;
  role: Role;
  // What the goal dialog offers new chats; null when goals are off.
  goals: { presets: number[]; maxTokenBudget: number } | null;
}

// The tenant named by ?tenantId=, as the caller sees it. A frontend calls
// this when it opens a tenant route, to confirm access and learn the role.
// Both are read now rather than taken from the access token, so opening a
// tenant always reflects a removal, role change or disabled tenant.
@Controller("tenant")
@UseGuards(TenantGuard)
export class CurrentTenantController {
  constructor(
    @Inject(MembershipsService)
    private readonly memberships: MembershipsService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
  ) {}

  @Get()
  async current(@CurrentTenant() context: TenantContext): Promise<{
    tenant: CurrentTenantView;
  }> {
    // The goal settings come from the cache a chat start snapshots, so the
    // dialog shows what a new chat gets and the next start reads nothing.
    const [membership, tenant, goals] = await timed("tenant", () =>
      Promise.all([
        this.memberships.findActive(context.userId, context.tenantId),
        this.tenants.findUsable(context.tenantId),
        this.tenants.goalsOf(context.tenantId),
      ]),
    );
    if (!membership || !tenant)
      throw new ApiError(403, "FORBIDDEN", NO_TENANT_ACCESS);
    return {
      tenant: {
        id: toWireId(tenant._id),
        name: tenant.name,
        role: membership.role,
        goals: goals
          ? {
              presets: [...goals.presets],
              maxTokenBudget: goals.maxTokenBudget,
            }
          : null,
      },
    };
  }
}
