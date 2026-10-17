// Local browser verification only: no .env, real credentials or existing DB.
// Chat runs on the real stack: the runtime adapter as its own process with
// the pinned Codex, behind a loopback stand-in for the model gateway. A
// control server on :4103 lets a browser driver script the model's replies.
import { createServer, type IncomingMessage } from "node:http";
import { ObjectId } from "mongodb";
import { createApp } from "../../src/app";
import { OperatorService } from "../../src/modules/operator/operator.service";
import {
  builtinDefinition,
  geminiDefinition,
  modelDefinition,
} from "./catalog-fixtures";
import {
  ADAPTER_TOKEN,
  AdapterProcess,
  FakeGateway,
  GATEWAY_SECRET,
  type Behavior,
} from "./chat-stack";
import { FakeGoogle } from "./fake-google";
import { startReplicaSet } from "./test-app";
import {
  TEST_GOOGLE_CLIENT_ID,
  testAuthConfig,
  testGoogleConfig,
} from "./test-auth";

async function main() {
  const cleanups: (() => Promise<unknown>)[] = [];
  // Every caller waits for the one cleanup.
  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      for (const cleanup of cleanups.reverse()) {
        try {
          await cleanup();
        } catch (error) {
          console.error("Fixture cleanup failed", error);
          process.exitCode = 1;
        }
      }
    })());
  try {
    const origin = "http://localhost:3100";
    const mongo = await startReplicaSet();
    cleanups.push(() => mongo.stop());
    const google = new FakeGoogle();
    await google.start();
    cleanups.push(() => google.stop());
    const gateway = new FakeGateway();
    await gateway.start();
    cleanups.push(() => gateway.close());
    // Slow enough to watch it stream.
    gateway.defaultBehavior = {
      kind: "reply",
      text: "Here is a **streamed** reply from the fixture model.\n\n- one\n- two",
      chunk: 4,
      delayMs: 40,
    };
    const adapter = new AdapterProcess();
    await adapter.start();
    cleanups.push(() => adapter.close());
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
        chat: {
          adapterUrl: adapter.url,
          adapterToken: ADAPTER_TOKEN,
          gatewayUrl: gateway.url,
          gatewaySecret: GATEWAY_SECRET,
        },
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
    // Synthetic catalog: fake secret ARNs, never called by this fixture.
    const operator = app.get(OperatorService);
    for (const definition of [modelDefinition(), geminiDefinition()])
      await operator.putModel({ operator: "browser-fixture", definition });
    await operator.putBuiltinAgent({
      operator: "browser-fixture",
      definition: builtinDefinition(),
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
    const control = createServer((req, res) => {
      void (async () => {
        const reply = (status: number, body: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (req.method === "POST" && req.url === "/script") {
          gateway.script.push(...((await jsonOf(req)) as Behavior[]));
          return reply(200, { queued: gateway.script.length });
        }
        if (req.method === "POST" && req.url === "/release") {
          gateway.release();
          return reply(200, {});
        }
        if (req.method === "POST" && req.url === "/reset") {
          gateway.script.length = 0;
          gateway.release();
          return reply(200, {});
        }
        if (req.method === "GET" && req.url === "/requests")
          return reply(200, {
            requests: gateway.requests.map((r) => ({
              modelId: r.modelId,
              input: JSON.stringify(r.body.input ?? null),
            })),
          });
        reply(404, {});
      })().catch((error: unknown) => {
        res.writeHead(400);
        res.end(String(error));
      });
    });
    await new Promise<void>((resolve, reject) => {
      control.once("error", reject);
      control.listen(4103, "127.0.0.1", resolve);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) =>
          control.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    // npx and tsx relay signals, so one Ctrl-C can arrive twice; the
    // second must not end the process before cleanup stops the adapter.
    const stop = () => void close().finally(() => process.exit());
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    console.log(
      "Synthetic browser fixture ready on 127.0.0.1:4101; fake Google on :4102; chat control on :4103. Frontend origin: http://localhost:3100",
    );
  } catch (error) {
    await close();
    throw error;
  }
}
async function jsonOf(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
