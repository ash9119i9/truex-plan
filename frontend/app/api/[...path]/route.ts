// Same-origin forwarder for the platform's /api/* routes, including the live
// event streams. The browser sends its session cookie here and never talks to
// the platform directly. The platform still authenticates every request; the
// admin API (/api/admin) is not reachable through this origin.
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
