import {
  Controller,
  Delete,
  Get,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ObjectId } from "mongodb";
import {
  CurrentTenant,
  TenantGuard,
  type TenantContext,
} from "../../common/access/tenant.guard";
import { DomainErrorsInterceptor } from "../../common/http/domain-errors.interceptor";
import { API_PREFIX } from "../../common/http/api-prefix";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import { AuditService } from "../audit/audit.service";
import { connectorView, type ConnectorView } from "./connector";
import {
  CONNECTOR_FLOW_TTL_SECONDS,
  clearConnectorFlowCookie,
  readConnectorFlow,
  setConnectorFlowCookie,
  stateMatches,
  type ConnectorFlow,
} from "./connector-oauth-flow";
import type { ConnectionView } from "./connection";
import {
  ConnectorsService,
  type CallbackErrorCode,
} from "./connectors.service";

// The slug a caller may name: the connector slug pattern.
const SLUG = /^[a-z][a-z0-9_]{1,30}$/;
const MAX_CODE_LENGTH = 2048;
// The server-side path the callback is served from, and the cookie is scoped
// to. The frontend forwards /api/* to this.
const CALLBACK_PATH = `/${API_PREFIX}/connectors/callback`;

interface ConnectorListItem extends ConnectorView {
  connection: ConnectionView;
}

// Directory-connector routes. The tenant routes authenticate with a bearer
// token and ?tenantId= (TenantGuard); the callback authenticates with the
// sealed flow cookie alone, so a plain browser navigation cannot start a
// sign-in. Every route first checks the feature is configured.
@Controller("connectors")
export class ConnectorsController {
  private readonly logger = new Logger("Connectors");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private get cookieSecure(): boolean {
    return this.config.auth.cookieSecure;
  }

  // The frontend origin the callback redirects to: the redirect URI's origin.
  private redirectOrigin(): string {
    return new URL(this.config.connectors!.redirectUri).origin;
  }

  @Get()
  @UseGuards(TenantGuard)
  @UseInterceptors(DomainErrorsInterceptor)
  async list(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<{ connectors: ConnectorListItem[] }> {
    const merged = await this.connectors.listForUser(
      tenant.tenantId,
      tenant.userId,
      tenant.dbName,
    );
    return {
      connectors: merged.map(({ connector, connection }) => ({
        ...connectorView(connector),
        connection,
      })),
    };
  }

  // Returns the authorize URL and sets the sealed flow cookie; the browser
  // then navigates to the URL itself.
  @Post(":slug/connect")
  @UseGuards(TenantGuard)
  @UseInterceptors(DomainErrorsInterceptor)
  async connect(
    @CurrentTenant() tenant: TenantContext,
    @Param("slug") slug: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ authorizeUrl: string }> {
    const start = await this.connectors.startConnect(
      slugOf(slug),
      tenant.tenantId,
      tenant.userId,
      tenant.dbName,
    );
    setConnectorFlowCookie(
      res,
      this.cookieSecure,
      CALLBACK_PATH,
      start.sealedCookie,
    );
    res.setHeader("Cache-Control", "no-store");
    return { authorizeUrl: start.authorizeUrl };
  }

  // Finishes a sign-in. Authenticated by the sealed cookie only; answers with
  // a redirect, never JSON. Every exit clears the one-time cookie.
  @Get("callback")
  async callback(
    @Req() req: Request,
    @Res() res: Response,
    @Query("state") state: unknown,
    @Query("code") code: unknown,
    @Query("iss") iss: unknown,
    @Query("error") error: unknown,
  ): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    const secure = this.cookieSecure;
    // One attempt, one callback: the cookie is spent either way.
    clearConnectorFlowCookie(res, secure, CALLBACK_PATH);

    if (!this.connectors.enabled) return this.fail(res, "unavailable");

    const flow = readConnectorFlow(req, this.config.connectors!, secure);
    if (!flow) return this.fail(res, "state_invalid");
    // The slug for the redirect is only trustworthy once the cookie is open.
    const connectorId = flow.connectorId;

    // The provider reported the user cancelled or an error. A declared
    // access_denied is a cancel; anything else is a generic failure.
    if (error !== undefined) {
      const code2: CallbackErrorCode =
        error === "access_denied" ? "cancelled" : "exchange_failed";
      return this.failForFlow(res, flow, code2);
    }

    if (!stateMatches(flow.state, state))
      return this.failForFlow(res, flow, "state_invalid");
    const age = Math.floor(Date.now() / 1000) - flow.startedAt;
    if (age < 0 || age > CONNECTOR_FLOW_TTL_SECONDS)
      return this.failForFlow(res, flow, "expired");
    if (
      typeof code !== "string" ||
      code.length === 0 ||
      code.length > MAX_CODE_LENGTH
    )
      return this.failForFlow(res, flow, "exchange_failed");

    try {
      // Re-check the user is still an active member of the tenant.
      const tenantId = ObjectId.createFromHexString(flow.tenantId);
      const userId = ObjectId.createFromHexString(flow.userId);
      if (!(await this.connectors.isActiveMember(tenantId, userId)))
        return this.failForFlow(res, flow, "not_member");

      // iss, when the authorization server advertises it. When the AS requires
      // the parameter (RFC 9207), its absence is a mismatch.
      const endpoints = await this.connectors.callbackEndpoints(
        ObjectId.createFromHexString(connectorId),
      );
      if (!endpoints) return this.failForFlow(res, flow, "unavailable");
      if (endpoints.issParameterSupported && iss === undefined)
        return this.failForFlow(res, flow, "state_invalid");
      if (iss !== undefined && iss !== endpoints.issuer)
        return this.failForFlow(res, flow, "state_invalid");

      const result = await this.connectors.completeConnect({ flow, code });
      if (!result.ok) return this.failForFlow(res, flow, result.code);

      await this.audit.record({
        action: "connector.connected",
        actor: { kind: "user", userId },
        result: "success",
        tenantId,
        targetUserId: userId,
        details: { slug: result.slug, status: result.status },
      });
      return this.redirect(
        res,
        `${toolsPath(flow)}?connected=${encodeURIComponent(result.slug)}`,
      );
    } catch (failure) {
      this.logger.error(
        {
          message: "connector callback failed",
          requestId: res.locals.requestId,
        },
        failure instanceof Error ? failure.stack : String(failure),
      );
      return this.failForFlow(res, flow, "unavailable");
    }
  }

  @Post(":slug/connection/verify")
  @UseGuards(TenantGuard)
  @UseInterceptors(DomainErrorsInterceptor)
  async verify(
    @CurrentTenant() tenant: TenantContext,
    @Param("slug") slug: string,
  ): Promise<{ connection: ConnectionView }> {
    const connection = await this.connectors.verifyStored(
      slugOf(slug),
      tenant.tenantId,
      tenant.userId,
      tenant.dbName,
    );
    return { connection };
  }

  @Delete(":slug/connection")
  @UseGuards(TenantGuard)
  @UseInterceptors(DomainErrorsInterceptor)
  async disconnect(
    @CurrentTenant() tenant: TenantContext,
    @Param("slug") slug: string,
  ): Promise<{ revoked: boolean }> {
    const resolved = slugOf(slug);
    const result = await this.connectors.disconnect(
      resolved,
      tenant.tenantId,
      tenant.userId,
      tenant.dbName,
    );
    await this.audit.record({
      action: "connector.disconnected",
      actor: { kind: "user", userId: tenant.userId },
      result: "success",
      tenantId: tenant.tenantId,
      targetUserId: tenant.userId,
      details: { slug: resolved, revoked: result.revoked },
    });
    return result;
  }

  // Redirects with the connector slug so the UI can show the result.
  private failForFlow(
    res: Response,
    flow: ConnectorFlow,
    code: CallbackErrorCode,
  ): void {
    this.redirect(
      res,
      `${toolsPath(flow)}?error=${code}&connector=${encodeURIComponent(flow.slug)}`,
    );
  }

  // Without a readable flow there is no workspace to return to; the
  // frontend's /connected-tools page explains and links back.
  private fail(res: Response, code: CallbackErrorCode): void {
    this.redirect(res, `/connected-tools?error=${code}`);
  }

  private redirect(res: Response, path: string): void {
    res.redirect(302, new URL(path, this.redirectOrigin()).href);
  }
}

// The workspace's Connected tools page the sign-in started from.
function toolsPath(flow: ConnectorFlow): string {
  return `/t/${encodeURIComponent(flow.tenantId)}/connected-tools`;
}

function slugOf(slug: string): string {
  if (typeof slug !== "string" || !SLUG.test(slug)) {
    // A bad slug cannot name a connector; the service returns NOT_FOUND.
    return "";
  }
  return slug;
}
