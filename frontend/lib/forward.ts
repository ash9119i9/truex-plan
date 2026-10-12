// Same-origin forwarding of the browser's /auth/* and /api/* requests to the
// platform. The browser only ever talks to this origin, so the session cookie
// lands here and is sent with every request, including EventSource.
//
// This is a transport, not a gate. The platform authenticates and authorizes
// every request itself; nothing here decides who may see what.
//
// Written against the standard Request/Response so it can be tested without
// Next: the route files under app/ only bind it to a path prefix.

export type Prefix = "/auth" | "/api";

// Request headers passed upstream. Everything else (host, connection,
// x-forwarded-*, anything a client forges to claim an identity, ...) is dropped.
const PASS_REQUEST = [
  "accept",
  "cookie",
  "content-type",
  "last-event-id",
  "origin",
  "user-agent",
  "x-request-id",
];
// Response headers the fetch layer manages itself, or that must not cross a
// hop. set-cookie is handled separately so several cookies stay separate.
const DROP_RESPONSE = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// The platform accepts 2 MB of JSON. A little more is allowed for the envelope;
// anything larger is refused here instead of being buffered or streamed on.
export const MAX_BODY_BYTES = 2 * 1024 * 1024 + 4096;
// Cold runtime starts can take two and a half minutes (see lib/api.ts); the
// forwarder waits slightly longer than the browser does. Everything under
// /auth is a quick database or Google call.
const DEADLINE_MS: Record<Prefix, number> = {
  "/api": 190_000,
  "/auth": 30_000,
};
// A health or session check is never worth waiting long for.
const SHORT_DEADLINE_MS = 12_000;
const SHORT_PATHS = new Set(["/api/me", "/auth/tenants"]);

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const FORWARDED_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;

export interface ForwardOptions {
  prefix: Prefix;
  /** Decoded path segments after the prefix, as Next hands them over. */
  path: string[] | undefined;
  env?: Record<string, string | undefined>;
  /** For tests. */
  fetch?: typeof fetch;
}

function json(status: number, error: string, code: string, requestId?: string) {
  return Response.json(
    { error, code, ...(requestId ? { requestId } : {}) },
    {
      status,
      headers: {
        "cache-control": "no-store",
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
    },
  );
}
const notFound = () => json(404, "Not found", "NOT_FOUND");

const BAD_CHARS = /[\u0000-\u001f\u007f\\/]/;
const DOTS = (value: string) => value === "." || value === "..";

/**
 * A segment fetch could resolve out of the prefix, or that smuggles a
 * separator. Next hands us decoded segments, so "%2E%2E" arrives as "..";
 * "%252E%252E" arrives as "%2E%2E", which is looked at once more here.
 * Malformed escapes are refused rather than guessed at.
 */
export function safeSegment(segment: string): boolean {
  if (segment === "" || DOTS(segment) || BAD_CHARS.test(segment)) return false;
  if (!segment.includes("%")) return true;
  let again: string;
  try {
    again = decodeURIComponent(segment);
  } catch {
    return false;
  }
  return again !== "" && !DOTS(again) && !BAD_CHARS.test(again);
}

export function safePath(path: string[] | undefined): path is string[] {
  return !!path && path.length > 0 && path.every(safeSegment);
}

// The admin console has its own app and host. Express routes case-insensitively,
// so the check is too.
export const isBlockedPath = (path: string[]) =>
  path[0]?.toLowerCase() === "admin";

export function upstreamBase(
  env: Record<string, string | undefined> = process.env,
) {
  // Read per request so the environment can change without a rebuild.
  return (env.PLATFORM_INTERNAL_URL || "http://localhost:4000").replace(
    /\/+$/,
    "",
  );
}

// X-Forwarded-For is client-controlled unless a trusted front proxy (the
// ingress) appends the real address. Only then is it passed on; otherwise it is
// dropped, and the platform's per-address limits are shared by everyone coming
// through this forwarder.
export function forwardedFor(
  incoming: string | null,
  trust: string | undefined,
) {
  return trust?.trim().toLowerCase() === "on" && incoming ? incoming : null;
}

const REQUEST_ID = /^[\w.:-]{1,64}$/;

/** Counts bytes and fails the stream past the limit, so nothing is buffered. */
export function limitBody(max: number, onExceeded: () => void) {
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > max) {
        onExceeded();
        controller.error(new Error("request body too large"));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

export async function forward(
  req: Request,
  options: ForwardOptions,
): Promise<Response> {
  const env = options.env ?? process.env;
  const doFetch = options.fetch ?? fetch;
  const { prefix, path } = options;
  if (!safePath(path) || isBlockedPath(path)) return notFound();
  const method = req.method.toUpperCase();
  if (!(FORWARDED_METHODS as readonly string[]).includes(method))
    return json(405, "Method not allowed", "METHOD_NOT_ALLOWED");

  // This forwarder is cookie-only. An Authorization header is refused, not
  // dropped: dropping it would silently authenticate whichever cookie the
  // browser also sent. Bearer clients call the platform API origin directly.
  if (req.headers.has("authorization"))
    return json(
      401,
      "Access tokens are not accepted on this origin. Use the API endpoint, or sign in with the browser.",
      "BEARER_NOT_SUPPORTED",
    );

  const requestId = REQUEST_ID.test(req.headers.get("x-request-id") ?? "")
    ? req.headers.get("x-request-id")!
    : crypto.randomUUID();
  const search = new URL(req.url).search;
  const upstreamPath = `${prefix}/${path.map(encodeURIComponent).join("/")}`;
  const target = `${upstreamBase(env)}${upstreamPath}${search}`;

  const headers = new Headers();
  for (const name of PASS_REQUEST) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-request-id", requestId);
  const xff = forwardedFor(
    req.headers.get("x-forwarded-for"),
    env.TRUST_FORWARDED_FOR,
  );
  if (xff) headers.set("x-forwarded-for", xff);

  // Oversized requests are refused up front when they announce their size, and
  // cut off mid-stream when they do not.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
    return json(
      413,
      "The request is too large.",
      "REQUEST_TOO_LARGE",
      requestId,
    );
  let exceeded = false;
  const hasBody = METHODS_WITH_BODY.has(method) && req.body !== null;
  const body = hasBody
    ? req.body!.pipeThrough(limitBody(MAX_BODY_BYTES, () => (exceeded = true)))
    : undefined;

  // Ends the upstream request when the browser goes away (a closed tab, a
  // dropped EventSource) and when the deadline passes, so no socket, reader or
  // timer outlives the person.
  const deadline = SHORT_PATHS.has(upstreamPath)
    ? SHORT_DEADLINE_MS
    : DEADLINE_MS[prefix];
  const controller = new AbortController();
  const abort = () => controller.abort(req.signal.reason);
  if (req.signal.aborted) abort();
  else req.signal.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("deadline", "TimeoutError"));
    }, deadline);
  };
  arm();
  const cleanup = () => {
    clearTimeout(timer);
    req.signal.removeEventListener("abort", abort);
  };

  let upstream: Response;
  try {
    upstream = await doFetch(target, {
      method,
      headers,
      body,
      // Node fetch requires duplex for a streamed request body.
      ...(body ? { duplex: "half" } : {}),
      // Google redirects and the sign-in redirects pass straight through.
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    } as RequestInit);
  } catch (error) {
    cleanup();
    if (exceeded)
      return json(
        413,
        "The request is too large.",
        "REQUEST_TOO_LARGE",
        requestId,
      );
    if (req.signal.aborted) return new Response(null, { status: 499 });
    if (timedOut)
      return json(
        504,
        "Truex took too long to answer. Check the conversation before retrying; the request may have been accepted.",
        "PLATFORM_TIMEOUT",
        requestId,
      );
    return json(
      503,
      "Truex is temporarily unavailable. Try again in a moment.",
      "PLATFORM_UNAVAILABLE",
      requestId,
    );
  }

  const out = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!DROP_RESPONSE.has(name.toLowerCase())) out.set(name, value);
  });
  // Headers.forEach folds Set-Cookie into one line; re-add each cookie separately.
  for (const cookie of upstream.headers.getSetCookie())
    out.append("set-cookie", cookie);
  if (!out.has("x-request-id")) out.set("x-request-id", requestId);

  // Per-person data, auth errors and redirects are never cached by the browser
  // or anything in between. An event stream is already no-cache, no-transform.
  const type = upstream.headers.get("content-type") ?? "";
  const stream = type.startsWith("text/event-stream");
  if (stream) {
    out.set("cache-control", "no-cache, no-transform");
    out.set("x-accel-buffering", "no");
  } else out.set("cache-control", "no-store");
  const vary = out.get("vary");
  if (!vary) out.set("vary", "Cookie");
  else if (vary !== "*" && !/(^|,)\s*cookie\s*(,|$)/i.test(vary))
    out.set("vary", `${vary}, Cookie`);

  // 204, 304 and HEAD answers carry no body.
  if (
    upstream.status === 204 ||
    upstream.status === 205 ||
    upstream.status === 304 ||
    method === "HEAD" ||
    !upstream.body
  ) {
    cleanup();
    upstream.body?.cancel().catch(() => {});
    return new Response(null, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  }

  // The deadline covers the wait for the platform's answer. Once the answer
  // starts, a long-lived stream may run for as long as the person watches it;
  // a body that goes quiet is not cut off by this timer, but it is by the abort
  // signal when the browser leaves.
  clearTimeout(timer);
  const reader = upstream.body.getReader();
  const passthrough = new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanup();
          c.close();
        } else c.enqueue(value);
      } catch (error) {
        cleanup();
        c.error(error);
      }
    },
    cancel(reason) {
      // The browser went away: stop reading and end the upstream request.
      cleanup();
      controller.abort(reason);
      return reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(passthrough, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}
