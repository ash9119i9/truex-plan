import {
  Controller,
  Get,
  Inject,
  Logger,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import { isDatabaseUnavailableError } from "../../database/mongo-errors";
import {
  readRefreshCookie,
  setRefreshCookie,
} from "../sessions/refresh-cookie";
import { SessionsService } from "../sessions/sessions.service";
import { AuthService, SignInError, type SignInFailure } from "./auth.service";
import {
  checkOAuthFlow,
  clearOAuthFlowCookie,
  codeChallengeOf,
  newOAuthFlow,
  setOAuthFlowCookie,
} from "./oauth-flow";

const MAX_CODE_LENGTH = 2048;

// Browser-navigation endpoints: they answer with redirects, never JSON, and
// redirect only to fixed paths on the app's own origin. The access token is
// never put in a URL: the frontend's /auth/complete page calls
// POST /auth/refresh with the cookie set here.
@Controller("auth/google")
export class GoogleAuthController {
  private readonly logger = new Logger("Auth");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {}

  @Get()
  start(@Res() res: Response): void {
    const google = this.config.google;
    const flow = newOAuthFlow();
    setOAuthFlowCookie(res, this.config.auth, flow);
    const url = new URL(google.endpoints.authorization);
    url.search = new URLSearchParams({
      client_id: google.clientId,
      redirect_uri: google.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: codeChallengeOf(flow),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, url.href);
  }

  @Get("callback")
  async callback(
    @Req() req: Request,
    @Res() res: Response,
    @Query("state") state: unknown,
    @Query("code") code: unknown,
    @Query("error") error: unknown,
  ): Promise<void> {
    const authConfig = this.config.auth;
    res.setHeader("Cache-Control", "no-store");
    // One attempt, one callback: the flow cookie is spent either way.
    clearOAuthFlowCookie(res, authConfig);

    const check = checkOAuthFlow(req, authConfig, state);
    if (!check.ok) return this.fail(res, "expired");
    if (error !== undefined)
      return this.fail(
        res,
        error === "access_denied" ? "cancelled" : "rejected",
      );
    if (
      typeof code !== "string" ||
      code.length === 0 ||
      code.length > MAX_CODE_LENGTH
    )
      return this.fail(res, "rejected");

    try {
      // A session already on this browser is replaced, not left orphaned.
      const previous = readRefreshCookie(req, authConfig);
      const signedIn = await this.auth.signInWithGoogle(
        code,
        check.flow.codeVerifier,
        check.flow.nonce,
      );
      if (previous) await this.sessions.logout(previous);
      setRefreshCookie(
        res,
        authConfig,
        signedIn.session.refreshCredential,
        signedIn.session.refreshExpiresAt,
      );
      res.redirect(303, this.appUrl("/auth/complete"));
    } catch (failure) {
      if (failure instanceof SignInError)
        return this.fail(res, failure.failure);
      if (isDatabaseUnavailableError(failure))
        return this.fail(res, "unavailable");
      this.logger.error(
        { message: "google sign-in failed", requestId: res.locals.requestId },
        failure instanceof Error ? failure.stack : String(failure),
      );
      return this.fail(res, "unavailable");
    }
  }

  private fail(res: Response, failure: SignInFailure): void {
    res.redirect(303, this.appUrl(`/login?error=${failure}`));
  }

  // The app's origin is the redirect URI's origin, fixed in configuration.
  private appUrl(path: string): string {
    return new URL(path, new URL(this.config.google.redirectUri).origin).href;
  }
}
