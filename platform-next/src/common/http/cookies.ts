import type { Request, Response } from "express";

export interface CookieOptions {
  maxAgeSeconds: number;
  sameSite: "Strict" | "Lax";
  secure: boolean;
}

// Every cookie this app sets is HttpOnly and host-wide (Path=/), which the
// __Host- prefix requires.
export function appendCookie(
  res: Response,
  name: string,
  value: string,
  options: CookieOptions,
): void {
  res.append(
    "Set-Cookie",
    [
      `${name}=${value}`,
      "Path=/",
      "HttpOnly",
      `SameSite=${options.sameSite}`,
      `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
      ...(options.secure ? ["Secure"] : []),
    ].join("; "),
  );
}

// The cookie's value, or undefined when it is absent or sent more than once.
// Two copies mean something else set one; neither is trusted.
export function readSingleCookie(
  req: Request,
  name: string,
): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return values.length === 1 ? values[0] : undefined;
}
