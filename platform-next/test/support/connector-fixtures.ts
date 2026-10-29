import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// A loopback fixture that plays both roles a directory connector needs: an
// OAuth authorization server (RFC 8414 metadata, a token endpoint doing
// authorization_code with PKCE S256 and refresh_token with rotation, plus a
// revoke endpoint) and an MCP streamable-HTTP server (401 with a
// WWW-Authenticate resource_metadata pointer, protected-resource metadata, and
// an initialize / tools/list / tools/call handshake). It records every bearer
// token it is shown so a test can prove a token never leaked, and lets a test
// invalidate a token, close the server, or make it fail so the refresh and
// fallback paths can be driven.
//
// Everything is in-memory and over http on 127.0.0.1, which the connector code
// accepts only under CONNECTORS_ALLOW_LOOPBACK (allowLoopback: true).

// How a token-endpoint request should behave, so a test can script a refusal
// or an outage without a real provider.
type TokenMode =
  | { kind: "ok" }
  // GitHub refuses a bad refresh token with HTTP 200 and {error}.
  | { kind: "refuse"; error: string }
  // A 5xx, so the client treats it as unavailable rather than a refusal.
  | { kind: "error"; status: number };

export interface MintCodeOptions {
  codeChallenge: string;
  // Lifetimes the resulting grant reports (seconds). Undefined omits the
  // field, modelling a non-expiring GitHub App.
  expiresIn?: number;
  refreshTokenExpiresIn?: number;
  // Whether the exchange returns a refresh token at all.
  withRefreshToken?: boolean;
  // The granted `scope` the exchange reports; undefined omits the field.
  scope?: string;
}

interface CodeRecord {
  codeChallenge: string;
  expiresIn?: number;
  refreshTokenExpiresIn?: number;
  withRefreshToken: boolean;
  scope?: string;
  used: boolean;
}

interface RefreshRecord {
  // The access token currently paired with this refresh token, so a rotation
  // can retire the previous one.
  accessToken: string;
  expiresIn?: number;
  refreshTokenExpiresIn?: number;
  revoked: boolean;
}

export interface ConnectorFixture {
  readonly origin: string;
  // The connector URL stored on the catalog entry (the MCP server endpoint).
  readonly mcpUrl: string;
  // The path-based issuer, like GitHub's https://github.com/login/oauth, so
  // the discovery code's well-known path insertion is exercised.
  readonly issuer: string;
  // Mint an authorization code bound to a PKCE challenge, as if the user had
  // approved on the provider's page. Returns the code for the callback.
  mintCode(options: MintCodeOptions): string;
  // Every distinct bearer token the MCP server was shown, in first-seen order.
  bearerTokensSeen(): string[];
  // How many token-endpoint requests were served (single-flight assertions).
  tokenRequestCount(): number;
  // How many times each grant type was requested.
  grantTypeCounts(): Record<string, number>;
  // Each token-endpoint request's form, in order, so a test can check what
  // was sent (RFC 8707 resource, for example).
  tokenRequestForms(): URLSearchParams[];
  // Make the MCP server reject a specific bearer token with 401, as a
  // provider would once a token is revoked or expired server-side.
  invalidateToken(token: string): void;
  // Script the next token-endpoint responses (refusal, outage). Consumed in
  // order; when empty the endpoint behaves normally.
  setTokenMode(mode: TokenMode): void;
  // Whether the account tool should report a login, and which.
  setAccountLogin(login: string | undefined): void;
  // Whether tools/list succeeds; false makes it return a JSON-RPC error.
  setToolsListFails(fails: boolean): void;
  // A valid access token, as if a connect had completed.
  issueAccessToken(): string;
  // The tools tools/list returns (undefined: the default three), in pages of
  // `pageSize` with a nextCursor when it is set.
  setTools(
    tools: ReadonlyArray<Record<string, unknown>> | undefined,
    pageSize?: number,
  ): void;
  // Fields merged into the protected-resource and authorization-server
  // metadata documents (registration support, a different resource).
  setMetadataExtras(extras: MetadataExtras): void;
  close(): Promise<void>;
}

export interface MetadataExtras {
  readonly protectedResource?: Record<string, unknown>;
  readonly authorizationServer?: Record<string, unknown>;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

const DEFAULT_TOOLS: ReadonlyArray<Record<string, unknown>> = [
  { name: "get_me", description: "the viewer" },
  { name: "list_issues", description: "issues" },
  { name: "search_code", description: "code" },
];

function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function timingEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    // The fixture never receives a large body; this only bounds a mistake.
    if (size > 256 * 1024) break;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function bearerOf(req: IncomingMessage): string | undefined {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return undefined;
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1];
}

// Starts the fixture on a free loopback port. Resolves once it is listening.
export async function startConnectorFixture(): Promise<ConnectorFixture> {
  const codes = new Map<string, CodeRecord>();
  const refreshTokens = new Map<string, RefreshRecord>();
  const validAccessTokens = new Set<string>();
  const invalidTokens = new Set<string>();
  const bearersSeen: string[] = [];
  const bearersSeenSet = new Set<string>();
  const grantCounts: Record<string, number> = {};
  let tokenRequests = 0;
  const tokenForms: URLSearchParams[] = [];
  const tokenModes: TokenMode[] = [];
  let accountLogin: string | undefined = "octocat";
  let toolsListFails = false;
  let tools: ReadonlyArray<Record<string, unknown>> | undefined;
  let toolsPageSize = 0;
  let metadataExtras: MetadataExtras = {};

  let origin = "";
  let closing: Promise<void> | undefined;

  const mintAccessToken = (): string => `at_${randomBytes(18).toString("hex")}`;
  const mintRefreshToken = (): string =>
    `rt_${randomBytes(18).toString("hex")}`;

  const recordBearer = (token: string): void => {
    if (!bearersSeenSet.has(token)) {
      bearersSeenSet.add(token);
      bearersSeen.push(token);
    }
  };

  // Builds the token response for a successful grant, rotating the refresh
  // token so the previous one dies the way GitHub's does.
  const issueGrant = (
    withRefreshToken: boolean,
    expiresIn: number | undefined,
    refreshTokenExpiresIn: number | undefined,
  ): Record<string, unknown> => {
    const accessToken = mintAccessToken();
    validAccessTokens.add(accessToken);
    const body: Record<string, unknown> = {
      access_token: accessToken,
      token_type: "bearer",
    };
    if (expiresIn !== undefined) body.expires_in = expiresIn;
    if (withRefreshToken) {
      const refreshToken = mintRefreshToken();
      refreshTokens.set(refreshToken, {
        accessToken,
        expiresIn,
        refreshTokenExpiresIn,
        revoked: false,
      });
      body.refresh_token = refreshToken;
      if (refreshTokenExpiresIn !== undefined)
        body.refresh_token_expires_in = refreshTokenExpiresIn;
    }
    return body;
  };

  const server: Server = createServer((req, res) => {
    const json = (
      status: number,
      body: unknown,
      headers: Record<string, string> = {},
    ): void => {
      const text = JSON.stringify(body);
      res.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(text),
        ...headers,
      });
      res.end(text);
    };

    void (async () => {
      const url = new URL(req.url ?? "/", origin);
      const path = url.pathname;

      // ── MCP server ────────────────────────────────────────────────
      if (path === "/mcp" && req.method === "POST") {
        const token = bearerOf(req);
        if (token === undefined) {
          // Point discovery at the protected-resource metadata, as GitHub does.
          res.writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          });
          res.end();
          return;
        }
        recordBearer(token);
        if (invalidTokens.has(token) || !validAccessTokens.has(token)) {
          res.writeHead(401, {
            "www-authenticate": `Bearer error="invalid_token"`,
          });
          res.end();
          return;
        }
        const body = await readBody(req);
        let message: { id?: unknown; method?: unknown; params?: unknown };
        try {
          message = JSON.parse(body) as typeof message;
        } catch {
          json(400, { error: "bad json" });
          return;
        }
        const id = message.id ?? null;
        if (message.method === "initialize") {
          json(
            200,
            {
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
              },
            },
            { "mcp-session-id": "fixture-session" },
          );
          return;
        }
        if (message.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
          return;
        }
        if (message.method === "tools/list") {
          if (toolsListFails) {
            json(200, {
              jsonrpc: "2.0",
              id,
              error: { code: -32000, message: "tools unavailable" },
            });
            return;
          }
          const all = tools ?? DEFAULT_TOOLS;
          const cursor = (message.params as { cursor?: unknown } | undefined)
            ?.cursor;
          const start = typeof cursor === "string" ? Number(cursor) : 0;
          const end = toolsPageSize > 0 ? start + toolsPageSize : all.length;
          json(200, {
            jsonrpc: "2.0",
            id,
            result: {
              tools: all.slice(start, end),
              ...(end < all.length ? { nextCursor: String(end) } : {}),
            },
          });
          return;
        }
        if (message.method === "tools/call") {
          const name = (message.params as { name?: unknown } | undefined)?.name;
          if (name === "get_me") {
            if (accountLogin === undefined)
              json(200, {
                jsonrpc: "2.0",
                id,
                result: { content: [{ type: "text", text: "{}" }] },
              });
            else
              json(200, {
                jsonrpc: "2.0",
                id,
                result: {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({ login: accountLogin }),
                    },
                  ],
                },
              });
            return;
          }
          json(200, {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: "ok" }] },
          });
          return;
        }
        json(200, {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "method not found" },
        });
        return;
      }

      // ── Protected-resource metadata (RFC 9728) ───────────────────
      if (path === "/.well-known/oauth-protected-resource/mcp") {
        json(200, {
          resource: `${origin}/mcp`,
          authorization_servers: [`${origin}/login/oauth`],
          bearer_methods_supported: ["header"],
          ...metadataExtras.protectedResource,
        });
        return;
      }

      // ── Authorization-server metadata (RFC 8414, path-inserted) ──
      if (path === "/.well-known/oauth-authorization-server/login/oauth") {
        json(200, {
          issuer: `${origin}/login/oauth`,
          authorization_endpoint: `${origin}/login/oauth/authorize`,
          token_endpoint: `${origin}/login/oauth/access_token`,
          revocation_endpoint: `${origin}/login/oauth/revoke`,
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          authorization_response_iss_parameter_supported: true,
          ...metadataExtras.authorizationServer,
        });
        return;
      }

      // ── Token endpoint ───────────────────────────────────────────
      if (path === "/login/oauth/access_token" && req.method === "POST") {
        tokenRequests++;
        const form = new URLSearchParams(await readBody(req));
        tokenForms.push(new URLSearchParams(form));
        const grantType = form.get("grant_type") ?? "unknown";
        grantCounts[grantType] = (grantCounts[grantType] ?? 0) + 1;

        const mode = tokenModes.shift() ?? { kind: "ok" };
        if (mode.kind === "error") {
          json(mode.status, { error: "server_error" });
          return;
        }
        if (mode.kind === "refuse") {
          // GitHub reports a bad refresh token with HTTP 200 + {error}.
          json(200, { error: mode.error });
          return;
        }

        if (grantType === "authorization_code") {
          const code = form.get("code") ?? "";
          const verifier = form.get("code_verifier") ?? "";
          const record = codes.get(code);
          if (!record || record.used) {
            json(200, { error: "bad_authorization_code" });
            return;
          }
          if (!timingEqual(challengeOf(verifier), record.codeChallenge)) {
            json(400, { error: "invalid_grant" });
            return;
          }
          record.used = true;
          json(200, {
            ...issueGrant(
              record.withRefreshToken,
              record.expiresIn,
              record.refreshTokenExpiresIn,
            ),
            ...(record.scope !== undefined ? { scope: record.scope } : {}),
          });
          return;
        }
        if (grantType === "refresh_token") {
          const presented = form.get("refresh_token") ?? "";
          const record = refreshTokens.get(presented);
          if (!record || record.revoked) {
            json(200, { error: "bad_refresh_token" });
            return;
          }
          // Rotation: the presented refresh token dies and its access token
          // is retired, exactly as GitHub does.
          record.revoked = true;
          validAccessTokens.delete(record.accessToken);
          json(
            200,
            issueGrant(true, record.expiresIn, record.refreshTokenExpiresIn),
          );
          return;
        }
        json(400, { error: "unsupported_grant_type" });
        return;
      }

      // ── Revoke endpoint (github_app_grant: DELETE + Basic auth) ──
      if (path === "/login/oauth/revoke") {
        if (req.method === "DELETE") {
          const auth = req.headers["authorization"];
          if (typeof auth !== "string" || !auth.startsWith("Basic ")) {
            res.writeHead(401);
            res.end();
            return;
          }
          const body = await readBody(req);
          try {
            const parsed = JSON.parse(body) as { access_token?: unknown };
            if (typeof parsed.access_token === "string")
              validAccessTokens.delete(parsed.access_token);
          } catch {
            // Fall through to 204; nothing to revoke.
          }
          res.writeHead(204);
          res.end();
          return;
        }
        // RFC 7009 POST form.
        if (req.method === "POST") {
          const form = new URLSearchParams(await readBody(req));
          const token = form.get("token");
          if (token) validAccessTokens.delete(token);
          res.writeHead(200);
          res.end();
          return;
        }
      }

      res.writeHead(404);
      res.end();
    })().catch(() => {
      try {
        res.writeHead(500);
        res.end();
      } catch {
        // The response may already be sent.
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    mcpUrl: `${origin}/mcp`,
    issuer: `${origin}/login/oauth`,
    mintCode(options) {
      const code = `code_${randomBytes(12).toString("hex")}`;
      codes.set(code, {
        codeChallenge: options.codeChallenge,
        expiresIn: options.expiresIn,
        refreshTokenExpiresIn: options.refreshTokenExpiresIn,
        withRefreshToken: options.withRefreshToken ?? true,
        ...(options.scope !== undefined ? { scope: options.scope } : {}),
        used: false,
      });
      return code;
    },
    bearerTokensSeen: () => [...bearersSeen],
    tokenRequestCount: () => tokenRequests,
    grantTypeCounts: () => ({ ...grantCounts }),
    tokenRequestForms: () => tokenForms.map((f) => new URLSearchParams(f)),
    invalidateToken: (token) => {
      invalidTokens.add(token);
      validAccessTokens.delete(token);
    },
    setTokenMode: (mode) => {
      tokenModes.push(mode);
    },
    setAccountLogin: (login) => {
      accountLogin = login;
    },
    setToolsListFails: (fails) => {
      toolsListFails = fails;
    },
    issueAccessToken: () => {
      const token = mintAccessToken();
      validAccessTokens.add(token);
      return token;
    },
    setTools: (next, pageSize = 0) => {
      tools = next;
      toolsPageSize = pageSize;
    },
    setMetadataExtras: (extras) => {
      metadataExtras = extras;
    },
    // Idempotent: a test may close the fixture early to simulate an outage,
    // and afterEach closes it again.
    close: () => {
      closing ??= new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      });
      return closing;
    },
  };
}
