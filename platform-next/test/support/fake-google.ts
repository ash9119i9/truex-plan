import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TEST_GOOGLE_CLIENT_ID } from "./test-auth";

// A local stand-in for Google's token and key endpoints. It behaves like the
// real ones where sign-in depends on it: codes are single-use and bound to a
// PKCE challenge, and ID tokens are RS256-signed with a published key.

export interface FakeGrant {
  // Claims for the ID token; ignored when idToken is given.
  claims: Record<string, unknown>;
  // The PKCE challenge the app sent to the authorization endpoint.
  challenge: string;
  // A raw ID token to return instead of signing claims.
  idToken?: string;
}

export class FakeGoogle {
  readonly kid = "fake-google-key";
  private readonly keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  private readonly grants = new Map<string, FakeGrant>();
  private server?: Server;
  private nextCode = 0;
  baseUrl = "";
  // Set to a non-200 status to make the token endpoint fail.
  tokenStatus = 200;
  tokenRequests = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        const answer = (status: number, value: unknown) => {
          res.writeHead(status, {
            "content-type": "application/json",
            "cache-control": "public, max-age=3600",
          });
          res.end(JSON.stringify(value));
        };
        if (req.method === "GET" && req.url === "/certs")
          return answer(200, {
            keys: [
              {
                ...this.keys.publicKey.export({ format: "jwk" }),
                kid: this.kid,
                alg: "RS256",
                use: "sig",
              },
            ],
          });
        if (req.method === "POST" && req.url === "/token") {
          this.tokenRequests++;
          if (this.tokenStatus !== 200)
            return answer(this.tokenStatus, { error: "server_error" });
          return this.token(new URLSearchParams(body), answer);
        }
        answer(404, { error: "not_found" });
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, "127.0.0.1", resolve),
    );
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  // What Google would hand back on the redirect after the user consents.
  issueCode(grant: FakeGrant): string {
    const code = `code-${++this.nextCode}`;
    this.grants.set(code, grant);
    return code;
  }

  signIdToken(
    claims: Record<string, unknown>,
    header: Record<string, unknown> = {
      alg: "RS256",
      kid: this.kid,
      typ: "JWT",
    },
  ): string {
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const input = `${encode(header)}.${encode(claims)}`;
    const signature = sign(
      "sha256",
      Buffer.from(input),
      this.keys.privateKey,
    ).toString("base64url");
    return `${input}.${signature}`;
  }

  private token(
    form: URLSearchParams,
    answer: (status: number, value: unknown) => void,
  ): void {
    const code = form.get("code") ?? "";
    const grant = this.grants.get(code);
    // Single use, like Google: a replayed code is refused.
    this.grants.delete(code);
    const verifier = form.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (
      !grant ||
      form.get("grant_type") !== "authorization_code" ||
      form.get("client_id") !== TEST_GOOGLE_CLIENT_ID ||
      form.get("client_secret") !== "test-client-secret" ||
      !form.get("redirect_uri") ||
      challenge !== grant.challenge
    )
      return answer(400, { error: "invalid_grant" });
    answer(200, {
      access_token: "unused",
      token_type: "Bearer",
      id_token: grant.idToken ?? this.signIdToken(grant.claims),
    });
  }
}
