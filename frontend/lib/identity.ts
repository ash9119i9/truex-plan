// Who this browser tab is showing, and what the app remembers about it.
//
// Everything the app keeps in the browser about a conversation (the live
// stream's replay cursor, a visual's saved state) is stored under the current
// person and workspace, so another person signing in on the same browser can
// never read it, and a cursor from one workspace is never replayed in another.
// Logging out, or finding that the identity changed, clears it.

let scope = "none";
// The tenant this tab is showing. api() addresses tenant requests to it.
let tenant: string | null = null;
export const identityScope = () => scope;
export const identityTenant = () => tenant;
export function setIdentityScope(userId: string, tenantId: string) {
  if (scope !== `${userId}.${tenantId}`) bumpIdentityGeneration();
  scope = `${userId}.${tenantId}`;
  tenant = tenantId;
}

export function clearIdentityScope() {
  bumpIdentityGeneration();
  scope = "none";
  tenant = null;
}

// Responses that arrive after the person or workspace changed are not applied.
let generation = 0;
export const identityGeneration = () => generation;
export const bumpIdentityGeneration = () => ++generation;

// A request answered 401 means the session ended somewhere. The session gate
// listens and re-checks with the authority (/api/me) before acting.
const listeners = new Set<() => void>();
export function onUnauthenticated(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
export const notifyUnauthenticated = () => listeners.forEach((l) => l());

// Keys that hold private, per-conversation data. Theme and other preferences
// hold nothing private and stay.
export const PRIVATE_SESSION_PREFIXES = ["cursor:"];
export const PRIVATE_LOCAL_PREFIXES = ["truex-visualization:"];
export const SCOPE_KEY = "truex-last-scope";

interface KeyStore {
  length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}
function purge(store: KeyStore | undefined, prefixes: string[]) {
  if (!store) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && prefixes.some((p) => key.startsWith(p))) doomed.push(key);
    }
    for (const key of doomed) store.removeItem(key);
  } catch {
    /* Storage can be unavailable; there is then nothing stored to clear. */
  }
}
export function clearPrivateBrowserState(
  stores: { session?: KeyStore; local?: KeyStore } = {
    session: typeof sessionStorage === "undefined" ? undefined : sessionStorage,
    local: typeof localStorage === "undefined" ? undefined : localStorage,
  },
) {
  purge(stores.session, PRIVATE_SESSION_PREFIXES);
  purge(stores.local, PRIVATE_LOCAL_PREFIXES);
}

/**
 * Called once the person is known. If this browser last showed someone else (or
 * another workspace), what it kept for them is cleared before anything of the
 * new identity is shown.
 */
export function enterIdentity(
  userId: string,
  tenantId: string,
  local:
    | (KeyStore & {
        getItem(k: string): string | null;
        setItem(k: string, v: string): void;
      })
    | undefined = typeof localStorage === "undefined"
    ? undefined
    : localStorage,
  stores?: Parameters<typeof clearPrivateBrowserState>[0],
) {
  setIdentityScope(userId, tenantId);
  const now = identityScope();
  try {
    const before = local?.getItem(SCOPE_KEY);
    if (before && before !== now) clearPrivateBrowserState(stores);
    local?.setItem(SCOPE_KEY, now);
  } catch {
    /* Without storage there is nothing to carry over. */
  }
}
