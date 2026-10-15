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
import { SessionsService } from "../../modules/sessions/sessions.service";
import type { TenantDoc } from "../../modules/tenants/tenant";
import { TenantsService } from "../../modules/tenants/tenants.service";
import { ApiError } from "../http/api-error";
import { requestIdOf } from "../http/request-id";
import { authenticateRequest } from "./authenticated.guard";

export const TENANT_QUERY_PARAM = "tenantId";

// Who is acting, in which tenant, with which role, all from current catalog
// state. Built fresh for every request and frozen, so concurrent requests
// (other tabs, other tenants) never share or change each other's context.
export interface TenantContext {
  readonly userId: ObjectId;
  readonly tenantId: ObjectId;
  readonly role: Role;
  // The registry record: public metadata and the server-controlled database.
  readonly tenant: Readonly<Pick<TenantDoc, "name" | "kind" | "dbName">>;
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

const NO_ACCESS = "You do not have access to this tenant.";

// For tenant routes. Authenticates the caller, then requires exactly one
// ?tenantId= naming a usable tenant where the caller has an active
// membership. The role comes only from that membership. A tenant that does
// not exist, is disabled or still provisioning, or that the caller is not
// (or no longer) a member of all get the same 403, so a response never
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
    const caller = await authenticateRequest(this.sessions, req, res);

    const tenantId = tenantIdOf(req);
    if (!tenantId)
      throw new ApiError(
        400,
        "BAD_REQUEST",
        "Add exactly one tenantId query parameter naming a tenant.",
      );

    const [membership, tenant] = await Promise.all([
      this.memberships.findActive(caller.userId, tenantId),
      this.tenants.findUsable(tenantId),
    ]);
    if (!membership || !tenant) {
      this.logger.warn({
        message: "tenant access denied",
        requestId: requestIdOf(res),
        userId: caller.userId.toHexString(),
        tenantId: tenantId.toHexString(),
        reason: !tenant ? "tenant_unavailable" : "not_a_member",
      });
      throw new ApiError(403, "FORBIDDEN", NO_ACCESS);
    }

    const tenantContext: TenantContext = Object.freeze({
      userId: caller.userId,
      tenantId: tenant._id,
      role: membership.role,
      tenant: Object.freeze({
        name: tenant.name,
        kind: tenant.kind,
        dbName: tenant.dbName,
      }),
    });
    res.locals.tenantContext = tenantContext;
    return true;
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
