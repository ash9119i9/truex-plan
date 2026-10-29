import { once } from "node:events";
import { createServer, type Server } from "node:http";

// A provider's OAuth side: protected-resource metadata, authorization-server
// metadata and a token endpoint that answers refresh_token grants. It can also
// stand in for the MCP server's unauthenticated discovery probe (POST /mcp),
// answering 401 with resource_metadata or 200 (for the well-known fallback).

export type TokenBehaviour =
  "ok" | "ok-form" | "refuse" | "refuse-200" | "down";

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

export function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

export class AuthFixture {
  // Each token request's form, in order.
  readonly tokenRequests: URLSearchParams[] = [];
  // Paths of every metadata GET, in order.
  readonly metadataRequests: string[] = [];
  behaviour: TokenBehaviour = "ok";
  // How POST /mcp (the discovery probe) answers.
  probe: "401" | "200" = "401";
  // Holds every token request until resolved.
  gate: Deferred | undefined;
  // Called with each access token issued, so the MCP fixture can accept it.
  onIssue: ((accessToken: string) => void) | undefined;
  // The protected resource the metadata names (the MCP server URL).
  resource = "";
  url = "";
  private server!: Server;

  get prmUrl(): string {
    return `${this.url}/prm`;
  }

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const path = new URL(req.url ?? "/", "http://auth").pathname;
      const json = (status: number, value: unknown) =>
        res
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify(value));
      if (req.method === "POST" && path === "/mcp") {
        if (this.probe === "200") return json(200, { jsonrpc: "2.0", id: 1 });
        res
          .writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${this.prmUrl}"`,
          })
          .end();
        return;
      }
      if (
        req.method === "GET" &&
        (path === "/prm" ||
          path === "/.well-known/oauth-protected-resource/mcp")
      ) {
        this.metadataRequests.push(path);
        return json(200, {
          resource: this.resource,
          authorization_servers: [this.url],
        });
      }
      if (
        req.method === "GET" &&
        path === "/.well-known/oauth-authorization-server"
      ) {
        this.metadataRequests.push(path);
        return json(200, {
          issuer: this.url,
          authorization_endpoint: `${this.url}/authorize`,
          token_endpoint: `${this.url}/token`,
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (req.method === "POST" && path === "/token") {
        this.tokenRequests.push(new URLSearchParams(body));
        if (this.gate) await this.gate.promise;
        const n = this.tokenRequests.length;
        switch (this.behaviour) {
          case "refuse":
            return json(400, { error: "invalid_grant" });
          case "refuse-200":
            return json(200, { error: "bad_refresh_token" });
          case "down":
            return void res.writeHead(503).end();
          case "ok-form": {
            const access = `refreshed-access-${n}`;
            this.onIssue?.(access);
            res
              .writeHead(200, {
                "content-type": "application/x-www-form-urlencoded",
              })
              .end(
                new URLSearchParams({
                  access_token: access,
                  refresh_token: `refreshed-refresh-${n}`,
                  expires_in: "28800",
                  refresh_token_expires_in: "15897600",
                }).toString(),
              );
            return;
          }
          case "ok": {
            const access = `refreshed-access-${n}`;
            this.onIssue?.(access);
            return json(200, {
              access_token: access,
              refresh_token: `refreshed-refresh-${n}`,
              expires_in: 3600,
              token_type: "bearer",
            });
          }
        }
      }
      res.writeHead(404).end();
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const { port } = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${port}`;
  }

  reset(): void {
    this.tokenRequests.length = 0;
    this.metadataRequests.length = 0;
    this.behaviour = "ok";
    this.probe = "401";
    this.gate?.resolve();
    this.gate = undefined;
    this.onIssue = undefined;
  }

  async close(): Promise<void> {
    this.gate?.resolve();
    if (!this.server?.listening) return;
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
