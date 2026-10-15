import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import {
  MongoMemoryServer,
  type MongoMemoryReplSet,
} from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import { APP_CONFIG, type AppConfig } from "../../src/config/app-config";
import { signAccessToken } from "../../src/modules/sessions/access-token";
import { REQUEST_ID_HEADER } from "../../src/common/http/request-id";
import {
  startApp,
  startReplicaSet,
  type RunningApp,
} from "../support/test-app";
import { TEST_ORIGIN } from "../support/test-auth";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("with MongoDB available", () => {
  let mongo: MongoMemoryReplSet;
  let running: RunningApp;

  before(async () => {
    mongo = await startReplicaSet();
    running = await startApp({ mongodbUri: mongo.getUri() });
  });

  after(async () => {
    await running?.close();
    await mongo?.stop();
  });

  test("liveness reports ok", async () => {
    const res = await fetch(`${running.baseUrl}/health/live`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });

  test("readiness reports ready", async () => {
    const res = await fetch(`${running.baseUrl}/health/ready`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ready" });
  });

  test("every response carries a generated request ID", async () => {
    const res = await fetch(`${running.baseUrl}/health/live`);
    assert.match(res.headers.get(REQUEST_ID_HEADER) ?? "", UUID);
  });

  test("a safe inbound request ID is kept", async () => {
    const res = await fetch(`${running.baseUrl}/health/live`, {
      headers: { [REQUEST_ID_HEADER]: "frontend-req-12345" },
    });
    assert.equal(res.headers.get(REQUEST_ID_HEADER), "frontend-req-12345");
  });

  test("an unsafe inbound request ID is replaced", async () => {
    for (const unsafe of [
      "short",
      "has spaces in it",
      "x".repeat(129),
      'a"b<c>d',
    ]) {
      const res = await fetch(`${running.baseUrl}/health/live`, {
        headers: { [REQUEST_ID_HEADER]: unsafe },
      });
      assert.match(res.headers.get(REQUEST_ID_HEADER) ?? "", UUID, unsafe);
    }
  });

  test("unknown routes return the error envelope", async () => {
    const res = await fetch(`${running.baseUrl}/api/v1/does-not-exist`);
    assert.equal(res.status, 404);
    const requestId = res.headers.get(REQUEST_ID_HEADER);
    assert.deepEqual(await res.json(), {
      error: { code: "NOT_FOUND", message: "Not found." },
      requestId,
    });
  });

  test("health routes are not served under the API prefix", async () => {
    const res = await fetch(`${running.baseUrl}/api/v1/health/live`);
    assert.equal(res.status, 404);
  });

  test("malformed JSON returns a bad-request envelope, not a stack trace", async () => {
    const res = await fetch(`${running.baseUrl}/api/v1/anything`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    assert.deepEqual(body.error, {
      code: "BAD_REQUEST",
      message: "The request is not valid.",
    });
  });

  test("the framework is not advertised", async () => {
    const res = await fetch(`${running.baseUrl}/health/live`);
    assert.equal(res.headers.get("x-powered-by"), null);
  });
});

describe("with MongoDB unavailable", () => {
  let running: RunningApp;

  before(async () => {
    // Nothing listens on port 1, so every connection attempt fails.
    running = await startApp({
      mongodbUri: "mongodb://127.0.0.1:1/?directConnection=true",
    });
  });

  after(async () => {
    await running?.close();
  });

  test("the app still starts and stays live", async () => {
    const res = await fetch(`${running.baseUrl}/health/live`);
    assert.equal(res.status, 200);
  });

  test("readiness fails fast with a 503 envelope", async () => {
    const started = Date.now();
    const res = await fetch(`${running.baseUrl}/health/ready`);
    const elapsedMs = Date.now() - started;
    assert.equal(res.status, 503);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    assert.deepEqual(body.error, {
      code: "UNAVAILABLE",
      message: "The database is unavailable.",
    });
    assert.ok(elapsedMs < 5_000, `readiness took ${elapsedMs} ms`);
  });

  test("an API call that needs the database answers 503, not 500", async () => {
    const res = await fetch(`${running.baseUrl}/api/v1/auth/refresh`, {
      method: "POST",
      headers: {
        origin: TEST_ORIGIN,
        cookie: `truex_refresh=${"a".repeat(24)}.${"b".repeat(43)}`,
      },
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "UNAVAILABLE");
  });

  // An outage must not look like a logout: the browser keeps its session.
  test("a valid access token during an outage answers 503, not 401", async () => {
    const config = running.app.get<AppConfig>(APP_CONFIG);
    const { token } = signAccessToken(config.auth, {
      userId: new ObjectId(),
      sessionId: new ObjectId(),
    });
    const res = await fetch(`${running.baseUrl}/api/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("www-authenticate"), null);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "UNAVAILABLE");
  });

  test("a tenant request during an outage answers 503, not 401 or 403", async () => {
    const config = running.app.get<AppConfig>(APP_CONFIG);
    const { token } = signAccessToken(config.auth, {
      userId: new ObjectId(),
      sessionId: new ObjectId(),
    });
    const res = await fetch(
      `${running.baseUrl}/api/v1/tenant?tenantId=${new ObjectId().toHexString()}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("www-authenticate"), null);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "UNAVAILABLE");
  });
});

describe("when MongoDB comes up after the app", () => {
  let running: RunningApp;
  let mongo: MongoMemoryServer | undefined;

  after(async () => {
    await running?.close();
    await mongo?.stop();
  });

  // Regression: the driver used to stay closed after a failed first connect,
  // so the app never became ready without a restart.
  test("readiness recovers without a restart", async () => {
    const port = await freePort();
    running = await startApp({
      mongodbUri: `mongodb://127.0.0.1:${port}/?directConnection=true`,
    });
    const down = await fetch(`${running.baseUrl}/health/ready`);
    assert.equal(down.status, 503);

    mongo = await MongoMemoryServer.create({ instance: { port } });
    const deadline = Date.now() + 20_000;
    let status = 0;
    while (Date.now() < deadline) {
      status = (await fetch(`${running.baseUrl}/health/ready`)).status;
      if (status === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(status, 200);
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}
