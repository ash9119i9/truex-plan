// Chat latency with a distant MongoDB: the real app, runtime adapter and
// pinned Codex, a loopback model, and a TCP proxy that delays every MongoDB
// packet by half of BENCH_RTT_MS each way (default 300, the dev laptop's
// round trip to Atlas). Measures what the browser waits for: the start and
// send POSTs, send → first text, and completed → saved.
//
// Run: npx tsx bench/chat-latency.ts   (BENCH_RTT_MS=0 for loopback)
import "reflect-metadata";
import { createServer, connect, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { ObjectId } from "mongodb";
import { MemoryFileStore } from "../src/modules/chats/chat-files";
import { DatabaseService } from "../src/database/database.service";
import { ModelsService } from "../src/modules/models/models.service";
import { BuiltinAgentsService } from "../src/modules/agents/builtin-agents.service";
import { TenantNetworkService } from "../src/modules/network/tenant-network.service";
import { OperatorService } from "../src/modules/operator/operator.service";
import { UsersService } from "../src/modules/users/users.service";
import { MembershipsService } from "../src/modules/memberships/memberships.service";
import { SessionsService } from "../src/modules/sessions/sessions.service";
import {
  ADAPTER_TOKEN,
  AdapterProcess,
  FakeGateway,
  GATEWAY_SECRET,
  readStream,
} from "../test/support/chat-stack";
import { startApp, startReplicaSet } from "../test/support/test-app";
import {
  builtinDefinition,
  modelDefinition,
} from "../test/support/catalog-fixtures";

const RTT_MS = Number(process.env.BENCH_RTT_MS ?? 300);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 3);

// Forwards to `target`, holding each chunk RTT/2 in each direction. Chunks
// keep their order: each direction is one timer queue.
async function latencyProxy(target: number): Promise<number> {
  const delay = (from: Socket, to: Socket) =>
    from.on("data", (chunk) => {
      setTimeout(() => to.write(chunk), RTT_MS / 2);
    });
  const server = createServer((client) => {
    const upstream = connect(target, "127.0.0.1");
    delay(client, upstream);
    delay(upstream, client);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("close", end).on("error", end);
    upstream.on("close", end).on("error", end);
  });
  server.listen(0, "127.0.0.1");
  await new Promise((done) => server.once("listening", done));
  server.unref();
  return (server.address() as AddressInfo).port;
}

async function main() {
  const mongo = await startReplicaSet();
  const port = Number(new URL(mongo.getUri()).port);
  const proxied = await latencyProxy(port);
  const gateway = new FakeGateway();
  const adapter = new AdapterProcess();
  await gateway.start();
  await adapter.start();
  const running = await startApp({
    mongodbUri: `mongodb://127.0.0.1:${proxied}/?directConnection=true`,
    chat: {
      adapterUrl: adapter.url,
      adapterToken: ADAPTER_TOKEN,
      gatewayUrl: gateway.url,
      gatewaySecret: GATEWAY_SECRET,
      recoverySweepMs: 0,
      sandboxNetwork: true,
    },
    // Chat files on, as in dev (S3 there), so settle captures files.
    files: {
      bucket: "bench",
      region: "us-east-1",
      prefix: "",
      store: new MemoryFileStore(),
    },
  });
  const app = running.app;
  // BENCH_TRACE=1 prints each MongoDB command with its time since the
  // turn's POST, to see which wait on which.
  const trace: string[] = [];
  let traceT0 = 0;
  if (process.env.BENCH_TRACE === "1") {
    const client = (
      app.get(DatabaseService) as unknown as {
        client: import("mongodb").MongoClient;
      }
    ).client;
    client.on("commandStarted", (e) =>
      trace.push(
        `${Math.round(performance.now() - traceT0)
          .toString()
          .padStart(6)} ${e.commandName} ${
          (e.command[e.commandName] as string | undefined) ?? ""
        }`,
      ),
    );
  }
  const operator = app.get(OperatorService);
  const tenantId = new ObjectId();
  await operator.provisionTenant({
    operator: "ops",
    tenantId,
    name: "Bench",
    kind: "default",
  });
  const modelId = (
    await operator.putModel({ operator: "ops", definition: modelDefinition() })
  ).model.id;
  const builtinId = (
    await operator.putBuiltinAgent({
      operator: "ops",
      definition: builtinDefinition({ instructions: "You help." }),
    })
  ).agent.id;
  const { user } = await app.get(UsersService).findOrCreateFromIdentity({
    provider: "google",
    subject: "bench",
    email: "bench@example.test",
    emailVerified: true,
    name: "bench",
  });
  await app
    .get(MembershipsService)
    .join({ userId: user._id, tenantId, joinedVia: "signup" });
  const sessions = app.get(SessionsService);
  const created = await sessions.create(user._id);
  const { accessToken } = await sessions.refresh(
    created.refreshCredential,
    new Date(),
    tenantId,
  );

  let next = 0;
  const call = (method: string, path: string, body?: unknown) =>
    fetch(
      `${running.baseUrl}/api/v1${path}?tenantId=${tenantId.toHexString()}`,
      {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
  const userAgent = (
    (await (
      await call("POST", "/agents", {
        clientRequestId: `bench-req-${++next}`,
        scope: "personal",
        name: "Scout",
        description: "Finds sources.",
        modelId,
      })
    ).json()) as { agent: { id: string } }
  ).agent.id;

  // One turn: the POST, then its stream to the end.
  // BENCH_EXPIRE=1 lets every catalog and tenant cache lapse before each
  // turn, as for the first message after their TTL (30–60 s) on a server.
  const expire = () => {
    if (process.env.BENCH_EXPIRE !== "1") return;
    type Cached = { value?: { expires: number } };
    for (const [service, field] of [
      [ModelsService, "enabledCache"],
      [BuiltinAgentsService, "cache"],
    ] as const) {
      const cache = (app.get(service) as unknown as Record<string, Cached>)[
        field
      ];
      if (cache?.value) cache.value.expires = Date.now() - 1;
    }
    const network = app.get(TenantNetworkService) as unknown as {
      cache: Map<string, { expires: number }>;
    };
    for (const entry of network.cache.values()) entry.expires = Date.now() - 1;
  };

  async function turn(path: string, body: Record<string, unknown>) {
    expire();
    const t0 = performance.now();
    traceT0 = t0;
    trace.length = 0;
    const res = await call("POST", path, {
      ...body,
      clientMessageId: `bench-cm-${++next}`,
      text: "Hello",
    });
    const post = performance.now() - t0;
    const receipt = (await res.json()) as {
      chat: { id: string };
      run: { id: string };
    };
    if (!res.ok) throw new Error(JSON.stringify(receipt));
    const timing = res.headers.get("server-timing") ?? "";
    const stream = await call(
      "GET",
      `/chats/${receipt.chat.id}/runs/${receipt.run.id}/stream`,
    );
    let firstText = 0;
    let completedAt = 0;
    let savedAt = 0;
    await readStream(stream, (event) => {
      const now = performance.now();
      if (event.type === "delta" && !firstText) firstText = now - t0;
      if (event.type === "completed") completedAt = now;
      if (event.type === "saved") savedAt = now;
      if (trace.length)
        trace.push(
          `${Math.round(now - t0)
            .toString()
            .padStart(6)} <${event.type}>`,
        );
    });
    if (trace.length) console.log(`${path}\n${trace.join("\n")}`);
    const db = /db;dur=[\d.]+;desc="MongoDB \((\d+) call/.exec(timing)?.[1];
    return {
      chatId: receipt.chat.id,
      post,
      firstText,
      settle: savedAt - completedAt,
      dbCalls: Number(db ?? 0),
    };
  }

  const rows: Array<Record<string, string | number>> = [];
  const row = (name: string, r: Awaited<ReturnType<typeof turn>>) =>
    rows.push({
      step: name,
      "POST ms": Math.round(r.post),
      "POST db calls": r.dbCalls,
      "send→first text ms": Math.round(r.firstText),
      "completed→saved ms": Math.round(r.settle),
    });
  // Warm the catalog caches and connections once, as a running server is.
  await turn("/chats", { agentId: builtinId });
  for (let i = 0; i < ROUNDS; i++) {
    for (const [name, agentId] of [
      ["start (built-in)", builtinId],
      ["start (user agent)", userAgent],
    ] as const) {
      const started = await turn("/chats", { agentId });
      row(name, started);
      row(
        `send (${name.slice(7, -1)})`,
        await turn(`/chats/${started.chatId}/messages`, {}),
      );
    }
  }
  console.log(`MongoDB round trip: ${RTT_MS} ms`);
  console.table(rows);
  await running.close();
  await adapter.close();
  await gateway.close();
  await mongo.stop();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
