/** Explicitly opt-in real provider pilot. Reads configured profiles; all execution state is isolated. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { parse } from "dotenv";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import { createGateway } from "../../model-gateway/src/server";
import { Store } from "../src/store";
import { PlatformService } from "../src/service";
import { tenantContext } from "../src/tenant";
import { userContext } from "../src/user";
import { AutomationService } from "../src/automation/service";
import { AutomationTemporalClient } from "../src/automation/temporal";
import { createAutomationActivities } from "../src/automation/activities";
import { freePort } from "./harness";
import { mcpConfig } from "../src/mcp";

const root = resolve(__dirname, "../..");
async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 6_000).unref();
  });
}
async function main() {
  if (process.env.AUTOMATION_LIVE_PILOT !== "on")
    throw new Error(
      "Set AUTOMATION_LIVE_PILOT=on after real-provider execution is authorized",
    );
  Runtime.install({ logger: new DefaultLogger("ERROR") });
  const pin = JSON.parse(await readFile(join(root, "codex.lock.json"), "utf8"));
  const build = JSON.parse(
    await readFile(join(root, ".runtime/codex-build.json"), "utf8"),
  );
  assert.equal(
    build.revision,
    pin.revision,
    "native artifact revision must match project pin",
  );
  const checksum = createHash("sha256");
  for await (const chunk of createReadStream(join(root, pin.binary)))
    checksum.update(chunk);
  const nativeChecksum = checksum.digest("hex");
  assert.equal(
    nativeChecksum,
    build.sha256,
    "native artifact must match recorded build checksum",
  );
  const sourceEnv = parse(await readFile(join(root, "platform/.env")));
  const source = new MongoClient(sourceEnv.MONGO_URI, {
    serverSelectionTimeoutMS: 3_000,
  });
  let profile: any;
  let connector: any;
  try {
    await source.connect();
    const profiles = await source
      .db(sourceEnv.CATALOG_MONGO_DB || sourceEnv.MONGO_DB)
      .collection("truex_models")
      .find({ enabled: { $ne: false } })
      .toArray();
    profile = profiles.find(
      (entry) =>
        (!process.env.PILOT_MODEL_PROFILE_ID ||
          String(entry._id) === process.env.PILOT_MODEL_PROFILE_ID) &&
        ["anthropic", "gemini", "chat"].includes(String(entry.wireApi)) &&
        !!(entry.apiKey || entry.apikey),
    );
    if (!profile)
      throw new Error("No usable configured provider profile is available");
    if (process.env.PILOT_CONNECTOR_ID) {
      const configured = await source
        .db(sourceEnv.MONGO_DB)
        .collection("truex_mcp")
        .find({ enabled: { $ne: false } })
        .toArray();
      connector = configured.find(
        (entry) => String(entry._id) === process.env.PILOT_CONNECTOR_ID,
      );
      if (!connector)
        throw new Error("Selected configured connector is unavailable");
      // Only the isolated copy acquires explicit scope and a restricted tool list.
      for (const name of [
        "MCP_ALLOWED_PRIVATE_HOSTS",
        "MCP_ENCRYPTION_KEY",
        "MCP_ENCRYPTION_KID",
        "MCP_ENCRYPTION_KEYS",
      ])
        if (sourceEnv[name]) process.env[name] = sourceEnv[name];
    }
  } finally {
    await source.close();
  }
  const home = await mkdtemp(join(tmpdir(), "truex-live-pilot-"));
  let mongo: MongoMemoryReplSet | undefined;
  let environment: TestWorkflowEnvironment | undefined;
  let store: Store | undefined;
  let platform: PlatformService | undefined;
  let runtime: ChildProcess | undefined;
  let gateway: ReturnType<typeof createGateway> | undefined;
  let worker: Worker | undefined;
  const scheduled = process.env.PILOT_TRIGGER === "scheduled";
  const receipts: Record<string, any> = {
    trigger: scheduled ? "scheduled" : "manual",
    nativeRevision: pin.revision,
    nativeSha256: nativeChecksum,
    at: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    model: profile.modelName,
    wireApi: profile.wireApi,
    sourceProfileId: String(profile._id),
    prompt: connector
      ? `Call the configured ${connector.name} connector get_apps tool exactly once with limit=1, offset=0, published="true". This is an authorized read-only metadata lookup. If and only if the tool succeeds, return exactly AUTOMATION_CONNECTOR_PILOT_OK. Do not return application names, IDs, data, credentials or URLs. Do not call other tools or perform mutations.`
      : "Return exactly AUTOMATION_PILOT_OK. Do not use any tools or external actions.",
    browserRequired: false,
    externalToolActions: !!connector,
    ...(connector
      ? {
          connectorId: String(connector._id),
          connectorName: connector.name,
          connectorScope: "user",
          connectorOwner: "pilot-owner",
          allowedConnectorTools: ["get_apps"],
          sourceConnectorMutated: false,
        }
      : {}),
  };
  try {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    store = await new Store(
      mongo.getUri(),
      "automation_live_pilot",
      "automation_live_catalog",
    ).connect();
    assert.equal(await store.supportsTransactions(), true);
    const secret = randomUUID() + randomUUID();
    // Real configured provider, real adapter; never substitute synthetic model output.
    gateway = createGateway({
      secret,
      findProfile: async (id) => (id === String(profile._id) ? profile : null),
      log: () => {},
      upstreamFirstByteTimeoutMs: 60_000,
      upstreamIdleTimeoutMs: 60_000,
    });
    await new Promise<void>((resolve) =>
      gateway!.listen(0, "127.0.0.1", resolve),
    );
    process.env.MODEL_GATEWAY_URL = `http://127.0.0.1:${(gateway.address() as any).port}`;
    process.env.MODEL_GATEWAY_SECRET = secret;
    process.env.AUTH_MODE = "dev";
    process.env.AUTOMATIONS_ENABLED = "on";
    process.env.AGENT_WORKSPACE = join(home, "workspace");
    await store.profiles.insertOne(profile);
    await store.tenantRegistry.insertOne({
      _id: "default",
      name: "Isolated live pilot",
      dbName: store.database,
      status: "active",
      allowedModelIds: [String(profile._id)],
      allowedSkillIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await store.agents.insertOne({
      _id: "live-read-only",
      name: "Live read-only verification",
      modelProfileId: profile._id,
      enabled: true,
      createdBy: "pilot-owner",
      scope: "general",
      systemPrompt: connector
        ? "Follow the authorized read-only metadata lookup exactly. Only get_apps is authorized. Do not mutate data or disclose application metadata, credentials or URLs."
        : "Answer the user instruction exactly. Do not use tools or perform external actions.",
      sandbox: "read-only",
      approvalPolicy: "on-request",
      skillIds: [],
      mcpProfileIds: [],
    } as any);
    if (connector) {
      const restricted = mcpConfig(connector);
      assert.ok(restricted.url && !restricted.command);
      await store.mcp.insertOne({
        _id: `isolated-${String(connector._id)}`,
        name: connector.name,
        enabled: true,
        transport: "http",
        scope: "user",
        ownerId: "pilot-owner",
        agentIds: ["live-read-only"],
        config: {
          ...restricted,
          enabled_tools: ["get_apps"],
          default_tools_approval_mode: "approve",
        },
      } as any);
    }
    const runtimePort = await freePort();
    const runtimeUrl = `http://127.0.0.1:${runtimePort}`;
    runtime = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: join(root, "agent-core"),
      env: {
        ...process.env,
        PORT: String(runtimePort),
        HOST: "127.0.0.1",
        PROJECT_ROOT: root,
        CODEX_HOME: join(home, "codex"),
        AGENT_WORKSPACE: join(home, "workspace"),
        RPC_TIMEOUT_MS: "30000",
        REQUEST_TIMEOUT_MS: "60000",
        MAX_THREADS: "4",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Native diagnostics are kept off ordinary logs; only sanitized outcomes are persisted below.
    runtime.stdout?.on("data", () => {});
    runtime.stderr?.on("data", () => {});
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (runtime.exitCode !== null)
        throw new Error("Native runtime exited during startup");
      healthy = await fetch(`${runtimeUrl}/healthz`)
        .then((response) => response.ok)
        .catch(() => false);
      if (healthy) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(healthy, "native pinned runtime must become healthy");
    console.log(
      `Live pilot native runtime ready; real model=${profile.modelName}`,
    );
    environment = await TestWorkflowEnvironment.createLocal({
      server: { executable: { type: "cached-download", version: "v1.9.1" } },
    });
    platform = new PlatformService(store, [runtimeUrl]);
    const taskQueue = `live-pilot-${randomUUID()}`;
    const temporal = new AutomationTemporalClient(
      environment.client,
      taskQueue,
    );
    const automations = new AutomationService(store, platform, temporal);
    worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: require.resolve("../src/automation/workflows"),
      activities: createAutomationActivities(store, platform),
    });
    const tenant = {
      id: "default",
      dbName: store.database,
      allowedModelIds: [String(profile._id)],
      allowedSkillIds: [],
    };
    const context = <T>(work: () => Promise<T>) =>
      tenantContext.run(tenant, () =>
        userContext.run(
          { id: "pilot-owner", email: "pilot-owner@dev.local", role: "user" },
          work,
        ),
      );
    await worker.runUntil(() =>
      context(async () => {
        const created = await automations.create({
          name: "Authorized real provider read-only pilot",
          agentId: "live-read-only",
          prompt: receipts.prompt,
          trigger: {
            kind: "interval",
            everyMs: scheduled ? 60_000 : 86_400_000,
            anchorAt: new Date(
              Math.floor(
                (Date.now() + (scheduled ? 8_000 : 86_400_000)) / 1_000,
              ) * 1_000,
            ).toISOString(),
            timeZone: "UTC",
          },
          limits: { executionTimeoutMs: 120_000, latenessGraceMs: 600_000 },
        });
        const enabled = await automations.control(created.id, {
          action: "enable",
          version: created.controlVersion,
        });
        const started = Date.now();
        let run;
        if (scheduled) {
          console.log(
            "Waiting for one real native Schedule occurrence; no browser is involved.",
          );
          const deadline = Date.now() + 45_000;
          while (!run && Date.now() < deadline) {
            run = await automations.db.runs.findOne({
              automationId: created.id,
              source: "scheduled",
            });
            if (!run) await new Promise((resolve) => setTimeout(resolve, 100));
          }
          assert.ok(
            run,
            "native Schedule must admit the real pilot occurrence",
          );
        } else
          run = await automations.runNow(created.id, {
            requestKey: randomUUID(),
            revision: enabled.enabledRevision,
          });
        receipts.automationId = created.id;
        receipts.runId = run.id;
        receipts.workflowId = run.workflowId;
        await environment!.client.workflow.getHandle(run.workflowId).result();
        await automations.control(created.id, {
          action: "pause",
          version: enabled.controlVersion,
        });
        const persisted = await automations.db.run(run.id);
        receipts.wallDurationMs = Date.now() - started;
        receipts.status = persisted?.status;
        receipts.outcome = persisted?.outcome;
        receipts.reason = persisted?.reason;
        receipts.stopState = persisted?.stopState;
        receipts.auditComplete = persisted?.auditComplete;
        receipts.sessionId = persisted?.sessionId;
        receipts.rootTurnId = persisted?.turnId;
        receipts.resultRef = persisted?.resultRef;
        receipts.acceptedAt = persisted?.acceptedAt;
        receipts.startedAt = persisted?.startedAt;
        receipts.completedAt = persisted?.completedAt;
        const messages = await store!.messages
          .find({ sessionId: persisted?.sessionId, role: "assistant" })
          .toArray();
        receipts.result = messages
          .map((message: any) => message.text ?? message.content ?? "")
          .join("\n")
          .trim();
        const audit = await automations.db.events(
          created.id,
          "pilot-owner",
          run.id,
        );
        receipts.auditKinds = audit.map((event) => event.type);
        const toolEvidence = audit.filter(
          (event) => event.type === "automation.tool",
        );
        if (connector) {
          receipts.connectorAudit = toolEvidence.map((event) => ({
            at: event.at,
            ...event.detail,
          }));
          assert.ok(
            toolEvidence.some(
              (event) =>
                event.detail?.tool === "get_apps" &&
                event.detail?.phase === "completed" &&
                event.detail?.status === "completed",
            ),
            "native connector completion must be persisted in the exact root audit",
          );
          assert.ok(
            toolEvidence.every((event) =>
              [
                "get_apps",
                "list_mcp_resources",
                "list_mcp_resource_templates",
              ].includes(String(event.detail?.tool)),
            ),
            "only read-only discovery and the explicitly allowed connector tool may execute",
          );
        } else
          assert.equal(toolEvidence.length, 0, "pilot must not invoke tools");
        receipts.scheduledAt = persisted?.scheduledAt;
        receipts.nativeRootStartedAt = audit.find(
          (event) => event.type === "turn.started",
        )?.at;
        if (receipts.scheduledAt && receipts.nativeRootStartedAt)
          receipts.nativeRootStartLagMs =
            Date.parse(receipts.nativeRootStartedAt) -
            Date.parse(receipts.scheduledAt);
        receipts.nativeSnapshot = persisted?.sessionId
          ? await store!.sessions.findOne(
              { _id: persisted.sessionId },
              { projection: { threadId: 1, runtimeSessionId: 1 } },
            )
          : undefined;
        if (connector) {
          const history = await fetch(
            `${runtimeUrl}/threads/${receipts.nativeSnapshot.threadId}/items`,
          ).then((response) => response.json());
          const calls = history.data
            .map((row: any) => row.item)
            .filter(
              (item: any) =>
                item.type === "mcpToolCall" &&
                item.server === connector.name &&
                item.tool === "get_apps",
            );
          assert.equal(
            calls.length,
            1,
            "one actual native connector call required",
          );
          const call = calls[0];
          assert.equal(call.server, connector.name);
          assert.equal(call.tool, "get_apps");
          assert.equal(call.status, "completed");
          assert.equal(call.error, null);
          assert.ok(call.result && call.result.isError !== true);
          assert.ok(call.result.content?.length);
          receipts.connectorCall = {
            tool: call.tool,
            status: call.status,
            arguments: call.arguments,
            durationMs: call.durationMs,
            responseSha256: createHash("sha256")
              .update(JSON.stringify(call.result))
              .digest("hex"),
            responseContentBlocks: call.result.content.length,
            responseIsError: call.result.isError ?? false,
          };
        }
        assert.equal(persisted?.outcome, "succeeded");
        assert.equal(persisted?.stopState, "stopped");
        assert.equal(persisted?.auditComplete, true);
        assert.ok(persisted?.turnId);
        assert.ok(persisted?.resultRef);
        assert.equal(
          receipts.result,
          connector ? "AUTOMATION_CONNECTOR_PILOT_OK" : "AUTOMATION_PILOT_OK",
        );
        receipts.passed = true;
        console.log(
          `Real pilot succeeded; ${receipts.wallDurationMs}ms; exact root result persisted.`,
        );
      }),
    );
  } catch (error) {
    receipts.passed = false;
    receipts.errorType = error instanceof Error ? error.name : "unknown";
    receipts.errorCode = (error as any)?.code;
    console.log(
      `Live pilot did not pass; type=${receipts.errorType}; code=${receipts.errorCode ?? "none"}; status=${receipts.status ?? "not admitted"}; reason=${receipts.reason ?? "none"}`,
    );
    throw error;
  } finally {
    await writeFile(
      join(
        root,
        `docs/architecture/automations/${connector ? "PILOT_CONNECTOR_RECEIPT" : scheduled ? "PILOT_SCHEDULED_RECEIPT" : "PILOT_RECEIPT"}.json`,
      ),
      JSON.stringify(receipts, null, 2) + "\n",
    );
    platform?.stop();
    if (runtime) await stopChild(runtime);
    if (gateway) {
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway!.close(() => resolve()));
    }
    await store?.client.close();
    await environment?.teardown();
    await mongo?.stop();
    await rm(home, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.log(
    `Pilot stopped: ${error instanceof Error ? error.name : "unknown"}`,
  );
  process.exitCode = 1;
});
