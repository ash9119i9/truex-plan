// Same-origin forwarder for the platform's /auth/* routes (invite lookup, Google
// sign-in, logout). Cookies set by the platform land on this origin, and Google
// redirects pass straight through to the browser (redirect: "manual").
// /api/* is not forwarded yet; that comes with the main-app sign-in.
import type { NextRequest } from "next/server";

// Request headers passed upstream. Everything else (host, connection, ...) is dropped.
const PASS_REQUEST = ["cookie", "content-type", "origin", "user-agent", "x-request-id"];
// Response headers the fetch layer manages itself; copying them would corrupt the body.
const DROP_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "set-cookie"]);

function upstreamBase(): string {
  // Read per request so the env can change without a rebuild.
  return (process.env.PLATFORM_INTERNAL_URL || "http://localhost:4000").replace(/\/+$/, "");
}

const notFound = () => Response.json({ error: "not_found" }, { status: 404 });

// Rejects segments fetch would resolve out of /auth ("..", ".") and empty ones.
// Next hands us decoded segments, so "%2E%2E" arrives here as "..".
function isSafePath(path: string[] | undefined): path is string[] {
  if (!path || path.length === 0) return false;
  return path.every((s) => s !== "" && s !== "." && s !== "..");
}

// Admin sign-in lives on its own app and host; never expose it on the main-app origin.
function isBlockedPath(path: string[]): boolean {
  return path[0]?.toLowerCase() === "admin";
}

// X-Forwarded-For is client-controlled unless a trusted front proxy (the Ingress)
// appends the real address. Only then is it passed through; otherwise it is dropped.
// Next exposes no socket address, so without a trusted proxy none is sent, and the
// platform's rate limits are shared by everyone coming through this forwarder.
function forwardedFor(incoming: string | null, trust: string | undefined): string | null {
  return trust === "on" && incoming ? incoming : null;
}

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  if (!isSafePath(path) || isBlockedPath(path)) return notFound();
  const target = `${upstreamBase()}/auth/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`;

  const headers = new Headers();
  for (const name of PASS_REQUEST) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  const xff = forwardedFor(req.headers.get("x-forwarded-for"), process.env.TRUST_FORWARDED_FOR);
  if (xff) headers.set("x-forwarded-for", xff);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      // Node fetch requires duplex for a streamed request body.
      ...(hasBody ? { duplex: "half" } : {}),
      redirect: "manual",
      cache: "no-store",
    } as RequestInit);
  } catch {
    return Response.json({ error: "platform_unavailable" }, { status: 502 });
  }

  const out = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!DROP_RESPONSE.has(name.toLowerCase())) out.set(name, value);
  });
  // Headers.forEach folds Set-Cookie into one line; re-add each cookie separately.
  for (const cookie of upstream.headers.getSetCookie()) out.append("set-cookie", cookie);

  // 204/304 must not carry a body.
  const body = upstream.status === 204 || upstream.status === 304 ? null : upstream.body;
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

export const dynamic = "force-dynamic";
export const GET = forward;
export const POST = forward;
