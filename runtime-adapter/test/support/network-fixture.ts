import { once } from "node:events";
import { readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  createServer as createNetServer,
  type Server,
  type Socket,
} from "node:net";
import { TLSSocket } from "node:tls";
import { join } from "node:path";

// A loopback stand-in for the internet, for network pin tests. Codex's
// network proxy is pointed at it as its upstream proxy (HTTPS_PROXY), so a
// sandbox command's request to an allowed public name (example.com) passes
// every real policy check (DNS says public, allowlist, MITM hooks, broker)
// and then lands here instead of on the real host. CONNECT tunnels are
// answered with a certificate from the fixture CA (test/support/network-ca).
//
// Every request is recorded with its host, method, path and Authorization
// header. The answer names host, method and path only, so a token never
// comes back into command output (and from there into Codex history).

export const FIXTURE_CA = join(__dirname, "network-ca", "ca.pem");
const LEAF_KEY = join(__dirname, "network-ca", "leaf.key");
const LEAF_CERT = join(__dirname, "network-ca", "leaf.pem");

export interface SeenRequest {
  readonly host: string;
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly tls: boolean;
}

export class NetworkFixture {
  readonly seen: SeenRequest[] = [];
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  url = "";

  async start(): Promise<this> {
    const key = readFileSync(LEAF_KEY);
    const cert = readFileSync(LEAF_CERT);
    const app = createHttpServer((req, res) =>
      this.answer(req, res, req.socket instanceof TLSSocket),
    );
    this.server = createNetServer((socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      socket.once("data", (first) => {
        const head = first.toString("latin1");
        const connect = /^CONNECT ([^ ]+) HTTP\/1\.[01]\r\n/.exec(head);
        if (!connect) {
          socket.unshift(first);
          app.emit("connection", socket);
          return;
        }
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const host = connect[1]!.replace(/:\d+$/, "");
        const tls = new TLSSocket(socket, { isServer: true, key, cert });
        (tls as TLSSocket & { tunnelHost?: string }).tunnelHost = host;
        app.emit("connection", tls);
      });
      socket.on("error", () => undefined);
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const address = this.server.address();
    if (typeof address !== "object" || address === null)
      throw new Error("no port");
    this.url = `http://127.0.0.1:${address.port}`;
    return this;
  }

  // Codex's own process environment for a test that uses this fixture.
  env(): Record<string, string> {
    return {
      HTTPS_PROXY: this.url,
      HTTP_PROXY: this.url,
      // Codex's own model calls go to the loopback model fixture directly.
      NO_PROXY: "127.0.0.1,localhost",
      SSL_CERT_FILE: FIXTURE_CA,
    };
  }

  private answer(
    req: IncomingMessage,
    res: ServerResponse,
    tls: boolean,
  ): void {
    let host = (req.headers.host ?? "").replace(/:\d+$/, "");
    let path = req.url ?? "/";
    if (/^https?:\/\//.test(path)) {
      const url = new URL(path);
      host = url.hostname;
      path = `${url.pathname}${url.search}`;
    }
    const record: SeenRequest = {
      host: host.toLowerCase(),
      method: req.method ?? "",
      path,
      authorization: req.headers.authorization ?? null,
      tls,
    };
    req.resume();
    req.once("end", () => {
      this.seen.push(record);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ host: record.host, method: record.method, path }),
      );
    });
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.server?.close(resolve));
  }
}
