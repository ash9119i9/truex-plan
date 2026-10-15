// Session lifetimes, in one place so a policy change is one edit.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Access tokens are held in browser memory and renewed by refresh.
export const ACCESS_TOKEN_TTL_SECONDS = 10 * 60;

// A session ends after this long without a refresh...
export const SESSION_IDLE_TTL_MS = 24 * HOUR_MS;
// ...and in any case this long after sign-in.
export const SESSION_ABSOLUTE_TTL_MS = 7 * DAY_MS;

// Tabs share one refresh cookie, so two tabs can refresh at once. The loser
// presents the just-rotated credential; inside this window that is treated as
// a race (retry), outside it as theft (the session is revoked).
export const REFRESH_RACE_GRACE_MS = 30_000;

// How many rotated-away credentials are remembered to recognize replay.
export const REFRESH_HISTORY_SIZE = 5;
