import { Inject, Injectable } from "@nestjs/common";
import type { ObjectId } from "mongodb";
import { toWireId } from "../../database/object-id";
import type { Role } from "../memberships/membership";
import { MembershipsService } from "../memberships/memberships.service";
import { TenantsService } from "../tenants/tenants.service";
import type { UserDoc } from "../users/user";

export interface AccountProfile {
  id: string;
  email: string;
  name: string;
  picture?: string;
}

// Public tenant metadata plus the caller's role in it. Never the database.
export interface AccountTenant {
  id: string;
  name: string;
  role: Role;
}

// Where the app goes after sign-in. A remembered choice must not turn
// chooseTenant into enterTenant: with several tenants the user always picks.
export type TenantEntry =
  | { outcome: "enterTenant"; tenantId: string }
  | { outcome: "chooseTenant" }
  | { outcome: "noTenant" };

export interface AccountTenants {
  entry: TenantEntry;
  tenants: AccountTenant[];
}

// Read-only views of the caller's own account. Nothing here needs, or
// accepts, a selected tenant.
@Injectable()
export class AccountService {
  constructor(
    @Inject(MembershipsService)
    private readonly memberships: MembershipsService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
  ) {}

  profile(user: UserDoc): AccountProfile {
    return {
      id: toWireId(user._id),
      email: user.email,
      name: user.name,
      ...(user.picture ? { picture: user.picture } : {}),
    };
  }

  // Active memberships in active, fully provisioned tenants, oldest first.
  // Removed memberships and disabled or pending tenants are left out.
  async tenantsOf(userId: ObjectId): Promise<AccountTenants> {
    const memberships = await this.memberships.listActiveForUser(userId);
    const usable = await this.tenants.findUsableByIds(
      memberships.map((membership) => membership.tenantId),
    );
    const byId = new Map(
      usable.map((tenant) => [toWireId(tenant._id), tenant]),
    );
    const tenants = memberships.flatMap((membership): AccountTenant[] => {
      const tenant = byId.get(toWireId(membership.tenantId));
      return tenant
        ? [
            {
              id: toWireId(tenant._id),
              name: tenant.name,
              role: membership.role,
            },
          ]
        : [];
    });
    return { entry: entryFor(tenants), tenants };
  }
}

function entryFor(tenants: AccountTenant[]): TenantEntry {
  if (tenants.length === 0) return { outcome: "noTenant" };
  if (tenants.length > 1) return { outcome: "chooseTenant" };
  return { outcome: "enterTenant", tenantId: tenants[0]!.id };
}
