// Local browser verification only: no .env, real credentials or existing DB.
import { createServer } from "node:http";
import { ObjectId } from "mongodb";
import { createApp } from "../../src/app";
import { OperatorService } from "../../src/modules/operator/operator.service";
import { FakeGoogle } from "./fake-google";
import { startReplicaSet } from "./test-app";
import {
  TEST_GOOGLE_CLIENT_ID,
  testAuthConfig,
  testGoogleConfig,
} from "./test-auth";

async function main() {
  const cleanups: (() => Promise<unknown>)[] = [];
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        console.error("Fixture cleanup failed", error);
        process.exitCode = 1;
      }
    }
  };
  try {
    const origin = "http://localhost:3100";
    const mongo = await startReplicaSet();
    cleanups.push(() => mongo.stop());
    const google = new FakeGoogle();
    await google.start();
    cleanups.push(() => google.stop());
    const authorize = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1:4102");
      if (url.pathname !== "/authorize") {
        res.writeHead(404);
        res.end();
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const code = google.issueCode({
        challenge: url.searchParams.get("code_challenge") ?? "",
        claims: {
          iss: "https://accounts.google.com",
          aud: TEST_GOOGLE_CLIENT_ID,
          azp: TEST_GOOGLE_CLIENT_ID,
          sub: "browser-fixture-user",
          email: "ada@example.test",
          email_verified: true,
          name: "Ada",
          nonce: url.searchParams.get("nonce"),
          iat: now,
          exp: now + 3600,
        },
      });
      const callback = new URL(`${origin}/api/v1/auth/google/callback`);
      callback.searchParams.set("state", url.searchParams.get("state") ?? "");
      callback.searchParams.set("code", code);
      res.writeHead(302, { location: callback.href });
      res.end();
    });
    const config = testGoogleConfig();
    const app = await createApp(
      {
        port: 4101,
        mongodbUri: mongo.getUri(),
        catalogDbName: "truex_next_browser_fixture",
        auth: testAuthConfig({ allowedOrigins: [origin] }),
        google: {
          ...config,
          redirectUri: `${origin}/api/v1/auth/google/callback`,
          endpoints: {
            ...config.endpoints,
            authorization: "http://127.0.0.1:4102/authorize",
            token: `${google.baseUrl}/token`,
            jwks: `${google.baseUrl}/certs`,
          },
        },
      },
      { logger: false },
    );
    cleanups.push(() => app.close());
    await app.listen(4101, "127.0.0.1");
    await app.get(OperatorService).provisionTenant({
      operator: "browser-fixture",
      tenantId: new ObjectId("64b7f0c2a1b2c3d4e5f60719"),
      name: "Truex",
      kind: "default",
    });
    await new Promise<void>((resolve, reject) => {
      authorize.once("error", reject);
      authorize.listen(4102, "127.0.0.1", resolve);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) =>
          authorize.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    process.once("SIGINT", () => void close());
    process.once("SIGTERM", () => void close());
    console.log(
      "Synthetic browser fixture ready on 127.0.0.1:4101; fake Google on :4102. Frontend origin: http://localhost:3100",
    );
  } catch (error) {
    await close();
    throw error;
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
