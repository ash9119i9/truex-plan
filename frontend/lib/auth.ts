// The signed-in browser session. The access token lives only in this tab's
// memory and is renewed from the HttpOnly refresh cookie, which script can
// neither read nor write. Nothing here is ever put in a URL or in storage.
//
// Tabs share the refresh cookie, and every refresh rotates it. Refreshes are
// therefore serialized across tabs with a Web Lock; the server's 409 for a
// refresh that lost a race anyway is retried a few times. Signing out in one
// tab ends the session for all of them.

import { bumpIdentityGeneration, notifyUnauthenticated } from "./identity.ts";

export const AUTH_PATHS = {
  google: "/api/v1/auth/google",
  refresh: "/api/v1/auth/refresh",
  logout: "/api/v1/auth/logout",
} as const;

const WIRE_ID = /^[0-9a-f]{24}$/;
const MAX_TOKEN_LENGTH = 4096;
// Renew this long before the server's expiry, so no request leaves with a
// token about to lapse.
const RENEW_EARLY_MS = 60_000;
// The server issues 10-minute tokens. A lifetime outside these bounds comes
// from a skewed clock or a bad answer and is not believed.
const MIN_LIFETIME_MS = 30_000;
const MAX_LIFETIME_MS = 15 * 60_000;
// Another tab rotated the cookie while this refresh was in flight. The jar
// already holds the new cookie, so asking again succeeds; the server treats a
// rotated credential as stolen after 30 seconds, so retries stay well inside.
const RACE_RETRIES = 3;
const RACE_BACKOFF_MS = 150;
const REFRESH_TIMEOUT_MS = 15_000;
const LOCK_NAME = "truex-refresh";
const CHANNEL_NAME = "truex-auth";

export type TokenResult =
  | { kind: "ok"; token: string; userId: string }
  /** No live session: sign in again. */
  | { kind: "signedOut" }
  /** The platform could not be asked. Not the same as signed out. */
  | { kind: "unavailable" };

export type Authorized =
  | { kind: "response"; response: Response }
  | { kind: "signedOut" }
  | { kind: "unavailable" };

interface Locks {
  request(name: string, callback: () => Promise<unknown>): Promise<unknown>;
}
interface Channel {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
  close(): void;
}

export interface AuthDeps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Cross-tab refresh lock; null runs refreshes without one. */
  locks?: Locks | null;
  /** Cross-tab sign-out messages; null keeps this tab to itself. */
  channel?: Channel | null;
  /** A refresh returned a different person than this tab was showing. */
  onAccountChanged?: () => void;
  /** Another tab signed out. */
  onSignedOutElsewhere?: () => void;
}

export interface Auth {
  /** A usable access token, refreshing first when there is none or it is old. */
  accessToken(): Promise<TokenResult>;
  /**
   * Sends a request with the access token. A 401 means the token was refused
   * before any handler ran, so the request is sent once more with a renewed
   * token; anything else is returned as it came.
   */
  request(
    url: string,
    init?: RequestInit,
    fetchImpl?: typeof fetch,
  ): Promise<Authorized>;
  /**
   * Ends the session on the server and in every tab. `confirmed` is false
   * when the server could not be reached or refused: the token is dropped
   * either way, but the person must not be told they are signed out.
   */
  signOut(): Promise<{ confirmed: boolean }>;
  close(): void;
}

interface Token {
  value: string;
  userId: string;
  renewAt: number;
}

function parseRefresh(
  data: unknown,
): { userId: string; accessToken: string; expiresAt: number } | null {
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d !== "object") return null;
  const { userId, accessToken, accessTokenExpiresAt } = d;
  if (typeof userId !== "string" || !WIRE_ID.test(userId)) return null;
  if (
    typeof accessToken !== "string" ||
    !accessToken ||
    accessToken.length > MAX_TOKEN_LENGTH ||
    /\s/.test(accessToken)
  )
    return null;
  const expiresAt =
    typeof accessTokenExpiresAt === "string"
      ? Date.parse(accessTokenExpiresAt)
      : NaN;
  if (!Number.isFinite(expiresAt)) return null;
  return { userId, accessToken, expiresAt };
}

function withBearer(init: RequestInit, token: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

function openChannel(): Channel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  // Node keeps a process alive for an open channel; browsers have no unref.
  (channel as { unref?: () => void }).unref?.();
  return channel;
}

export function createAuth(deps: AuthDeps = {}): Auth {
  // Read at call time, so a test's mock of the global fetch applies.
  const doFetch: typeof fetch = deps.fetch ?? ((...a) => fetch(...a));
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const locks =
    deps.locks !== undefined
      ? deps.locks
      : ((globalThis.navigator as { locks?: Locks } | undefined)?.locks ??
        null);
  // Opened on first use, so rendering on the server opens nothing.
  let channel: Channel | null | undefined = deps.channel;

  let token: Token | null = null;
  let lastUserId: string | null = null;
  let inflight: Promise<TokenResult> | null = null;
  // Bumped by sign-out, so a refresh that finishes afterwards is not kept.
  let epoch = 0;
  // Only a full sign-in navigation may reopen a tab after explicit logout.
  let ended = false;

  const forget = () => {
    epoch++;
    token = null;
  };

  const listen = (): Channel | null => {
    if (channel === undefined) channel = openChannel();
    if (channel && !channel.onmessage)
      channel.onmessage = (event) => {
        if ((event.data as { type?: unknown } | null)?.type !== "logout")
          return;
        ended = true;
        forget();
        deps.onSignedOutElsewhere?.();
      };
    return channel;
  };

  async function renew(): Promise<TokenResult> {
    const started = epoch;
    for (let attempt = 0; ; attempt++) {
      if (ended || started !== epoch) return { kind: "signedOut" };
      let res: Response;
      try {
        res = await doFetch(AUTH_PATHS.refresh, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        });
      } catch {
        return { kind: "unavailable" };
      }
      if (res.status === 409 && attempt < RACE_RETRIES) {
        await res.body?.cancel().catch(() => {});
        await sleep(RACE_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        if (started === epoch) forget();
        return { kind: "signedOut" };
      }
      // 403 is the origin check: a deployment problem, not a sign-out.
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { kind: "unavailable" };
      }
      const issued = parseRefresh(await res.json().catch(() => null));
      if (!issued) return { kind: "unavailable" };
      if (started !== epoch) return { kind: "signedOut" };
      // Measured against the server's clock when it says what time it is, so
      // a browser clock that is off does not expire every token at once.
      const serverNow = Date.parse(res.headers.get("date") ?? "");
      const lifetime = Math.min(
        MAX_LIFETIME_MS,
        Math.max(
          MIN_LIFETIME_MS,
          issued.expiresAt - (Number.isFinite(serverNow) ? serverNow : now()),
        ),
      );
      const previous = lastUserId;
      lastUserId = issued.userId;
      token = {
        value: issued.accessToken,
        userId: issued.userId,
        renewAt: now() + Math.max(lifetime - RENEW_EARLY_MS, lifetime / 2),
      };
      if (previous && previous !== issued.userId) {
        epoch++;
        deps.onAccountChanged?.();
        return { kind: "signedOut" };
      }
      return { kind: "ok", token: token.value, userId: token.userId };
    }
  }

  // One refresh per tab at a time; across tabs, one at a time by lock.
  function refresh(): Promise<TokenResult> {
    inflight ??= (async () => {
      try {
        return locks
          ? ((await locks.request(LOCK_NAME, renew)) as TokenResult)
          : await renew();
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function accessToken(): Promise<TokenResult> {
    listen();
    if (ended) return Promise.resolve({ kind: "signedOut" });
    if (token && now() < token.renewAt)
      return Promise.resolve({
        kind: "ok",
        token: token.value,
        userId: token.userId,
      });
    return refresh();
  }

  // Several requests refused with the same token renew it once.
  function renewAfterRejection(rejected: string): Promise<TokenResult> {
    if (token && token.value !== rejected) return accessToken();
    if (token?.value === rejected) token = null;
    return refresh();
  }

  async function request(
    url: string,
    init: RequestInit = {},
    fetchImpl: typeof fetch = doFetch,
  ): Promise<Authorized> {
    const started = epoch;
    const first = await accessToken();
    if (first.kind !== "ok") return first;
    if (ended || started !== epoch) return { kind: "signedOut" };
    const response = await fetchImpl(url, withBearer(init, first.token));
    if (ended || started !== epoch) {
      await response.body?.cancel().catch(() => {});
      return { kind: "signedOut" };
    }
    if (response.status !== 401) return { kind: "response", response };
    await response.body?.cancel().catch(() => {});
    const renewed = await renewAfterRejection(first.token);
    if (renewed.kind !== "ok") return renewed;
    if (ended || started !== epoch) return { kind: "signedOut" };
    const retried = await fetchImpl(url, withBearer(init, renewed.token));
    if (ended || started !== epoch) {
      await retried.body?.cancel().catch(() => {});
      return { kind: "signedOut" };
    }
    return { kind: "response", response: retried };
  }

  async function signOut(): Promise<{ confirmed: boolean }> {
    ended = true;
    forget();
    let confirmed = false;
    try {
      const res = await doFetch(AUTH_PATHS.logout, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => {});
      confirmed = res.ok;
    } catch {
      /* Not confirmed. */
    }
    // Other tabs drop their tokens whatever the server said.
    listen()?.postMessage({ type: "logout" });
    return { confirmed };
  }

  return {
    accessToken,
    request,
    signOut,
    close: () => channel?.close(),
  };
}

// This tab's session. A different person signing in elsewhere, or a sign-out
// in another tab, makes the session gate ask again before anything is shown.
export const auth = createAuth({
  onAccountChanged: () => {
    bumpIdentityGeneration();
    notifyUnauthenticated();
  },
  onSignedOutElsewhere: notifyUnauthenticated,
});
