import {
  createParamDecorator,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { Request, Response } from "express";
import {
  InvalidSessionError,
  SessionsService,
  type AuthenticatedCaller,
  type TokenCaller,
} from "../../modules/sessions/sessions.service";
import { ApiError } from "../http/api-error";
import { timed } from "../http/server-timing";

// RFC 6750 section 2.1: the scheme is case-insensitive, the token is not.
// Tokens are read only from this header, never from the query or body.
const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;

export function bearerTokenOf(req: Request): string | undefined {
  return BEARER.exec(req.get("authorization") ?? "")?.[1];
}

// Runs one way of checking the request's access token. Every failure is the
// same 401: there is no other way in and no fallback.
async function withBearerToken<T>(
  req: Request,
  res: Response,
  check: (token: string | undefined) => Promise<T>,
): Promise<T> {
  // Responses to authenticated requests are private to the caller.
  res.setHeader("Cache-Control", "no-store");
  try {
    return await timed("auth", () => check(bearerTokenOf(req)));
  } catch (error) {
    if (error instanceof InvalidSessionError) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="truex"');
      throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
    }
    throw error;
  }
}

// Verifies the request's access token, its live session and active account,
// and records the caller for @Caller(). For the account routes the app opens
// with, where a logout or disabled account must be seen at once.
export async function authenticateRequest(
  sessions: SessionsService,
  req: Request,
  res: Response,
): Promise<AuthenticatedCaller> {
  const caller = await withBearerToken(req, res, (token) =>
    sessions.authenticate(token),
  );
  res.locals.caller = caller;
  return caller;
}

// Verifies the request's access token by signature alone, without MongoDB.
// For tenant routes, which run on every message; see verifyToken for what a
// token of up to ACCESS_TOKEN_TTL_SECONDS can miss. Not recorded for
// @Caller(): those routes read the tenant context instead.
export function verifyRequestToken(
  sessions: SessionsService,
  req: Request,
  res: Response,
): Promise<TokenCaller> {
  return withBearerToken(req, res, async (token) =>
    sessions.verifyToken(token),
  );
}

// For user-only routes: a signed-in caller, no tenant.
@Injectable()
export class AuthenticatedGuard implements CanActivate {
  constructor(
    @Inject(SessionsService) private readonly sessions: SessionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    await authenticateRequest(
      this.sessions,
      http.getRequest<Request>(),
      http.getResponse<Response>(),
    );
    return true;
  }
}

// The caller AuthenticatedGuard verified for this request.
export const Caller = createParamDecorator(
  (_: unknown, context: ExecutionContext): AuthenticatedCaller => {
    const caller = context.switchToHttp().getResponse<Response>().locals
      .caller as AuthenticatedCaller | undefined;
    // A route that reads the caller without the guard is a programming error.
    if (!caller) throw new Error("Route is missing AuthenticatedGuard.");
    return caller;
  },
);
