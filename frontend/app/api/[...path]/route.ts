// Same-origin forwarder for platform-next's /api/* routes: Google sign-in and
// its callback, token refresh and logout, account and tenant reads. The browser
// sends its refresh cookie and access token here and never talks to the
// platform directly. The platform still authenticates every request; the admin
// API (/api/admin, /api/v1/admin) is not reachable through this origin.
import { forward, type Prefix } from "@/lib/forward";

type Ctx = { params: Promise<{ path: string[] }> };
const prefix: Prefix = "/api";
const handler = async (req: Request, ctx: Ctx) =>
  forward(req, { prefix, path: (await ctx.params).path });

export const dynamic = "force-dynamic";
export const GET = handler;
export const HEAD = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
