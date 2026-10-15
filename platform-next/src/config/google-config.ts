import { parseOrigin, requiredText } from "./auth-config";

// Google sign-in settings. The endpoints are fixed in code, not read from the
// environment, so configuration can never point sign-in at another server.

export interface GoogleEndpoints {
  readonly authorization: string;
  readonly token: string;
  readonly jwks: string;
  readonly issuers: readonly string[];
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorization: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  jwks: "https://www.googleapis.com/oauth2/v3/certs",
  issuers: ["https://accounts.google.com", "accounts.google.com"],
};

export interface GoogleConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  // Where Google sends the browser back. Its origin is the app's origin, so
  // the session cookie set there belongs to the app.
  readonly redirectUri: string;
  readonly endpoints: GoogleEndpoints;
}

type Env = Readonly<Record<string, string | undefined>>;

const CLIENT_ID = /^[A-Za-z0-9-]{1,150}\.apps\.googleusercontent\.com$/;

export function loadGoogleConfig(
  env: Env,
  // Undefined when the auth settings are themselves invalid, so the origin
  // check does not add a second, misleading problem.
  allowedOrigins: readonly string[] | undefined,
  problems: string[],
): GoogleConfig | undefined {
  const before = problems.length;

  const clientId = env.GOOGLE_CLIENT_ID ?? "";
  if (!clientId) problems.push("GOOGLE_CLIENT_ID is required.");
  else if (!CLIENT_ID.test(clientId))
    problems.push(
      "GOOGLE_CLIENT_ID must be a Google OAuth client ID ending in .apps.googleusercontent.com.",
    );

  // A secret: problems never echo it.
  const clientSecret = requiredText(env, "GOOGLE_CLIENT_SECRET", problems);

  const redirectUri = env.GOOGLE_REDIRECT_URI ?? "";
  if (!redirectUri) problems.push("GOOGLE_REDIRECT_URI is required.");
  else {
    let url: URL | undefined;
    try {
      url = new URL(redirectUri);
    } catch {
      // Reported below.
    }
    if (
      !url ||
      url.href !== redirectUri ||
      url.search ||
      url.hash ||
      !parseOrigin(url.origin)
    )
      problems.push(
        "GOOGLE_REDIRECT_URI must be an absolute https URL (http only for localhost) without query or fragment.",
      );
    else if (allowedOrigins && !allowedOrigins.includes(url.origin))
      problems.push(
        "GOOGLE_REDIRECT_URI must be on one of the AUTH_ALLOWED_ORIGINS.",
      );
  }

  if (problems.length > before || !clientSecret) return undefined;
  return { clientId, clientSecret, redirectUri, endpoints: GOOGLE_ENDPOINTS };
}
