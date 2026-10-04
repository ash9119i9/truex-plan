import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { connect, type Socket, type TcpNetConnectOpts } from "node:net";
import {
  EgressDenied,
  publicUrl,
  vettedDestination,
  type Resolver,
} from "./egress-policy";

const DEADLINE_MS = 40_000;
const MAX_BYTES = 16 * 1024 * 1024;
const HOP_HEADERS = [
  "connection",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
function headers(source: IncomingHttpHeaders) {
  const result = { ...source };
  for (const key of [
    ...HOP_HEADERS,
    ...(source.connection ?? "").split(",").map((s) => s.trim().toLowerCase()),
  ])
    delete result[key];
  return result;
}

/** Browser's sole egress. DNS is validated once per connection; sockets dial that IP. */
export function createEgressProxy(
  options: {
    resolver?: Resolver;
    maxConnections?: number;
    deadlineMs?: number;
    outboundRequest?: typeof request;
    outboundConnect?: (options: TcpNetConnectOpts) => Socket;
  } = {},
) {
  let active = 0;
  const sockets = new Set<Socket>();
  const maxConnections = options.maxConnections ?? 128;
  const deadline = options.deadlineMs ?? DEADLINE_MS;
  async function target(raw: string) {
    const url = publicUrl(raw);
    let timer: NodeJS.Timeout | undefined;
    try {
      const destination = await Promise.race([
        vettedDestination(url, options.resolver),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("DNS deadline")), 3000);
        }),
      ]);
      return { url, destination };
    } finally {
      clearTimeout(timer);
    }
  }
  const server = createServer(
    { maxHeaderSize: 16 * 1024 },
    async (req, res) => {
      if (active >= maxConnections) {
        res.writeHead(503).end();
        return;
      }
      active++;
      let upstream: ReturnType<typeof request> | undefined;
      const abort = () => upstream?.destroy();
      res.on("close", abort);
      const timer = setTimeout(() => {
        upstream?.destroy();
        res.destroy();
      }, deadline);
      let bytes = 0;
      try {
        if (
          !req.url ||
          !["GET", "HEAD", "POST", "OPTIONS"].includes(req.method ?? "")
        )
          throw new EgressDenied();
        const { url, destination } = await target(req.url);
        // HTTPS must use CONNECT; never downgrade it to a plain-text socket.
        if (url.protocol !== "http:") throw new EgressDenied();
        if (res.destroyed) return;
        await new Promise<void>((resolve) => {
          upstream = (options.outboundRequest ?? request)(
            {
              hostname: destination.address,
              family: destination.family,
              port: destination.port,
              method: req.method,
              path: url.pathname + url.search,
              headers: { ...headers(req.headers), host: url.host },
              agent: false,
            },
            (response) => {
              res.writeHead(
                response.statusCode ?? 502,
                headers(response.headers),
              );
              response.on("data", (chunk) => {
                bytes += chunk.length;
                if (bytes > MAX_BYTES) {
                  upstream?.destroy();
                  res.destroy();
                }
              });
              response.on("end", resolve);
              response.on("close", resolve);
              response.pipe(res);
            },
          );
          upstream.on("error", () => {
            if (!res.headersSent) res.writeHead(502).end();
            else res.destroy();
            resolve();
          });
          req.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_BYTES) {
              upstream?.destroy();
              res.destroy();
            }
          });
          req.on("aborted", () => {
            upstream?.destroy();
            resolve();
          });
          req.pipe(upstream);
        });
      } catch (error) {
        if (!res.destroyed && !res.headersSent)
          res
            .writeHead(error instanceof EgressDenied ? 403 : 502)
            .end("Web destination unavailable");
      } finally {
        clearTimeout(timer);
        res.off("close", abort);
        active--;
      }
    },
  );
  server.on("connect", async (req, client, head) => {
    if (active >= maxConnections) {
      client.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return;
    }
    active++;
    let upstream: Socket | undefined;
    let finished = false;
    let bytes = head.length;
    const finish = () => {
      if (finished) return;
      finished = true;
      active--;
      clearTimeout(timer);
      upstream?.destroy();
      client.destroy();
    };
    const timer = setTimeout(finish, deadline);
    client.on("close", finish);
    client.on("error", finish);
    try {
      if (
        !req.url ||
        !/^(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):443$/.test(req.url)
      )
        throw new EgressDenied();
      const { destination } = await target(`https://${req.url}/`);
      if (finished) return;
      upstream = (options.outboundConnect ?? connect)({
        host: destination.address,
        family: destination.family,
        port: destination.port,
      });
      upstream.on("error", finish);
      upstream.on("close", finish);
      upstream.once("connect", () => {
        if (finished) return;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream!.write(head);
        const count = (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) finish();
        };
        client.on("data", count);
        upstream!.on("data", count);
        client.pipe(upstream!);
        upstream!.pipe(client);
      });
    } catch (error) {
      if (!finished)
        client.end(
          `HTTP/1.1 ${error instanceof EgressDenied ? "403 Forbidden" : "502 Bad Gateway"}\r\nConnection: close\r\n\r\n`,
          () => client.destroy(),
        );
    }
  });
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.headersTimeout = 5000;
  server.requestTimeout = deadline;
  server.keepAliveTimeout = 1000;
  return {
    server,
    close() {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}
