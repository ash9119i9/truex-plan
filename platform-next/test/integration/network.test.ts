import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ObjectId } from "mongodb";
import type { MongoMemoryReplSet } from "mongodb-memory-server";
import type { AppConfig } from "../../src/config/app-config";
import { DatabaseService } from "../../src/database/database.service";
import { AUDIT_COLLECTION, type AuditDoc } from "../../src/modules/audit/audit";
import { MembershipsService } from "../../src/modules/memberships/memberships.service";
import { BASELINE_HOSTS } from "../../src/modules/network/network-policy";
import { TenantNetworkService } from "../../src/modules/network/tenant-network.service";
import { OperatorService } from "../../src/modules/operator/operator.service";
import { SessionsService } from "../../src/modules/sessions/sessions.service";
import { dbNameFor } from "../../src/modules/tenants/tenant";
import { UsersService } from "../../src/modules/users/users.service";
import {
  builtinDefinition,
  modelDefinition,
} from "../support/catalog-fixtures";
import { ADAPTER_TOKEN, GATEWAY_SECRET } from "../support/chat-stack";
import { resetOwnedData } from "../support/reset";
import { testAuthConfig } from "../support/test-auth";
import {
  startApp,
  startReplicaSet,
  type RunningApp,
} from "../support/test-app";

// The tenant admin allowlist (GET/PUT /tenant/network) and the network
// policy a run carries with CHAT_SANDBOX_NETWORK on. The runtime adapter is a
// stand-in that records each start body and refuses it, so no Codex runs.

interface Member {
  userId: ObjectId;
  token: string;
  email: string;
}

// Records POST /v1/runs bodies. With `blocks` set, a start streams a short
// reply whose sandbox requests the proxy refused (network.blocked, as the
// real adapter sends them) and completes; otherwise every request gets a
// final refusal.
class CapturingAdapter {
  readonly starts: Record<string, unknown>[] = [];
  blocks: Record<string, unknown>[] | null = null;
  private server?: Server;
  private runs = 0;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/v1/runs") {
          const body = JSON.parse(raw) as Record<string, unknown>;
          this.starts.push(body);
          if (this.blocks) return this.stream(res, body, this.blocks);
        }
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "INVALID_REQUEST",
              message: "stand-in",
              retryable: false,
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, "127.0.0.1", resolve),
    );
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  private stream(
    res: import("node:http").ServerResponse,
    body: Record<string, unknown>,
    blocks: Record<string, unknown>[],
  ): void {
    const threadId =
      typeof body.threadId === "string" ? body.threadId : `th_${++this.runs}`;
    const turnId = `tu_${++this.runs}`;
    const reply = {
      type: "reply",
      itemId: `r_${turnId}`,
      text: "That site was blocked.",
      completed: true,
    };
    let seq = 0;
    const frame = (event: string, data: unknown) =>
      `id: ${++seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      frame("run.accepted", { runId: body.runId, threadId, turnId }) +
        blocks.map((block) => frame("network.blocked", block)).join("") +
        frame("item.completed", { itemId: reply.itemId, text: reply.text }) +
        frame("run.completed", {
          status: "completed",
          threadId,
          turnId,
          items: [
            ...blocks.map((block) => ({ type: "network", ...block })),
            reply,
          ],
          usage: null,
        }),
    );
  }

  async close(): Promise<void> {
    await new Promise((resolve) => this.server?.close(resolve));
  }
}

describe("sandbox network: tenant allowlist and run policy", () => {
  let mongo: MongoMemoryReplSet;
  let running: RunningApp | undefined;
  let database: DatabaseService;
  const adapter = new CapturingAdapter();
  const auth: AppConfig["auth"] = testAuthConfig();
  let tenantId: ObjectId;
  let builtinId: string;
  let admin: Member;
  let user: Member;
  let next = 0;

  before(async () => {
    mongo = await startReplicaSet();
    await adapter.start();
    running = await startApp({
      mongodbUri: mongo.getUri(),
      auth,
      chat: {
        adapterUrl: adapter.url,
        adapterToken: ADAPTER_TOKEN,
        gatewayUrl: "http://127.0.0.1:9",
        gatewaySecret: GATEWAY_SECRET,
        recoverySweepMs: 0,
        sandboxNetwork: true,
      },
    });
    database = running.app.get(DatabaseService);
  });

  after(async () => {
    await running?.close();
    await adapter.close();
    await mongo?.stop();
  });

  beforeEach(async () => {
    adapter.starts.length = 0;
    adapter.blocks = null;
    await resetOwnedData(database);
    const operator = running!.app.get(OperatorService);
    tenantId = new ObjectId();
    await operator.provisionTenant({
      operator: "ops",
      tenantId,
      name: "Truex",
      kind: "default",
    });
    await operator.putModel({ operator: "ops", definition: modelDefinition() });
    builtinId = (
      await operator.putBuiltinAgent({
        operator: "ops",
        definition: builtinDefinition(),
      })
    ).agent.id;
    admin = await member("netadmin");
    user = await member("netuser");
    await operator.assignRole({
      operator: "ops",
      user: admin.email,
      tenantId,
      role: "admin",
    });
  });

  async function member(subject: string): Promise<Member> {
    const email = `${subject}@example.test`;
    const { user: doc } = await running!.app
      .get(UsersService)
      .findOrCreateFromIdentity({
        provider: "google",
        subject,
        email,
        emailVerified: true,
        name: subject,
      });
    await running!.app
      .get(MembershipsService)
      .join({ userId: doc._id, tenantId, joinedVia: "signup" });
    const sessions = running!.app.get(SessionsService);
    const created = await sessions.create(doc._id);
    const issued = await sessions.refresh(
      created.refreshCredential,
      new Date(),
      tenantId,
    );
    return { userId: doc._id, token: issued.accessToken, email };
  }

  function call(who: Member, method: string, path: string, body?: unknown) {
    return fetch(
      `${running!.baseUrl}/api/v1${path}?tenantId=${tenantId.toHexString()}`,
      {
        method,
        headers: {
          authorization: `Bearer ${who.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
  }

  async function startChat(who: Member): Promise<Record<string, unknown>> {
    const seen = adapter.starts.length;
    const res = await call(who, "POST", "/chats", {
      agentId: builtinId,
      clientMessageId: `network-${++next}-${Date.now()}`,
      text: "hello",
    });
    assert.equal(res.status, 202, await res.text());
    for (let i = 0; i < 100 && adapter.starts.length === seen; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const body = adapter.starts[seen];
    assert.ok(body, "the run reached the adapter");
    return body;
  }

  test("members read the list; only an admin changes it, with a revision check", async () => {
    const empty = await call(user, "GET", "/tenant/network");
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), {
      network: { hosts: [], revision: 0 },
    });

    const denied = await call(user, "PUT", "/tenant/network", {
      hosts: ["docs.acme.com"],
      revision: 0,
    });
    assert.equal(denied.status, 403);

    const saved = await call(admin, "PUT", "/tenant/network", {
      hosts: ["docs.acme.com", "API.acme.com"],
      revision: 0,
    });
    assert.equal(saved.status, 200, await saved.clone().text());
    const view = ((await saved.json()) as { network: Record<string, unknown> })
      .network;
    assert.deepEqual(view.hosts, ["api.acme.com", "docs.acme.com"]);
    assert.equal(view.revision, 1);

    // An admin editing an old copy is refused, not merged.
    const stale = await call(admin, "PUT", "/tenant/network", {
      hosts: ["other.acme.com"],
      revision: 0,
    });
    assert.equal(stale.status, 409);

    const read = (await (
      await call(user, "GET", "/tenant/network")
    ).json()) as {
      network: { hosts: string[] };
    };
    assert.deepEqual(read.network.hosts, ["api.acme.com", "docs.acme.com"]);

    const audits = await database
      .catalog()
      .collection<AuditDoc>(AUDIT_COLLECTION)
      .find({ action: "tenant.network.update", tenantId })
      .toArray();
    assert.deepEqual(audits.map((a) => a.result).sort(), ["denied", "success"]);
    const success = audits.find((a) => a.result === "success")!;
    assert.equal(success.details?.added, "api.acme.com,docs.acme.com");
  });

  test("private addresses and wildcards are refused whatever the role", async () => {
    for (const host of [
      "169.254.169.254",
      "db.internal",
      "*.acme.com",
      "localhost",
    ]) {
      const res = await call(admin, "PUT", "/tenant/network", {
        hosts: [host],
        revision: 0,
      });
      assert.equal(res.status, 400, host);
      assert.doesNotMatch(
        await res.text(),
        new RegExp(host.replace(/[.*]/g, "\\$&")),
      );
    }
  });

  test("a run carries the baseline and the tenant's sites, read fresh after a change", async () => {
    const first = await startChat(user);
    assert.deepEqual(first.network, {
      hosts: [...BASELINE_HOSTS].sort(),
      connectors: [],
    });

    const saved = await call(admin, "PUT", "/tenant/network", {
      hosts: ["docs.acme.com"],
      revision: 0,
    });
    assert.equal(saved.status, 200);
    const second = await startChat(user);
    assert.deepEqual(second.network, {
      hosts: [...BASELINE_HOSTS, "docs.acme.com"].sort(),
      connectors: [],
    });
  });

  // The tenant's hosts are read before the chat or agent, so a send that is
  // refused first never awaits that read. Its failure must not surface as an
  // unhandled rejection, and a start that does await it fails as before.
  test("a failing tenant network read never goes unhandled, and a start that needs it sends nothing", async () => {
    const tenantNetwork = running!.app.get(TenantNetworkService);
    const original = tenantNetwork.runHosts.bind(tenantNetwork);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    tenantNetwork.runHosts = () => Promise.reject(new Error("network down"));
    try {
      const missing = await call(
        user,
        "POST",
        `/chats/${new ObjectId().toHexString()}/messages`,
        { clientMessageId: `network-${++next}-${Date.now()}`, text: "hi" },
      );
      assert.equal(missing.status, 404);
      assert.equal(
        ((await missing.json()) as { error: { code: string } }).error.code,
        "NOT_FOUND",
      );

      const started = await call(user, "POST", "/chats", {
        agentId: builtinId,
        clientMessageId: `network-${++next}-${Date.now()}`,
        text: "hello",
      });
      assert.equal(started.status, 500);
      assert.equal(adapter.starts.length, 0);

      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    } finally {
      tenantNetwork.runHosts = original;
      process.off("unhandledRejection", onUnhandled);
    }
    // The failed start gave its send slot back: the next one runs.
    await startChat(user);
  });

  // Waits until the chat's run has been saved, then returns its messages.
  async function settled(
    who: Member,
    chatId: string,
  ): Promise<Array<Record<string, unknown>>> {
    for (let i = 0; i < 200; i++) {
      const res = await call(who, "GET", `/chats/${chatId}`);
      const body = (await res.json()) as {
        chat: { activeRunId: string | null };
        messages: Array<Record<string, unknown>>;
      };
      if (body.chat.activeRunId === null) return body.messages;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("the run was not saved");
  }

  async function send(
    who: Member,
    chatId: string,
  ): Promise<Record<string, unknown>> {
    const seen = adapter.starts.length;
    const res = await call(who, "POST", `/chats/${chatId}/messages`, {
      clientMessageId: `network-${++next}-${Date.now()}`,
      text: "again",
    });
    assert.equal(res.status, 202, await res.text());
    for (let i = 0; i < 100 && adapter.starts.length === seen; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const body = adapter.starts[seen];
    assert.ok(body, "the run reached the adapter");
    return body;
  }

  function cards(messages: Array<Record<string, unknown>>) {
    return messages
      .filter((m) => m.role === "tool" && m.network)
      .map((m) => ({ id: m.id as string, ...(m.network as object) })) as Array<
      { id: string } & Record<string, unknown>
    >;
  }

  test("a blocked site becomes a card only the owner answers; an allow reaches the next run", async () => {
    adapter.blocks = [
      {
        host: "docs.example.com",
        method: "CONNECT",
        kind: "unlisted",
        critical: false,
        grant: "chat",
      },
      // The runtime's claim is not trusted: a private address is never offered.
      {
        host: "127.0.0.1",
        method: "CONNECT",
        kind: "unlisted",
        critical: false,
        grant: "chat",
      },
      {
        host: "api.example.com",
        method: "DELETE",
        kind: "write",
        critical: true,
        grant: "chat",
        connector: { name: "site", displayName: "Site", account: "octo" },
      },
    ];
    const first = await startChat(user);
    const chatId = first.chatId as string;
    // The tenant's list is cached across tests; the first run shows it.
    const base = (first.network as { hosts: string[] }).hosts;
    const [site, loopback, write] = cards(await settled(user, chatId));
    assert.deepEqual(
      [site, loopback, write].map((c) => [c!.host, c!.kind, c!.grant]),
      [
        ["docs.example.com", "unlisted", "chat"],
        ["127.0.0.1", "unlisted", "none"],
        // Names a connection this run didn't have: never offered.
        ["api.example.com", "write", "none"],
      ],
    );
    assert.equal(site!.decision, undefined);

    const answer = (who: Member, card: { id: string }, decision: unknown) =>
      call(who, "POST", `/chats/${chatId}/messages/${card.id}/network`, {
        decision,
      });
    assert.equal((await answer(admin, site!, "allow_for_chat")).status, 404);
    assert.equal((await answer(user, site!, "allow_always")).status, 400);
    assert.equal((await answer(user, loopback!, "allow_once")).status, 400);
    assert.equal((await answer(user, write!, "allow_once")).status, 400);

    const allowed = await answer(user, site!, "allow_for_chat");
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { decision: "allow_for_chat" });
    // A retry is the same answer; a different one is refused.
    assert.equal((await answer(user, site!, "allow_for_chat")).status, 200);
    assert.equal((await answer(user, site!, "keep_blocked")).status, 409);
    assert.equal((await answer(user, loopback!, "keep_blocked")).status, 200);

    adapter.blocks = [
      {
        host: "files.example.org",
        method: "CONNECT",
        kind: "unlisted",
        critical: false,
        grant: "chat",
      },
    ];
    const second = await send(user, chatId);
    assert.deepEqual(
      (second.network as { hosts: string[] }).hosts,
      [...base, "docs.example.com"].sort(),
    );
    const once = cards(await settled(user, chatId)).find(
      (c) => c.host === "files.example.org",
    )!;
    assert.equal((await answer(user, once, "allow_once")).status, 200);

    adapter.blocks = [];
    const third = await send(user, chatId);
    assert.deepEqual(
      (third.network as { hosts: string[] }).hosts,
      [...base, "docs.example.com", "files.example.org"].sort(),
    );
    await settled(user, chatId);
    // Allow once is used by one reply; Allow for this chat stays.
    for (let i = 0; i < 50; i++) {
      const chat = await database
        .tenantDb(dbNameFor("default", tenantId))
        .collection("chats")
        .findOne({});
      if ((chat?.networkGrants as unknown[] | undefined)?.length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const fourth = await send(user, chatId);
    assert.deepEqual(
      (fourth.network as { hosts: string[] }).hosts,
      [...base, "docs.example.com"].sort(),
    );
    await settled(user, chatId);

    // The member's allows are security events; blocks and answers are in the
    // chat's approval records. No tokens, no bodies.
    const events = await database
      .catalog()
      .collection<AuditDoc>(AUDIT_COLLECTION)
      .find({ action: "chat.network.allow" })
      .toArray();
    assert.deepEqual(
      events.map((e) => [e.details?.host, e.details?.scope]).sort(),
      [
        ["docs.example.com", "chat"],
        ["files.example.org", "once"],
      ],
    );
    const records = await database
      .tenantDb(dbNameFor("default", tenantId))
      .collection("tool_approvals")
      .find({ kind: "network" })
      .toArray();
    assert.deepEqual(records.map((r) => [r.tool, r.decision, r.auto]).sort(), [
      ["CONNECT 127.0.0.1", "deny", false],
      ["CONNECT 127.0.0.1", "deny", true],
      ["CONNECT docs.example.com", "allow_for_chat", false],
      ["CONNECT docs.example.com", "deny", true],
      ["CONNECT files.example.org", "allow", false],
      ["CONNECT files.example.org", "deny", true],
      ["DELETE api.example.com", "deny", true],
    ]);
  });
});
