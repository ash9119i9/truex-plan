import { Inject, Injectable } from "@nestjs/common";
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { APP_CONFIG, type AppConfig } from "../../config/app-config";
import type { VerifiedIdentity } from "../users/user";

// Google's half of sign-in: exchange the authorization code for an ID token
// and verify that token (OpenID Connect Core 3.1.3.7). The token comes
// straight from Google over TLS, but it is still verified in full so a
// misrouted or replayed token cannot sign anyone in.

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_ID_TOKEN_LENGTH = 8 * 1024;
const CLOCK_SKEW_SECONDS = 60;
// Google publishes how long its keys may be cached; stay within these bounds.
const KEYS_MIN_TTL_MS = 5 * 60_000;
const KEYS_MAX_TTL_MS = 24 * 60 * 60_000;
// An unknown key ID triggers a refetch (Google rotated), at most this often.
const KEYS_REFETCH_MIN_MS = 30_000;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

// Google refused, or answered with something that cannot be trusted. Starting
// sign-in again is the only recovery.
export class GoogleRejectedError extends Error {
  constructor(detail: string) {
    super(`Google sign-in was rejected: ${detail}`);
    this.name = "GoogleRejectedError";
  }
}

// Google could not be reached in time or failed on its side. Retryable.
export class GoogleUnavailableError extends Error {
  constructor() {
    super("Google could not be reached.");
    this.name = "GoogleUnavailableError";
  }
}

interface JsonResponse {
  status: number;
  body: unknown;
  cacheControl: string | null;
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<JsonResponse> {
  try {
    const res = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_RESPONSE_BYTES)
      throw new GoogleUnavailableError();
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      body = undefined;
    }
    return {
      status: res.status,
      body,
      cacheControl: res.headers.get("cache-control"),
    };
  } catch (error) {
    if (error instanceof GoogleUnavailableError) throw error;
    throw new GoogleUnavailableError();
  }
}

function decodeJson(segment: string): Record<string, unknown> | undefined {
  if (!SEGMENT.test(segment)) return undefined;
  try {
    const value: unknown = JSON.parse(
      Buffer.from(segment, "base64url").toString("utf8"),
    );
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

interface KeySet {
  keys: Map<string, KeyObject>;
  fetchedAt: number;
  expiresAt: number;
}

@Injectable()
export class GoogleOidcClient {
  private keySet?: KeySet;
  private keyFetch?: Promise<KeySet>;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  // Redeems a one-time authorization code. A used, expired or foreign code
  // is a rejection; network and 5xx failures are an outage.
  async exchangeCode(code: string, codeVerifier: string): Promise<string> {
    const google = this.config.google;
    const res = await fetchJson(google.endpoints.token, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        client_id: google.clientId,
        client_secret: google.clientSecret,
        redirect_uri: google.redirectUri,
      }),
    });
    if (res.status >= 500) throw new GoogleUnavailableError();
    if (res.status !== 200) throw new GoogleRejectedError("code exchange");
    const idToken =
      typeof res.body === "object" && res.body !== null
        ? (res.body as { id_token?: unknown }).id_token
        : undefined;
    if (typeof idToken !== "string")
      throw new GoogleRejectedError("no ID token");
    return idToken;
  }

  async verifyIdToken(
    idToken: string,
    expectedNonce: string,
    now: Date = new Date(),
  ): Promise<VerifiedIdentity> {
    const google = this.config.google;
    if (idToken.length > MAX_ID_TOKEN_LENGTH)
      throw new GoogleRejectedError("token too long");
    const parts = idToken.split(".");
    if (parts.length !== 3) throw new GoogleRejectedError("malformed token");
    const [headerPart, payloadPart, signaturePart] = parts as [
      string,
      string,
      string,
    ];

    const header = decodeJson(headerPart);
    if (header?.alg !== "RS256" || typeof header.kid !== "string")
      throw new GoogleRejectedError("unexpected algorithm");
    if (header.typ !== undefined && header.typ !== "JWT")
      throw new GoogleRejectedError("unexpected type");
    if (!SEGMENT.test(signaturePart))
      throw new GoogleRejectedError("malformed signature");
    const key = await this.keyFor(header.kid, now);
    const signed = verify(
      "sha256",
      Buffer.from(`${headerPart}.${payloadPart}`),
      key,
      Buffer.from(signaturePart, "base64url"),
    );
    if (!signed) throw new GoogleRejectedError("bad signature");

    const claims = decodeJson(payloadPart);
    if (!claims) throw new GoogleRejectedError("malformed claims");
    if (
      typeof claims.iss !== "string" ||
      !google.endpoints.issuers.includes(claims.iss)
    )
      throw new GoogleRejectedError("issuer");
    if (claims.aud !== google.clientId)
      throw new GoogleRejectedError("audience");
    if (claims.azp !== undefined && claims.azp !== google.clientId)
      throw new GoogleRejectedError("authorized party");
    if (claims.nonce !== expectedNonce) throw new GoogleRejectedError("nonce");

    const nowSeconds = Math.floor(now.getTime() / 1000);
    const { exp, iat } = claims;
    if (
      typeof exp !== "number" ||
      typeof iat !== "number" ||
      exp + CLOCK_SKEW_SECONDS <= nowSeconds ||
      iat > nowSeconds + CLOCK_SKEW_SECONDS
    )
      throw new GoogleRejectedError("expired");

    if (typeof claims.sub !== "string" || typeof claims.email !== "string")
      throw new GoogleRejectedError("missing subject or email");
    if (claims.email_verified !== true)
      throw new GoogleRejectedError("email not verified");

    const name = optionalString(claims.name);
    const picture = optionalString(claims.picture);
    return {
      provider: "google",
      subject: claims.sub,
      email: claims.email,
      emailVerified: true,
      ...(name ? { name } : {}),
      ...(picture ? { picture } : {}),
    };
  }

  private async keyFor(kid: string, now: Date): Promise<KeyObject> {
    const at = now.getTime();
    let set = this.keySet;
    const stale = !set || set.expiresAt <= at;
    const unknownKid = set !== undefined && !set.keys.has(kid);
    if (
      stale ||
      (unknownKid && at - (set?.fetchedAt ?? 0) >= KEYS_REFETCH_MIN_MS)
    )
      set = await this.refreshKeys(at);
    const key = set?.keys.get(kid);
    if (!key) throw new GoogleRejectedError("unknown signing key");
    return key;
  }

  // Concurrent sign-ins share one fetch.
  private refreshKeys(at: number): Promise<KeySet> {
    this.keyFetch ??= this.fetchKeys(at)
      .then((set) => {
        this.keySet = set;
        return set;
      })
      .finally(() => {
        this.keyFetch = undefined;
      });
    return this.keyFetch;
  }

  private async fetchKeys(at: number): Promise<KeySet> {
    const res = await fetchJson(this.config.google.endpoints.jwks, {
      headers: { accept: "application/json" },
    });
    const list =
      res.status === 200 && typeof res.body === "object" && res.body !== null
        ? (res.body as { keys?: unknown }).keys
        : undefined;
    if (!Array.isArray(list)) throw new GoogleUnavailableError();

    const keys = new Map<string, KeyObject>();
    for (const jwk of list as Record<string, unknown>[]) {
      if (
        typeof jwk !== "object" ||
        jwk === null ||
        jwk.kty !== "RSA" ||
        typeof jwk.kid !== "string" ||
        (jwk.alg !== undefined && jwk.alg !== "RS256") ||
        (jwk.use !== undefined && jwk.use !== "sig")
      )
        continue;
      try {
        keys.set(
          jwk.kid,
          createPublicKey({
            key: { kty: "RSA", n: String(jwk.n), e: String(jwk.e) },
            format: "jwk",
          }),
        );
      } catch {
        // Skip a key that does not parse; the others still work.
      }
    }
    if (keys.size === 0) throw new GoogleUnavailableError();

    const maxAge = /max-age=(\d+)/.exec(res.cacheControl ?? "");
    const ttl = Math.min(
      KEYS_MAX_TTL_MS,
      Math.max(KEYS_MIN_TTL_MS, maxAge ? Number(maxAge[1]) * 1000 : 0),
    );
    return { keys, fetchedAt: at, expiresAt: at + ttl };
  }
}
