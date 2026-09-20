import { businessCapabilityParams } from "../../shared/business-capabilities";
import { publicSession, publicSnapshot, POLICY_VERSION } from "./public";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Store } from "./store";
import { orderConversation } from "../../shared/command-history";
import { isDeepStrictEqual } from "node:util";
import type { CommandRecord, Message, Session } from "../../shared/contracts";
import { ApiError } from "./errors";
export { ApiError } from "./errors";
import { mcpConfig, mcpInstructions, newMcpProfile } from "./mcp";
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
    if (session.runtimePolicyVersion !== POLICY_VERSION)
      throw new ApiError(
        409,
        "This conversation predates the Truex access policy. Start a new conversation.",
        "LEGACY_SESSION",
      );
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
    const names = new Set<string>();
    for (const id of agent.mcpProfileIds || []) {
      const mcp = await this.store.findMcp(id);
      if (!mcp) throw new ApiError(422, `MCP profile missing: ${String(id)}`);
      if (names.has(mcp.name))
        throw new ApiError(422, `Duplicate MCP server name: ${mcp.name}`);
      names.add(mcp.name);
      const server = mcpConfig(mcp);
      if (server.command)
        throw new ApiError(
          422,
          "Business connectors must use HTTP. Configure this connector on a separate service.",
          "CONNECTOR_POLICY",
        );
      config[`mcp_servers.${mcp.name}`] = server;
    }
    return {
      model: profile.modelName,
      modelProvider: provider,
      config,
      baseInstructions:
        (agent.systemPrompt || "You are a helpful assistant.") +
        (names.size ? mcpInstructions : ""),
      ...(profile.serviceTier && profile.serviceTier !== "auto"
        ? { serviceTier: profile.serviceTier }
        : {}),
      cwd:
        cwd || resolve(process.env.AGENT_WORKSPACE || "../.runtime/workspace"),
      sandbox: "read-only",
      approvalPolicy: "never",
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
  async agentMcp(agentId: string) {
    const agent = await this.store.findAgent(agentId);
    if (!agent) throw new ApiError(404, "Agent not found");
    const profiles = await this.store.mcp
      .find({}, { projection: { _id: 1, name: 1, enabled: 1, transport: 1 } })
      .toArray();
    return {
      profileIds: (agent.mcpProfileIds || []).map(String),
      profiles: profiles.map((p) => ({
        id: String(p._id),
        name: p.name,
        enabled: p.enabled !== false,
        transport: p.transport || "configured",
      })),
    };
  }
  async setAgentMcp(agentId: string, ids: unknown) {
    const agent = await this.store.findAgent(agentId);
    if (!agent) throw new ApiError(404, "Agent not found");
    if (
      !Array.isArray(ids) ||
      ids.length > 50 ||
      ids.some((id) => typeof id !== "string" || !id || id.length > 200)
    )
      throw new ApiError(
        400,
        "profileIds must be an array of up to 50 MCP IDs",
      );
    const names = new Set<string>();
    const references = [];
    for (const id of new Set(ids as string[])) {
      const profile = await this.store.findMcp(id);
      if (!profile) throw new ApiError(422, `MCP profile missing: ${id}`);
      if (mcpConfig(profile).command)
        throw new ApiError(
          422,
          "Local command connectors are unavailable. Use an HTTP connector.",
          "CONNECTOR_POLICY",
        );
      if (names.has(profile.name))
        throw new ApiError(422, `Duplicate MCP server name: ${profile.name}`);
      names.add(profile.name);
      references.push(profile._id);
    }
    await this.store.agents.updateOne(
      { _id: agent._id },
      { $set: { mcpProfileIds: references } },
    );
    return this.agentMcp(agentId);
  }
  async createMcp(body: unknown) {
    const profile = newMcpProfile(body);
    if (mcpConfig(profile).command)
      throw new ApiError(
        422,
        "Local command connectors are unavailable. Use an HTTP connector.",
        "CONNECTOR_POLICY",
      );
    await this.store.mcp.insertOne(profile);
    return { id: String(profile._id), name: profile.name };
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
      runtimePolicyVersion: POLICY_VERSION,
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
    return publicSession(session);
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
    if (session.settings?.model) config.model = session.settings.model;
    if (session.settings?.effort)
      config.config.model_reasoning_effort = session.settings.effort;
    const snapshot = await this.owned(session, "/resume", "POST", config);
    if (session.settings && Object.keys(session.settings).length)
      await this.owned(session, "/capabilities", "POST", {
        method: "thread/settings/update",
        params: session.settings,
      });
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
      session: publicSession(await this.session(id)),
      messages: orderConversation(
        await this.store.messages.find({ sessionId: id }).toArray(),
      ),
      snapshot: snapshot ? publicSnapshot(snapshot) : null,
      recoveryError: recoveryError
        ? "Conversation recovery is temporarily unavailable."
        : null,
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
        runtimePolicyVersion: POLICY_VERSION,
      }))
        await this.ingest(s).catch(() => {});
    } finally {
      this.polling = false;
    }
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
  async command(
    id: string,
    method: string,
    params: unknown,
    request: { clientId: string; text: string },
  ) {
    if (
      !request ||
      typeof request.clientId !== "string" ||
      !/^[-\w]{1,100}$/.test(request.clientId) ||
      typeof request.text !== "string" ||
      !request.text.trim() ||
      request.text.length > 50000
    )
      throw new ApiError(400, "A command needs text and a valid clientId");
    if (method !== "help") businessCapabilityParams(method, params);
    else if (
      !params ||
      typeof params !== "object" ||
      Object.keys(params).length
    )
      throw new ApiError(400, "Help takes no arguments");
    const session = await this.session(id);
    const key = `${id}:command:${request.clientId}`;
    const existing = await this.store.messages.findOne({ _id: key });
    const replay = (message: Message) => {
      if (
        message.text !== request.text ||
        message.command?.method !== method ||
        !isDeepStrictEqual(message.command.params, params)
      )
        throw new ApiError(
          409,
          "This command ID already belongs to another request",
        );
      return { commandMessage: message };
    };
    if (existing) return replay(existing);
    await this.resume(session);
    await this.ingest(session);
    await this.reconcile(session);
    const history = orderConversation(
      await this.store.messages.find({ sessionId: id }).toArray(),
    );
    const message: Message = {
      _id: key,
      sessionId: id,
      clientId: request.clientId,
      role: "user",
      text: request.text,
      at: new Date().toISOString(),
      delivery: "accepted",
      command: {
        method,
        params: params as Record<string, unknown>,
        state: "running",
        afterMessageId: history.at(-1)?._id,
      },
    };
    try {
      await this.store.messages.insertOne(message);
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      return replay((await this.store.messages.findOne({ _id: key }))!);
    }
    // Persist before dispatch: a retry must never repeat a fork or other mutation.
    let command: CommandRecord;
    try {
      const result =
        method === "help"
          ? {
              help: "/goal <objective> — Set a goal\n/goal show — View goal status\n/goal clear — Clear the goal\n/fork — Create a conversation branch\n/compact — Compact context\n/model <identifier> — Change the model\n/effort <level> — Change reasoning effort\n/archive — Archive this conversation\n/unarchive — Restore this conversation\n\nPrefix a literal command with // to send it as a question.",
            }
          : await this.capability(id, method, params);
      command = {
        ...message.command!,
        state: "succeeded",
        result: {
          ...("help" in result ? { help: result.help } : {}),
          ...("goal" in result ? { goal: result.goal } : {}),
          ...("session" in result && result.session
            ? { sessionId: result.session._id }
            : {}),
        },
      };
    } catch (e) {
      const definite =
        e instanceof ApiError && e.status >= 400 && e.status < 500;
      command = {
        ...message.command!,
        state: definite ? "failed" : "unknown",
        error: definite
          ? "The command was rejected. Check its arguments and try again."
          : "The command outcome could not be confirmed. Check the current state before trying again.",
      };
    }
    await this.store.messages.updateOne({ _id: key }, { $set: { command } });
    return { commandMessage: { ...message, command } };
  }
  async capability(id: string, method: string, params: unknown) {
    try {
      businessCapabilityParams(method, params);
    } catch {
      throw new ApiError(
        403,
        "This operation or setting is not available in Truex",
        "CAPABILITY_DENIED",
      );
    }
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
        archived: false,
      };
      await this.store.sessions.insertOne(fork);
      return { session: publicSession(fork) };
    }
    if (method === "thread/archive" || method === "thread/unarchive")
      await this.store.sessions.updateOne(
        { _id: id },
        { $set: { archived: method === "thread/archive" } },
      );
    if (method === "thread/settings/update")
      await this.store.sessions.updateOne(
        { _id: id },
        { $set: { settings: { ...s.settings, ...(params as object) } } },
      );
    if (method.startsWith("thread/goal/")) {
      const g = result.goal;
      return {
        goal: g
          ? {
              objective: g.objective,
              status: g.status,
              tokenBudget: g.tokenBudget,
              tokensUsed: g.tokensUsed,
              timeUsedSeconds: g.timeUsedSeconds,
            }
          : null,
      };
    }
    return { ok: true };
  }
}
