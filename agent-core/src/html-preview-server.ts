import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  DockerHtmlPreviewRunner,
  htmlPreviewLimits,
  type HtmlPreviewRunner,
} from "./html-preview";
import { HttpError } from "./errors";

/** Private supervisor only. The browser job receives neither this secret nor
 * the Docker socket. Deploy behind a private network and authenticated TLS. */
export function createHtmlPreviewServer(
  secret: string,
  runner: HtmlPreviewRunner = new DockerHtmlPreviewRunner(),
) {
  if (secret.length < 32)
    throw new Error(
      "HTML preview service requires a private secret of at least 32 characters",
    );
  const expected = Buffer.from(secret);
  const server = createServer(async (req, res) => {
    const key = req.headers["x-truex-preview-key"],
      received = typeof key === "string" ? Buffer.from(key) : Buffer.alloc(0);
    if (
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      res.writeHead(401).end();
      req.resume();
      return;
    }
    if (req.method !== "POST" || req.url !== "/preview") {
      res.writeHead(404).end();
      req.resume();
      return;
    }
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const parts: Buffer[] = [];
      let size = 0;
      for await (const part of req) {
        size += part.length;
        if (size > htmlPreviewLimits.inputBytes) {
          res.writeHead(413).end();
          req.destroy();
          return;
        }
        parts.push(part);
      }
      let input: any;
      try {
        input = JSON.parse(Buffer.concat(parts).toString("utf8"));
      } catch {
        throw new HttpError(400, "Invalid preview input");
      }
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some(
          (k) => !["html", "width", "appearance", "scope"].includes(k),
        ) ||
        (input.scope !== undefined &&
          (typeof input.scope !== "string" || input.scope.length > 256))
      )
        throw new HttpError(400, "Invalid preview input");
      const result = await runner.run({ ...input, signal: controller.signal });
      if (!res.destroyed)
        res
          .writeHead(200, {
            "content-type": "application/json",
            "cache-control": "no-store",
          })
          .end(JSON.stringify(result));
    } catch (error) {
      if (!res.destroyed) {
        const status = error instanceof HttpError ? error.status : 503;
        res
          .writeHead(status, {
            "content-type": "application/json",
            "cache-control": "no-store",
          })
          .end(JSON.stringify({ error: "HTML preview failed" }));
      }
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  return server;
}
if (require.main === module) {
  const secret = process.env.HTML_PREVIEW_SECRET ?? "";
  const server = createHtmlPreviewServer(
    secret,
    new DockerHtmlPreviewRunner({ image: process.env.HTML_PREVIEW_IMAGE }),
  );
  const port = Number(process.env.HTML_PREVIEW_PORT ?? 8091);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid HTML preview port");
  server.listen(port, process.env.HTML_PREVIEW_BIND ?? "127.0.0.1", () =>
    console.log("Private HTML preview supervisor ready"),
  );
}
