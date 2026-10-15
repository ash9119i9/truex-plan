import { Controller, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { ApiError } from "../../common/http/api-error";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import { toWireId } from "../../database/object-id";
import {
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from "./refresh-cookie";
import {
  InvalidSessionError,
  RefreshRaceError,
  SessionsService,
} from "./sessions.service";

export interface RefreshResponse {
  userId: string;
  accessToken: string;
  accessTokenExpiresAt: string;
}

// Cookie-authenticated endpoints. Browsers attach the refresh cookie on their
// own, so each request must come from an allowed origin (CSRF protection on
// top of SameSite=Strict).
@Controller("auth")
export class SessionsController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {}

  @Post("refresh")
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RefreshResponse> {
    const auth = this.config.auth;
    this.requireAllowedOrigin(req);
    res.setHeader("Cache-Control", "no-store");
    try {
      const issued = await this.sessions.refresh(readRefreshCookie(req, auth));
      setRefreshCookie(
        res,
        auth,
        issued.refreshCredential,
        issued.refreshExpiresAt,
      );
      return {
        userId: toWireId(issued.userId),
        accessToken: issued.accessToken,
        accessTokenExpiresAt: issued.accessTokenExpiresAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof InvalidSessionError) {
        clearRefreshCookie(res, auth);
        throw new ApiError(
          401,
          "UNAUTHENTICATED",
          "Your session has ended. Sign in again.",
        );
      }
      if (error instanceof RefreshRaceError)
        throw new ApiError(
          409,
          "CONFLICT",
          "The session was refreshed in another tab. Retry the request.",
        );
      throw error;
    }
  }

  @Post("logout")
  @HttpCode(204)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    this.requireAllowedOrigin(req);
    res.setHeader("Cache-Control", "no-store");
    await this.sessions.logout(readRefreshCookie(req, this.config.auth));
    clearRefreshCookie(res, this.config.auth);
  }

  private requireAllowedOrigin(req: Request): void {
    const origin = req.get("origin");
    if (!origin || !this.config.auth.allowedOrigins.includes(origin))
      throw new ApiError(
        403,
        "FORBIDDEN",
        "This request must come from the Truex app.",
      );
  }
}
