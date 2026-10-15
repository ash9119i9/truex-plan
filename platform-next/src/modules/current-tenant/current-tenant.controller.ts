import { Controller, Get, UseGuards } from "@nestjs/common";
import {
  CurrentTenant,
  TenantGuard,
  type TenantContext,
} from "../../common/access/tenant.guard";
import { toWireId } from "../../database/object-id";
import type { Role } from "../memberships/membership";

// Public tenant metadata plus the caller's role, the same shape as an entry
// in GET /me/tenants. Never the database name.
export interface CurrentTenantView {
  id: string;
  name: string;
  role: Role;
}

// The tenant named by ?tenantId=, as the caller sees it. A frontend calls
// this when it opens a tenant route, to confirm access and learn the role.
@Controller("tenant")
@UseGuards(TenantGuard)
export class CurrentTenantController {
  @Get()
  current(@CurrentTenant() context: TenantContext): {
    tenant: CurrentTenantView;
  } {
    return {
      tenant: {
        id: toWireId(context.tenantId),
        name: context.tenant.name,
        role: context.role,
      },
    };
  }
}
