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

// Public tenant metadata plus the caller's role, the same shape as an entry
// in GET /me/tenants. Never the database name.
export interface CurrentTenantView {
  id: string;
  name: string;
  role: Role;
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
    const [membership, tenant] = await timed("tenant", () =>
      Promise.all([
        this.memberships.findActive(context.userId, context.tenantId),
        this.tenants.findUsable(context.tenantId),
      ]),
    );
    if (!membership || !tenant)
      throw new ApiError(403, "FORBIDDEN", NO_TENANT_ACCESS);
    return {
      tenant: {
        id: toWireId(tenant._id),
        name: tenant.name,
        role: membership.role,
      },
    };
  }
}
