import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { ObjectId } from "mongodb";
import type { MongoMemoryReplSet } from "mongodb-memory-server";
import { DatabaseService } from "../../src/database/database.service";
import {
  MESSAGES_COLLECTION,
  RUNS_COLLECTION,
} from "../../src/modules/chats/chat";
import { MembershipsService } from "../../src/modules/memberships/memberships.service";
import { MODELS_COLLECTION } from "../../src/modules/models/model";
import { OperatorService } from "../../src/modules/operator/operator.service";
import { SessionsService } from "../../src/modules/sessions/sessions.service";
import { DEFAULT_TENANT_DB_NAME } from "../../src/modules/tenants/tenant";
import { UsersService } from "../../src/modules/users/users.service";
import {
  ADAPTER_TOKEN,
  AdapterProcess,
  readStream,
  type StreamEvent,
} from "../support/chat-stack";
import { testAuthConfig } from "../support/test-auth";
import {
  startApp,
  startReplicaSet,
  type RunningApp,
} from "../support/test-app";

// Helper agents end to end on a REAL model: platform-next → runtime adapter
// → pinned Codex → the real model gateway. Skipped unless REAL_GATEWAY_URL,
// REAL_GATEWAY_SECRET, REAL_MODEL_ID and REAL_MODEL_NAME are set. Storage is
// an in-memory replica set, so no shared database is touched; the gateway
// resolves REAL_MODEL_ID from its own catalog. The adapter test
// (runtime-adapter/test/codex/subagents-real.test.ts) covers the write and
// injection rules with a connector; this covers what the platform adds.

const GATEWAY = process.env.REAL_GATEWAY_URL ?? "";
const SECRET = process.env.REAL_GATEWAY_SECRET ?? "";
const MODEL_ID = process.env.REAL_MODEL_ID ?? "";
const MODEL_NAME = process.env.REAL_MODEL_NAME ?? "";
const enabled = Boolean(GATEWAY && SECRET && MODEL_ID && MODEL_NAME);

// Forwards to the real gateway and times each model request, so a slow
// reply shows where the time went (lead vs helper, size, duration).
class TimingProxy {
  readonly requests: {
    at: number;
    ms: number;
    bytes: number;
    child: boolean;
  }[] = [];
  url = "";
  private server!: Server;

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let child = false;
      try {
        const input =
          (JSON.parse(raw) as { input?: Record<string, unknown>[] }).input ??
          [];
        child = input.some(
          (i) => i.type === "agent_message" && i.author === "/root",
        );
      } catch {
        // Not JSON: timed anyway.
      }
      const entry = { at: Date.now(), ms: 0, bytes: raw.length, child };
      this.requests.push(entry);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers))
        if (v !== undefined && !["host", "content-length"].includes(k))
          headers[k] = Array.isArray(v) ? v.join(", ") : v;
      try {
        const up = await fetch(`${GATEWAY}${req.url}`, {
          method: req.method,
          headers,
          body: raw || undefined,
        });
        const out: Record<string, string> = {};
        up.headers.forEach((v, k) => {
          if (
            ![
              "content-length",
              "content-encoding",
              "transfer-encoding",
            ].includes(k)
          )
            out[k] = v;
        });
        res.writeHead(up.status, out);
        if (up.body)
          for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>)
            res.write(chunk);
        res.end();
      } catch (error) {
        res.writeHead(502).end(String((error as Error).message));
      }
      entry.ms = Date.now() - entry.at;
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  timeline(from: number, t0: number): string {
    return this.requests
      .slice(from)
      .map(
        (r) =>
          `+${((r.at - t0) / 1000).toFixed(1)}s ${r.child ? "helper" : "lead"} ` +
          `${(r.ms / 1000).toFixed(1)}s ${Math.round(r.bytes / 1024)}KB`,
      )
      .join(" | ");
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }
}
const TIMEOUT = 360_000;

// Small, self-contained tasks, so a helper needs no connector.
const PARALLEL_PROMPT =
  "Use two helper agents working in parallel. Helper one: compute 17 * 23 and reply with only the number. " +
  "Helper two: name the three largest planets in the solar system. Then give me both results.";

type Json = Record<string, unknown>;

interface Member {
  token: string;
  tenantId: ObjectId;
}

describe(
  "helper agents through the platform on a real model",
  { skip: !enabled },
  () => {
    let mongo: MongoMemoryReplSet;
    let running: RunningApp;
    let database: DatabaseService;
    const adapter = new AdapterProcess();
    const proxy = new TimingProxy();
    const findings: string[] = [];
    let alice: Member;
    let next = 0;

    before(async () => {
      mongo = await startReplicaSet();
      await proxy.start();
      await adapter.start();
      running = await startApp({
        mongodbUri: mongo.getUri(),
        auth: testAuthConfig(),
        chat: {
          adapterUrl: adapter.url,
          adapterToken: ADAPTER_TOKEN,
          gatewayUrl: proxy.url,
          gatewaySecret: SECRET,
          recoverySweepMs: 0,
          subAgents: 3,
        },
      });
      database = running.app.get(DatabaseService);
      const tenantId = new ObjectId();
      await running.app.get(OperatorService).provisionTenant({
        operator: "ops",
        tenantId,
        name: "Truex",
        kind: "default",
      });
      // The profile under the gateway's own ID, so the token the platform
      // signs names a profile the gateway knows. The platform never calls the
      // provider, so baseUrl here is not used.
      const now = new Date();
      await database
        .catalog()
        .collection(MODELS_COLLECTION)
        .insertOne({
          _id: ObjectId.createFromHexString(MODEL_ID),
          slug: "real-model",
          displayName: "Real model",
          shortLabel: "real",
          family: "other",
          wireApi: "chat",
          baseUrl: "https://example.invalid",
          modelName: MODEL_NAME,
          maxOutputTokens: 16_384,
          contextWindow: 200_000,
          autoCompactTokenLimit: 150_000,
          reasoningEffort: "low",
          sortOrder: 10,
          enabled: true,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          updatedBy: "test",
        } as never);
      alice = await member("alice", tenantId);
    });

    after(async () => {
      await running?.close();
      await adapter.close();
      await mongo?.stop();
      await proxy.close();
      console.log(
        `\nPLATFORM REAL-MODEL FINDINGS (${MODEL_NAME})\n- ${findings.join("\n- ")}\n`,
      );
    });

    async function member(
      subject: string,
      tenantId: ObjectId,
    ): Promise<Member> {
      const { user } = await running.app
        .get(UsersService)
        .findOrCreateFromIdentity({
          provider: "google",
          subject,
          email: `${subject}@example.test`,
          emailVerified: true,
          name: subject,
        });
      await running.app
        .get(MembershipsService)
        .join({ userId: user._id, tenantId, joinedVia: "signup" });
      const sessions = running.app.get(SessionsService);
      const created = await sessions.create(user._id);
      const issued = await sessions.refresh(
        created.refreshCredential,
        new Date(),
        tenantId,
      );
      return { token: issued.accessToken, tenantId };
    }

    function call(
      method: string,
      path: string,
      body?: unknown,
      signal?: AbortSignal,
    ) {
      return fetch(
        `${running.baseUrl}/api/v1${path}${path.includes("?") ? "&" : "?"}tenantId=${alice.tenantId.toHexString()}`,
        {
          method,
          headers: {
            authorization: `Bearer ${alice.token}`,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        },
      );
    }

    async function json<T>(res: Response, status: number): Promise<T> {
      const text = await res.text();
      assert.equal(res.status, status, text);
      return JSON.parse(text) as T;
    }

    async function agent(helpers: boolean): Promise<string> {
      return (
        await json<{ agent: { id: string; helpers: boolean } }>(
          await call("POST", "/agents", {
            clientRequestId: `req-${++next}-${Date.now()}`,
            scope: "personal",
            name: helpers ? "Scout" : "Solo",
            description: "Answers questions.",
            modelId: MODEL_ID,
            helpers,
          }),
          201,
        )
      ).agent.id;
    }

    interface Receipt {
      chat: { id: string };
      run: { id: string };
    }

    async function start(agentId: string, text: string): Promise<Receipt> {
      return json<Receipt>(
        await call("POST", "/chats", {
          agentId,
          clientMessageId: `cm-${++next}-${Date.now()}`,
          text,
        }),
        202,
      );
    }

    const streamOf = (r: Receipt, signal?: AbortSignal) =>
      call(
        "GET",
        `/chats/${r.chat.id}/runs/${r.run.id}/stream`,
        undefined,
        signal,
      );

    const ofType = (events: StreamEvent[], type: string) =>
      events.filter((e) => e.type === type).map((e) => e.data);

    const savedOf = (events: StreamEvent[]) => {
      const saved = events.at(-1);
      assert.equal(
        saved?.type,
        "saved",
        JSON.stringify(events.map((e) => e.type)),
      );
      return saved!.data as { run: Json; messages: Json[] };
    };

    const runDoc = (runId: string) =>
      database
        .tenantDb(DEFAULT_TENANT_DB_NAME)
        .collection(RUNS_COLLECTION)
        .findOne({ _id: ObjectId.createFromHexString(runId) });

    const total = (u: unknown) => {
      const x = (u ?? {}) as Record<string, number>;
      return (x.input ?? 0) + (x.output ?? 0);
    };

    test(
      "helpers stream live, are saved once as rows and are billed with the run",
      { timeout: TIMEOUT },
      async () => {
        const receipt = await start(await agent(true), PARALLEL_PROMPT);
        const startedAt = performance.now();
        const res = await streamOf(receipt);
        assert.equal(res.status, 200);
        const from = proxy.requests.length;
        const t0 = Date.now();
        const marks: string[] = [];
        const events = await readStream(res, (e) => {
          if (["agent", "completed", "saved"].includes(e.type))
            marks.push(
              `${e.type}${e.type === "agent" ? `:${String(e.data.status)}` : ""}@+${((Date.now() - t0) / 1000).toFixed(1)}s`,
            );
        });
        findings.push(
          `parallel timeline: [${proxy.timeline(from, t0)}] events [${marks.join(", ")}]`,
        );
        const ms = Math.round(performance.now() - startedAt);
        const saved = savedOf(events);
        assert.equal(
          saved.run.status,
          "completed",
          JSON.stringify(saved.run.error),
        );

        const live = ofType(events, "agent");
        const completedAgents = (ofType(events, "completed")[0]?.agents ??
          []) as Json[];
        const rows = saved.messages.filter((m) => m.agent);
        findings.push(
          `parallel: ${rows.length} helper rows (${rows.map((m) => (m.agent as Json).status).join(",")}), ` +
            `${live.length} live agent events, ${ms} ms, run usage ${total(saved.run.usage)} tokens`,
        );
        assert.ok(
          rows.length >= 1,
          "the model used at least one helper when asked",
        );
        assert.equal(rows.length, completedAgents.length, "one row per helper");
        assert.ok(
          live.length >= rows.length,
          "helpers streamed before the run settled",
        );
        for (const m of rows) {
          const a = m.agent as Json;
          assert.equal(m.role, "tool");
          assert.ok(
            ["completed", "failed", "stopped"].includes(String(a.status)),
          );
          assert.equal(a.preview, undefined, "the live preview is never saved");
          if (a.result !== undefined)
            assert.ok(String(a.result).length <= 4000);
        }
        // Rows sit before the lead's final answer, and the answer is the lead's.
        const lastReply = saved.messages
          .filter((m) => m.role === "assistant")
          .at(-1);
        assert.ok(
          lastReply && String(lastReply.text).trim().length > 0,
          "the lead answered",
        );
        for (const m of rows) assert.ok(Number(m.seq) < Number(lastReply!.seq));

        // Billing: the run's usage covers every helper's own usage.
        const helperTokens = rows.reduce(
          (n, m) => n + total((m.agent as Json).usage),
          0,
        );
        assert.ok(
          total(saved.run.usage) > helperTokens,
          "run usage includes helpers",
        );
        assert.equal((await runDoc(receipt.run.id))?.helperCount, rows.length);

        // Read back through the API exactly as saved; nothing is stored twice.
        const body = await json<{ messages: Json[] }>(
          await call("GET", `/chats/${receipt.chat.id}`),
          200,
        );
        assert.deepEqual(
          body.messages.filter((m) => m.agent).map((m) => m.agent),
          rows.map((m) => m.agent),
        );
        assert.ok(!JSON.stringify(body).includes("runtimeItemId"));
        const stored = await database
          .tenantDb(DEFAULT_TENANT_DB_NAME)
          .collection(MESSAGES_COLLECTION)
          .countDocuments({
            runId: ObjectId.createFromHexString(receipt.run.id),
            runtimeItemId: /^agent:/,
          });
        assert.equal(stored, rows.length);
      },
    );

    test(
      "a reconnect mid-run shows the same helpers",
      { timeout: TIMEOUT },
      async () => {
        const receipt = await start(await agent(true), PARALLEL_PROMPT);
        const first = new AbortController();
        const seen = new Set<string>();
        try {
          await readStream(await streamOf(receipt, first.signal), (event) => {
            if (event.type !== "agent") return;
            seen.add(String(event.data.agentId));
            first.abort();
          });
        } catch {
          // Aborted on purpose after the first helper event.
        }
        const events = await readStream(await streamOf(receipt));
        const snapshot = events.find((e) => e.type === "snapshot")?.data;
        const snapAgents = ((snapshot?.agents ?? []) as Json[]).map((a) =>
          String(a.agentId),
        );
        const saved = savedOf(events);
        const finalAgents = (
          (ofType(events, "completed")[0]?.agents ?? []) as Json[]
        ).map((a) => String(a.agentId));
        findings.push(
          `reconnect: saw ${seen.size} helper(s) before dropping, snapshot had ${snapAgents.length}, ` +
            `final ${finalAgents.length}, status ${String(saved.run.status)}`,
        );
        assert.ok(seen.size >= 1, "a helper started before the drop");
        // Whatever this tab saw before it dropped is still there after.
        for (const id of seen)
          assert.ok(
            snapAgents.includes(id) || finalAgents.includes(id),
            `helper ${id} survives the reconnect`,
          );
      },
    );

    test(
      "Stop from the platform settles every helper as not running",
      { timeout: TIMEOUT },
      async () => {
        const receipt = await start(await agent(true), PARALLEL_PROMPT);
        let stopped = false;
        const events = await readStream(
          await streamOf(receipt),
          async (event) => {
            if (event.type !== "agent" || stopped) return;
            stopped = true;
            await json(
              await call(
                "POST",
                `/chats/${receipt.chat.id}/runs/${receipt.run.id}/stop`,
              ),
              202,
            );
          },
        );
        const saved = savedOf(events);
        const rows = saved.messages.filter((m) => m.agent);
        findings.push(
          `stop: status ${String(saved.run.status)}, rows ${rows.map((m) => (m.agent as Json).status).join(",") || "none"}`,
        );
        assert.ok(stopped, "a helper started before the stop");
        // The model may finish in the instant before the stop lands.
        assert.ok(["stopped", "completed"].includes(String(saved.run.status)));
        for (const m of rows)
          assert.notEqual((m.agent as Json).status, "running");
      },
    );

    test(
      "an agent without helpers never starts one",
      { timeout: TIMEOUT },
      async () => {
        const receipt = await start(await agent(false), PARALLEL_PROMPT);
        const events = await readStream(await streamOf(receipt));
        const saved = savedOf(events);
        assert.equal(
          saved.run.status,
          "completed",
          JSON.stringify(saved.run.error),
        );
        assert.equal(ofType(events, "agent").length, 0);
        assert.equal(saved.messages.filter((m) => m.agent).length, 0);
        assert.equal((await runDoc(receipt.run.id))?.helperCount, undefined);
        findings.push("helpers off: no helper events or rows");
      },
    );
  },
);
