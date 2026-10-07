// Same-origin forwarder for the platform's /auth/* routes (invite lookup, Google
// sign-in, logout, workspace switch). Cookies set by the platform land on this
// origin, and Google redirects pass straight through to the browser. The admin
// sign-in lives on its own app and host and is never reachable here.
import { forward, type Prefix } from "@/lib/forward";

type Ctx = { params: Promise<{ path: string[] }> };
const prefix: Prefix = "/auth";
const handler = async (req: Request, ctx: Ctx) =>
  forward(req, { prefix, path: (await ctx.params).path });

export const dynamic = "force-dynamic";
export const GET = handler;
export const HEAD = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
