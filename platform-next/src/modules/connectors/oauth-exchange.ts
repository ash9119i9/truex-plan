import type { ConnectorRevoke } from "./connector";
import type { FetchLike } from "./oauth-discovery";
import type { ConnectorTokens } from "./token-crypto";

// What a token endpoint granted: the tokens, and how long each lasts when the
// provider says (GitHub App user tokens: 8 h access, 6 months refresh).
export interface TokenGrant {
  tokens: ConnectorTokens;
  accessExpiresInSec?: number;
  refreshExpiresInSec?: number;
  // The scopes the provider says it granted, when it says. Providers with
  // granular consent (Google) let the user untick some of them.
  grantedScopes?: string[];
}

// Exchanges an authorization code for tokens at the discovered token endpoint,
// and revokes a grant at the provider. GitHub returns form-encoded bodies and
// reports errors with HTTP 200 unless Accept: application/json is sent, and
// even then can put an `error` field in a 200 body, so both are handled.
// Values and provider error text never leak into logs or thrown messages.

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

// The exchange failed: the code was refused, replayed, or the body had no
// access token. A fixed reason; no provider text.
export class ExchangeFailedError extends Error {
  constructor() {
    super("the authorization code could not be exchanged");
    this.name = "ExchangeFailedError";
  }
}

// The token endpoint could not be reached in time or failed with 5xx.
export class ExchangeUnavailableError extends Error {
  constructor() {
    super("the token endpoint could not be reached");
    this.name = "ExchangeUnavailableError";
  }
}

export interface ExchangeOptions {
  tokenEndpoint: string;
  code: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: FetchLike;
}

// Parses a token response that may be JSON or form-encoded. Returns the fields
// relevant to the exchange.
function parseTokenBody(
  contentType: string | null,
  text: string,
): Record<string, string> {
  if (contentType?.includes("application/json")) {
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const out: Record<string, string> = {};
        for (const [key, raw] of Object.entries(value))
          if (typeof raw === "string") out[key] = raw;
          else if (typeof raw === "number" && Number.isFinite(raw))
            out[key] = String(raw);
        return out;
      }
    } catch {
      // Fall through to form parsing.
    }
  }
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(text)) out[key] = value;
  return out;
}

export async function exchangeCode(
  options: ExchangeOptions,
): Promise<TokenGrant> {
  return tokenRequest(options.tokenEndpoint, options.fetchImpl, {
    grant_type: "authorization_code",
    code: options.code,
    code_verifier: options.codeVerifier,
    client_id: options.clientId,
    client_secret: options.clientSecret,
    redirect_uri: options.redirectUri,
  });
}

export interface RefreshOptions {
  tokenEndpoint: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: FetchLike;
}

// Trades a refresh token for a new grant. Providers that rotate refresh
// tokens (GitHub does) invalidate the old one, so the caller must store the
// result before anyone else refreshes. A refusal (invalid_grant, GitHub's
// bad_refresh_token in a 200 body) is ExchangeFailedError: the user has to
// reconnect. A network or 5xx failure is ExchangeUnavailableError.
export async function refreshGrant(
  options: RefreshOptions,
): Promise<TokenGrant> {
  return tokenRequest(options.tokenEndpoint, options.fetchImpl, {
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
    client_id: options.clientId,
    client_secret: options.clientSecret,
  });
}

// A lifetime in seconds from a token response, or undefined when absent or
// not a sane positive integer.
function seconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,10}$/.test(value)) return undefined;
  const n = Number(value);
  return n > 0 ? n : undefined;
}

async function tokenRequest(
  tokenEndpoint: string,
  fetchImpl: FetchLike = fetch,
  form: Record<string, string>,
): Promise<TokenGrant> {
  let res: Response;
  try {
    res = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(form),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ExchangeUnavailableError();
  }
  if (res.status >= 500) throw new ExchangeUnavailableError();
  let bytes: ArrayBuffer;
  try {
    bytes = await res.arrayBuffer();
  } catch {
    throw new ExchangeUnavailableError();
  }
  if (bytes.byteLength > MAX_RESPONSE_BYTES)
    throw new ExchangeUnavailableError();
  const text = Buffer.from(bytes).toString("utf8");
  const body = parseTokenBody(res.headers.get("content-type"), text);
  // GitHub can report an error with HTTP 200; treat an error field, a non-200
  // status, or a missing access token all as a refusal.
  if (res.status !== 200 || body.error || !body.access_token)
    throw new ExchangeFailedError();
  const tokens: ConnectorTokens = { accessToken: body.access_token };
  if (body.refresh_token) tokens.refreshToken = body.refresh_token;
  const grant: TokenGrant = { tokens };
  const access = seconds(body.expires_in);
  if (access !== undefined) grant.accessExpiresInSec = access;
  const refresh = seconds(body.refresh_token_expires_in);
  if (refresh !== undefined) grant.refreshExpiresInSec = refresh;
  // RFC 6749 separates scopes with spaces; GitHub uses commas.
  if (body.scope !== undefined)
    grant.grantedScopes = body.scope.split(/[\s,]+/).filter(Boolean);
  return grant;
}

export interface RevokeOptions {
  revoke: ConnectorRevoke;
  accessToken: string;
  // Revoked instead of the access token under rfc7009 when present: revoking
  // the refresh token ends the whole grant (RFC 7009 §2.1; Google does this),
  // and it still works after the access token has expired.
  refreshToken?: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: FetchLike;
}

// Revokes a grant at the provider. Returns whether revocation succeeded; a
// failure is reported to the caller (which logs a warning with a safe code and
// deletes the record anyway), never thrown. The revoke URL comes from the
// catalog, so no provider URL is in code.
export async function revokeGrant(options: RevokeOptions): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const basic = Buffer.from(
    `${options.clientId}:${options.clientSecret}`,
    "utf8",
  ).toString("base64");
  try {
    if (options.revoke.kind === "github_app_grant") {
      // DELETE {client_id}-substituted URL, Basic auth, JSON { access_token }.
      // The catalog stores the URL normalised, which percent-encodes the
      // braces, so both spellings of the placeholder are substituted.
      const url = options.revoke.url.replace(
        /\{client_id\}|%7Bclient_id%7D/i,
        encodeURIComponent(options.clientId),
      );
      const res = await fetchImpl(url, {
        method: "DELETE",
        headers: {
          authorization: `Basic ${basic}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ access_token: options.accessToken }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // 204 is success; GitHub returns 404 when the grant is already gone,
      // which is also fine for our purpose (access is stopped).
      return res.status === 204 || res.status === 404;
    }
    // RFC 7009: POST token=<refresh or access token> to the revocation
    // endpoint. Only 200 counts: Google answers 400 invalid_token for a token
    // it no longer knows, which cannot prove the grant is gone.
    const body = options.refreshToken
      ? { token: options.refreshToken, token_type_hint: "refresh_token" }
      : { token: options.accessToken, token_type_hint: "access_token" };
    const res = await fetchImpl(options.revoke.url, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}
