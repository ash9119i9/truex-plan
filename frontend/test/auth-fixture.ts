// A signed-in tab for tests of code that sends requests through lib/auth.ts.
import { auth as defaultAuth, type Auth } from "../lib/auth.ts";
import { setIdentityScope } from "../lib/identity.ts";

export const USER_ID = "64b7f0c2a1b2c3d4e5f60718";
export const TENANT_ID = "64b7f0c2a1b2c3d4e5f60719";
export const OTHER_USER_ID = "64b7f0c2a1b2c3d4e5f6071a";

/** The platform's answer to POST /api/v1/auth/refresh. */
export const refreshed = (
  accessToken = "token-1",
  userId = USER_ID,
  lifetimeMs = 10 * 60_000,
  headers: HeadersInit = {},
) =>
  Response.json(
    {
      userId,
      accessToken,
      accessTokenExpiresAt: new Date(Date.now() + lifetimeMs).toISOString(),
    },
    { headers },
  );

/** Gives the tab an access token and opens the test tenant in it. */
export async function signInForTest(session: Auth = defaultAuth) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => refreshed()) as typeof fetch;
  try {
    const result = await session.accessToken();
    if (result.kind !== "ok") throw new Error("test sign-in failed");
  } finally {
    globalThis.fetch = original;
  }
  setIdentityScope(USER_ID, TENANT_ID);
}
