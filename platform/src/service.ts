import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Store } from "./store";
import type { Session } from "../../shared/contracts";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "REQUEST_FAILED",
  ) {
    super(message);
  }
}
export class PlatformService {
  readonly hosts: string[];
  private polling = false;
  private timer?: NodeJS.Timeout;
  private nextHost = 0;
  constructor(
    readonly store: Store,
    hosts = (
      process.env.AGENT_CORE_URLS ||
      process.env.AGENT_CORE_URL ||
      "http://127.0.0.1:4100"
    ).split(","),
  ) {
    this.hosts = hosts.map((x) => x.trim().replace(/\/$/, ""));
  }
  async call(
    host: string,
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<any> {
    if (!this.hosts.includes(host))
      throw new ApiError(
        503,
        "Session owner is not in AGENT_CORE_URLS",
        "OWNER_UNCONFIGURED",
      );
    let response: Response;
    try {
      response = await fetch(host + path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(35000),
      });
    } catch {
      throw new ApiError(
        503,
        "Session owner is temporarily unavailable",
        "OWNER_UNAVAILABLE",
      );
    }
    const result = await response.json();
    if (!response.ok)
      throw new ApiError(
        response.status,
        result.error || "Runtime request failed",
        result.code,
      );
    return result;
  }
  async session(id: string) {
    const session = await this.store.sessions.findOne({ _id: id });
    if (!session) throw new ApiError(404, "Session not found");
    return session;
  }
  async configuration(agentId: string, cwd?: string) {
    const agent = await this.store.findAgent(agentId);
    if (!agent) throw new ApiError(404, "Agent not found");
    const profile = await this.store.findModel(agent.modelProfileId);
    const apiKey = profile?.apiKey || profile?.apikey;
    if (!profile || !apiKey)
      throw new ApiError(422, "Agent requires a model profile with an API key");
    if (profile.wireApi && profile.wireApi !== "responses")
      throw new ApiError(
        422,
        `Model profile ${String(profile._id)} uses wireApi "${profile.wireApi}". The pinned Codex supports only Responses API. Update this profile to a compatible Responses provider in truex_models.`,
        "UNSUPPORTED_WIRE_API",
      );
    if (!profile.baseUrl || !profile.modelName)
      throw new ApiError(422, "Model profile requires baseUrl and modelName");
    const provider =
      "profile_" + String(profile._id).replace(/[^a-zA-Z0-9_]/g, "_");
    const config: Record<string, any> = {
      [`model_providers.${provider}`]: {
        name: profile.provider,
        base_url: profile.baseUrl,
        wire_api: "responses",
        experimental_bearer_token: apiKey,
      },
      ...(profile.reasoningEffort
        ? { model_reasoning_effort: profile.reasoningEffort }
        : {}),
    };
    for (const id of agent.mcpProfileIds || []) {
      const mcp = await this.store.findMcp(id);
      if (!mcp) throw new ApiError(422, `MCP profile missing: ${String(id)}`);
      if (mcp.enabled === false)
        throw new ApiError(422, `MCP profile disabled: ${mcp.name}`);
      if (!/^[\w-]+$/.test(mcp.name))
        throw new ApiError(422, "Invalid MCP name");
      let server: Record<string, unknown>;
      if (mcp.config) server = { ...mcp.config };
      else if (mcp.transport === "stdio") {
        if (!mcp.command)
          throw new ApiError(422, `MCP ${mcp.name} requires a command`);
        server = {
          command: mcp.command,
          args: mcp.args || [],
          ...(mcp.env ? { env: mcp.env } : {}),
        };
      } else {
        if (!mcp.url) throw new ApiError(422, `MCP ${mcp.name} requires a URL`);
        server = { url: mcp.url };
        const key = mcp.apiKey || mcp.apikey;
        if (key && mcp.auth?.kind !== "none") {
          const header =
            mcp.auth?.kind === "header" ? mcp.auth.headerName : "Authorization";
          if (!header)
            throw new ApiError(422, `MCP ${mcp.name} requires auth.headerName`);
          server.http_headers = {
            [header]: mcp.auth?.kind === "header" ? key : `Bearer ${key}`,
          };
        }
      }
      if (mcp.capabilities?.connectTimeoutMs)
        server.startup_timeout_sec = mcp.capabilities.connectTimeoutMs / 1000;
      if (mcp.capabilities?.requestTimeoutMs)
        server.tool_timeout_sec = mcp.capabilities.requestTimeoutMs / 1000;
      config[`mcp_servers.${mcp.name}`] = server;
    }
    return {
      model: profile.modelName,
      modelProvider: provider,
      config,
      baseInstructions: agent.systemPrompt || "You are a helpful assistant.",
      ...(profile.serviceTier && profile.serviceTier !== "auto"
        ? { serviceTier: profile.serviceTier }
        : {}),
      cwd:
        cwd || resolve(process.env.AGENT_WORKSPACE || "../.runtime/workspace"),
      sandbox: agent.sandbox || "read-only",
      approvalPolicy: agent.approvalPolicy || "never",
    };
  }
  async agents() {
    const [agents, profiles] = await Promise.all([
      this.store.agents.find({ enabled: { $ne: false } }).toArray(),
      this.store.profiles
        .find(
          { enabled: { $ne: false } },
          { projection: { apikey: 0, apiKey: 0 } },
        )
        .toArray(),
    ]);
    return agents.map((a) => {
      const p = profiles.find(
        (p) => String(p._id) === String(a.modelProfileId),
      );
      return {
        id: String(a._id),
        name: a.name,
        description: a.description || "",
        provider: p?.provider || "unknown",
        model: p?.modelName || "unknown",
        sandbox: a.sandbox || "read-only",
      };
    });
  }
  async create(agentId: string) {
    if (typeof agentId !== "string")
      throw new ApiError(400, "agentId is required");
    const config = await this.configuration(agentId);
    let host = "",
      thread: any;
    for (let n = 0; n < this.hosts.length; n++) {
      host = this.hosts[this.nextHost++ % this.hosts.length];
      try {
        thread = await this.call(host, "/threads", "POST", config);
        break;
      } catch (e) {
        if (
          !(e instanceof ApiError && e.code === "CAPACITY") ||
          n === this.hosts.length - 1
        )
          throw e;
      }
    }
    const session: Session = {
      _id: "sess_" + randomUUID(),
      agentId,
      threadId: thread.threadId,
      agentCoreHost: host,
      status: "active",
      cwd: config.cwd,
      createdAt: new Date().toISOString(),
      approvals: [],
      timings: [],
      threadStartMs: thread.threadStartMs,
      runtimeStartup: thread.runtimeStartup,
    };
    try {
      await this.store.sessions.insertOne(session);
    } catch (e) {
      await this.call(host, `/threads/${thread.threadId}`, "DELETE").catch(
        () => {},
      );
      throw e;
    }
    return session;
  }
  async owned(session: Session, path: string, method = "GET", body?: any) {
    if (session.status === "dead")
      throw new ApiError(410, "Session is unrecoverable", "THREAD_LOST");
    try {
      return await this.call(
        session.agentCoreHost,
        `/threads/${session.threadId}${path}`,
        method,
        body,
      );
    } catch (e) {
      if (
        e instanceof ApiError &&
        ["OWNER_UNAVAILABLE", "RUNTIME_UNAVAILABLE", "THREAD_LOST"].includes(
          e.code,
        )
      )
        await this.store.sessions.updateOne(
          { _id: session._id },
          { $set: { status: e.code === "THREAD_LOST" ? "dead" : "orphaned" } },
        );
      throw e;
    }
  }
  async resume(session: Session) {
    const config = await this.configuration(session.agentId, session.cwd);
    const snapshot = await this.owned(session, "/resume", "POST", config);
    if (session.status !== "active")
      await this.store.sessions.updateOne(
        { _id: session._id },
        { $set: { status: "active" } },
      );
    return snapshot;
  }
  async message(id: string, text: string, clientId: string) {
    if (typeof text !== "string" || !text.trim() || text.length > 100000)
      throw new ApiError(400, "Text must contain 1–100000 characters");
    if (typeof clientId !== "string" || !/^[-\w]{1,100}$/.test(clientId))
      throw new ApiError(400, "A valid clientId is required for idempotency");
    const s = await this.session(id);
    await this.resume(s);
    const key = `${id}:user:${clientId}`;
    try {
      await this.store.messages.insertOne({
        _id: key,
        sessionId: id,
        role: "user",
        text,
        clientId,
        delivery: "pending",
        at: new Date().toISOString(),
      });
    } catch (e: any) {
      if (e.code !== 11000) throw e;
      const existing = await this.store.messages.findOne({ _id: key });
      if (existing?.delivery === "accepted")
        return {
          turnId: existing.turnId,
          steer: existing.steer,
          duplicate: true,
        };
      throw new ApiError(
        409,
        "This message was already submitted; check its delivery state before retrying",
        "DUPLICATE_MESSAGE",
      );
    }
    if (!s.title) {
      const summary = text.trim().replace(/\s+/g, " ");
      await this.store.sessions.updateOne(
        {
          _id: id,
          $or: [{ title: { $exists: false } }, { title: "" }],
        },
        {
          $set: {
            title:
              summary.length > 80
                ? summary.slice(0, 79).trimEnd() + "…"
                : summary,
          },
        },
      );
    }
    const begin = performance.now();
    try {
      const result = await this.owned(s, "/turns", "POST", { text, clientId });
      await this.store.messages.updateOne(
        { _id: key },
        {
          $set: {
            delivery: "accepted",
            turnId: result.turnId,
            steer: result.steer,
          },
        },
      );
      return { ...result, platformRoundTripMs: performance.now() - begin };
    } catch (e) {
      await this.store.messages.updateOne(
        { _id: key },
        {
          $set: {
            delivery:
              e instanceof ApiError && e.status < 500 ? "failed" : "unknown",
          },
        },
      );
      throw e;
    }
  }
  async reconcile(s: Session) {
    let cursor: string | null = null,
      order = 0;
    const assistantIndexes = new Map<string, number>();
    do {
      const page = await this.owned(
        s,
        `/items${cursor ? "?cursor=" + encodeURIComponent(cursor) : ""}`,
      );
      for (const entry of page.data) {
        const { item, turnId } = entry;
        if (item.type === "agentMessage") {
          const messageIndex = assistantIndexes.get(turnId) || 0;
          assistantIndexes.set(turnId, messageIndex + 1);
          await this.store.messages.updateOne(
            { _id: `${s._id}:assistant:${turnId}:${messageIndex}` },
            {
              $set: { order: order++, runtimeItemId: item.id },
              $setOnInsert: {
                sessionId: s._id,
                role: "assistant",
                text: item.text,
                turnId,
                messageIndex,
                itemId: item.id,
                at: s.createdAt,
              },
            },
            { upsert: true },
          );
        }
        if (item.type === "userMessage") {
          const clientId = item.clientId || item.id;
          const existing = await this.store.messages.findOne({
            sessionId: s._id,
            $or: [{ clientId }, { itemId: item.id }],
          });
          if (existing)
            await this.store.messages.updateOne(
              { _id: existing._id },
              {
                $set: {
                  itemId: item.id,
                  turnId,
                  delivery: "accepted",
                  order: order++,
                },
              },
            );
          if (!existing)
            await this.store.messages.updateOne(
              { _id: `${s._id}:runtime-user:${item.id}` },
              {
                $setOnInsert: {
                  sessionId: s._id,
                  role: "user",
                  text: (item.content || [])
                    .filter((c: any) => c.type === "text")
                    .map((c: any) => c.text)
                    .join("\n"),
                  turnId,
                  itemId: item.id,
                  at: s.createdAt,
                  delivery: "accepted",
                  order: order++,
                },
              },
              { upsert: true },
            );
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
  async history(id: string) {
    const s = await this.session(id);
    let snapshot = null,
      recoveryError = null;
    try {
      snapshot = await this.owned(s, "/snapshot");
      await this.ingest(s);
      await this.reconcile(s);
    } catch (e) {
      recoveryError =
        e instanceof Error ? e.message : "History reconciliation unavailable";
    }
    return {
      session: await this.session(id),
      messages: (
        await this.store.messages
          .find({ sessionId: id })
          .sort({ at: 1, _id: 1 })
          .toArray()
      ).sort(
        (a, b) =>
          (a.order ?? Number.MAX_SAFE_INTEGER) -
          (b.order ?? Number.MAX_SAFE_INTEGER),
      ),
      snapshot,
      recoveryError,
    };
  }
  async ingest(s: Session) {
    const records = await this.call(
      s.agentCoreHost,
      `/threads/${s.threadId}/records`,
    );
    for (const record of records) await this.store.persist(s._id, record.event);
    if (records.length)
      await this.call(
        s.agentCoreHost,
        `/threads/${s.threadId}/records/ack`,
        "POST",
        { keys: records.map((r: any) => r.key) },
      );
  }
  startIngestion() {
    this.timer = setInterval(() => {
      void this.poll().catch(() =>
        process.stderr.write(
          "Persistence ingestion failed; unacknowledged records will be retried\n",
        ),
      );
    }, 2000);
    this.timer.unref();
  }
  async poll() {
    if (this.polling || !this.store.db) return;
    this.polling = true;
    try {
      for await (const s of this.store.sessions.find({
        status: { $ne: "dead" },
      }))
        await this.ingest(s).catch(() => {});
    } finally {
      this.polling = false;
    }
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  async capability(id: string, method: string, params: any) {
    const s = await this.session(id);
    await this.resume(s);
    const result = await this.owned(s, "/capabilities", "POST", {
      method,
      params,
    });
    if (method === "thread/fork") {
      const fork: Session = {
        ...s,
        _id: "sess_" + randomUUID(),
        threadId: result.thread.id,
        createdAt: new Date().toISOString(),
        timings: [],
        approvals: [],
        cursor: undefined,
      };
      await this.store.sessions.insertOne(fork);
      return { session: fork };
    }
    if (method === "thread/archive")
      await this.store.sessions.updateOne(
        { _id: id },
        { $set: { archived: true } },
      );
    if (method === "thread/delete")
      await this.store.sessions.updateOne(
        { _id: id },
        { $set: { status: "dead" } },
      );
    return result;
  }
}
