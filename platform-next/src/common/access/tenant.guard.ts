import {
  createParamDecorator,
  Inject,
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { ObjectId } from "mongodb";
import { parseWireId } from "../../database/object-id";
import type { Role } from "../../modules/memberships/membership";
import { MembershipsService } from "../../modules/memberships/memberships.service";
import {
  SessionsService,
  type TokenCaller,
} from "../../modules/sessions/sessions.service";
import { dbNameFor } from "../../modules/tenants/tenant";
import { TenantsService } from "../../modules/tenants/tenants.service";
import { ApiError } from "../http/api-error";
import { requestIdOf } from "../http/request-id";
import { timed } from "../http/server-timing";
import { verifyRequestToken } from "./authenticated.guard";

export const TENANT_QUERY_PARAM = "tenantId";

// Who is acting, in which tenant, with which role. From the access token when
// it was issued for this tenant (at most ACCESS_TOKEN_TTL_SECONDS old),
// otherwise from current catalog state. Built for every request and frozen,
// so concurrent requests (other tabs, other tenants) never share or change
// each other's context. A write that only an admin may make re-reads the
// role rather than trusting this one.
export interface TenantContext {
  readonly userId: ObjectId;
  readonly tenantId: ObjectId;
  readonly role: Role;
  // The tenant's database, chosen by the server, never by request data.
  readonly dbName: string;
}

// The one tenantId from the raw query string, or null when it is missing,
// repeated, empty, not a canonical ID, or sent in an object/array form such
// as tenantId[]= or tenantId[x]=. The raw URL is read rather than req.query
// so the result never depends on the configured query parser.
export function tenantIdOf(req: Request): ObjectId | null {
  const params = new URL(req.originalUrl, "http://localhost").searchParams;
  const values: string[] = [];
  for (const [key, value] of params)
    if (key === TENANT_QUERY_PARAM) values.push(value);
    else if (key.startsWith(`${TENANT_QUERY_PARAM}[`)) return null;
  return values.length === 1 ? parseWireId(values[0]) : null;
}

// For requests where naming a tenant is optional: undefined when there is no
// tenantId parameter in any form, otherwise what tenantIdOf says.
export function optionalTenantIdOf(req: Request): ObjectId | null | undefined {
  const params = new URL(req.originalUrl, "http://localhost").searchParams;
  for (const key of params.keys())
    if (key === TENANT_QUERY_PARAM || key.startsWith(`${TENANT_QUERY_PARAM}[`))
      return tenantIdOf(req);
  return undefined;
}

export const NO_TENANT_ACCESS = "You do not have access to this tenant.";

// For tenant routes. Authenticates the caller, then requires exactly one
// ?tenantId= naming a usable tenant where the caller has an active
// membership. When the token was issued for that tenant, its signed tenant
// and role decide with no database read. Otherwise (a token from before
// tenant claims, issued for another tenant, or for none because the caller
// was not a member then) the membership and tenant are read now. A tenant
// that does not exist, is disabled or still provisioning, or that the caller
// is not (or no longer) a member of all get the same 403, so a response never
// reveals whether some other tenant exists.
@Injectable()
export class TenantGuard implements CanActivate {
  private readonly logger = new Logger("TenantAccess");

  constructor(
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(MembershipsService)
    private readonly memberships: MembershipsService,
    @Inject(TenantsService) private readonly tenants: TenantsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    // Authentication first: an anonymous caller learns nothing more.
    const caller = await verifyRequestToken(this.sessions, req, res);

    const tenantId = tenantIdOf(req);
    if (!tenantId)
      throw new ApiError(
        400,
        "BAD_REQUEST",
        "Add exactly one tenantId query parameter naming a tenant.",
      );

    const fromToken = caller.tenant?.tenantId.equals(tenantId)
      ? caller.tenant
      : undefined;
    const tenantContext: TenantContext = Object.freeze(
      fromToken
        ? {
            userId: caller.userId,
            tenantId,
            role: fromToken.role,
            dbName: dbNameFor(fromToken.kind, tenantId),
          }
        : await this.fromCatalog(caller, tenantId, res),
    );
    res.locals.tenantContext = tenantContext;
    return true;
  }

  private async fromCatalog(
    caller: TokenCaller,
    tenantId: ObjectId,
    res: Response,
  ): Promise<TenantContext> {
    const [membership, tenant] = await timed("access", () =>
      Promise.all([
        this.memberships.findActive(caller.userId, tenantId),
        this.tenants.findUsable(tenantId),
      ]),
    );
    if (!membership || !tenant) {
      this.logger.warn({
        message: "tenant access denied",
        requestId: requestIdOf(res),
        userId: caller.userId.toHexString(),
        tenantId: tenantId.toHexString(),
        reason: !tenant ? "tenant_unavailable" : "not_a_member",
      });
      throw new ApiError(403, "FORBIDDEN", NO_TENANT_ACCESS);
    }
    return {
      userId: caller.userId,
      tenantId: tenant._id,
      role: membership.role,
      dbName: tenant.dbName,
    };
  }
}

// The tenant context TenantGuard verified for this request.
export const CurrentTenant = createParamDecorator(
  (_: unknown, context: ExecutionContext): TenantContext => {
    const tenantContext = context.switchToHttp().getResponse<Response>().locals
      .tenantContext as TenantContext | undefined;
    // A route that reads the tenant without the guard is a programming error.
    if (!tenantContext) throw new Error("Route is missing TenantGuard.");
    return tenantContext;
  },
);
