// Deterministic UI fixture only. Runtime protocol separately tested against actual manager.
import { createServer } from "node:http";
import {
  historyWindow,
  historyAnchor,
} from "../../../platform/src/history-window.ts";
const sessions = ["a", "b", "long"].map((name, i) => ({
  _id: `fixture-${name}`,
  agentId: "fixture-agent",
  title: `Fixture ${name.toUpperCase()} conversation`,
  status: "active",
  createdAt: new Date(Date.now() - i * 1000).toISOString(),
}));
const histories = new Map(
  sessions.map((s) => [
    s._id,
    Array.from({ length: s._id === "fixture-long" ? 1000 : 40 }, (_, i) => ({
      _id: `${s._id}-${i}`,
      sessionId: s._id,
      role: i % 2 ? "assistant" : "user",
      text:
        i % 2
          ? `**${s._id} reply ${i}**\n\nA deterministic fixture response with a list:\n\n- History loads independently\n- Streaming preserves identity\n\nCode fixture value ${i}.`
          : `${s._id} question ${i}`,
      turnId: `${s._id}-turn-${Math.floor(i / 2)}`,
      itemId: `${s._id}-item-${i}`,
      runtimeItemId: i % 2 ? `${s._id}-item-${i}` : undefined,
      clientId: i % 2 ? undefined : `${s._id}-client-${i}`,
      messageIndex: i % 2 ? 0 : undefined,
      at: new Date(1700000000000 + i).toISOString(),
    })),
  ]),
);
let requests = [];
const streams = new Map();
const config = new Map();
const sequences = new Map();
const bursts = new Map();
let globalOptions = {};
const snapshot = (id) => ({
  state:
    bursts.get(id)?.final === false
      ? { kind: "running", turnId: `${id}-burst-turn` }
      : { kind: "idle" },
  cursor: `fixture:${sequences.get(id) || 1}`,
  messages: id
    ? (histories.get(id) || [])
        .slice(-20)
        .filter((m) => m.role === "assistant")
        .map((m) => ({
          id: m.itemId,
          turnId: m.turnId,
          text: m.text,
          final: true,
          messageIndex: m.messageIndex,
        }))
        .concat(bursts.has(id) ? [bursts.get(id)] : [])
    : [],
  thinking: [],
  pending: [],
  subAgents: [],
  plan: [],
  goal: null,
  timings: [],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:4400");
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  const json = (value, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  if (url.pathname === "/__global") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    globalOptions = JSON.parse(raw);
    return json({ ok: true });
  }
  if (url.pathname === "/__metrics") {
    if (req.method === "DELETE") requests = [];
    json(requests);
    return;
  }
  if (url.pathname === "/__sessions") {
    let raw = "";
    for await (const c of req) raw += c;
    const { older = 0 } = JSON.parse(raw);
    for (let i = 0; i < Math.min(older, 1000); i++) {
      const id = `fixture-earlier-${i}`;
      if (sessions.some((s) => s._id === id)) continue;
      sessions.push({
        _id: id,
        agentId: "fixture-agent",
        title: `Earlier fixture ${i}`,
        status: "active",
        createdAt: new Date(Date.now() - 86400000 * (i + 1)).toISOString(),
      });
      histories.set(id, []);
    }
    return json({ count: sessions.length });
  }
  if (url.pathname === "/__reasoning") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const { id, count = 1000 } = JSON.parse(raw);
    for (let i = 0; i < Math.min(count, 10000); i++) {
      const seq = (sequences.get(id) || 1) + 1;
      sequences.set(id, seq);
      const event = {
        type: "reasoning.delta",
        threadId: id,
        turnId: `${id}-burst-turn`,
        itemId: `${id}-reasoning`,
        seq,
        cursor: `fixture:${seq}`,
        data: {
          delta: "r",
          method: "item/reasoning/summaryTextDelta",
          summaryIndex: 0,
        },
      };
      for (const stream of streams.get(id) || [])
        stream.write(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    return json({ ok: true });
  }
  if (url.pathname === "/__burst") {
    let raw = "";
    for await (const c of req) raw += c;
    const { id, count = 1000, delta = "x", final = true } = JSON.parse(raw);
    const emit = (event) => {
      const seq = (sequences.get(id) || 1) + 1;
      sequences.set(id, seq);
      event = { ...event, seq, cursor: `fixture:${seq}` };
      for (const stream of streams.get(id) || [])
        stream.write(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    bursts.set(id, {
      id: `${id}-burst-item`,
      turnId: `${id}-burst-turn`,
      text: delta.repeat(Math.min(count, 10000)),
      final,
      messageIndex: 0,
    });
    for (let i = 0; i < Math.min(count, 10000); i++)
      emit({
        type: "message.delta",
        threadId: id,
        turnId: `${id}-burst-turn`,
        itemId: `${id}-burst-item`,
        cursor: `burst:${i}`,
        data: { delta, messageIndex: 0 },
      });
    if (final)
      emit({
        type: "message.final",
        threadId: id,
        turnId: `${id}-burst-turn`,
        itemId: `${id}-burst-item`,
        cursor: `burst:${count}`,
        data: { text: delta.repeat(Math.min(count, 10000)), messageIndex: 0 },
      });
    return json({ ok: true });
  }
  if (url.pathname === "/__configure") {
    let raw = "";
    for await (const c of req) raw += c;
    const input = JSON.parse(raw);
    config.set(input.id, input);
    if (input.append) histories.get(input.id).push(...input.append);
    json({ ok: true });
    return;
  }
  if (url.pathname === "/__emit") {
    let raw = "";
    for await (const c of req) raw += c;
    const input = JSON.parse(raw);
    for (const stream of streams.get(input.id) || [])
      stream.write(
        `${input.name ? `event: ${input.name}\n` : ""}data: ${JSON.stringify(input.event)}\n\n`,
      );
    json({ ok: true });
    return;
  }
  const entry = {
    method: req.method,
    path: url.pathname + url.search,
    at: Date.now(),
  };
  requests.push(entry);
  if (url.pathname === "/api/agents") {
    await sleep(globalOptions.agentsDelay || 0);
    return json([
      {
        id: "fixture-agent",
        name: "Fixture Assistant",
        handle: "fixture",
        provider: "fixture",
        model: "fixture-model",
        description: "Isolated performance fixture",
        sandbox: "read-only",
        look: "lotus",
        tint: "lilac",
      },
    ]);
  }
  if (url.pathname === "/api/features")
    return json({
      approvalModes: {
        enabled: false,
        defaultMode: "ask",
        autopilot: false,
        nameHeuristic: false,
      },
    });
  if (url.pathname === "/api/projects") return json([]);
  if (url.pathname === "/api/sessions") {
    if (req.method !== "POST") return json(sessions);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    await sleep(globalOptions.createDelay || 0);
    if (globalOptions.createError)
      return json(
        { error: "Fixture creation rejected", code: "FIXTURE_REJECTED" },
        422,
      );
    const created = {
      _id: `fixture-created-${sessions.length}`,
      agentId: body.agentId,
      title: "Created fixture",
      status: "active",
      createdAt: new Date().toISOString(),
    };
    sessions.push(created);
    histories.set(created._id, []);
    return json(created, 201);
  }
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(.*)$/);
  if (!match) return json({ error: "Fixture route not found" }, 404);
  const id = match[1],
    suffix = match[2],
    session = sessions.find((s) => s._id === id);
  if (!session)
    return json({ error: "Session not found", code: "SESSION_NOT_FOUND" }, 404);
  if (suffix === "/messages") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    await sleep(globalOptions.sendDelay || 0);
    histories.get(id).push({
      _id: `${id}:user:${body.clientId}`,
      sessionId: id,
      role: "user",
      text: body.text,
      clientId: body.clientId,
      at: new Date().toISOString(),
    });
    return json({ turnId: `${id}-burst-turn`, steer: false });
  }
  if (suffix === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    let list = streams.get(id);
    if (!list) streams.set(id, (list = new Set()));
    list.add(res);
    const timer = setTimeout(() => {
      const seq = sequences.get(id) || 1;
      const cursor = `fixture:${seq}`;
      const synced = url.searchParams.get("sync") === "v1";
      const fromCursor =
        req.headers["last-event-id"] || url.searchParams.get("cursor") || null;
      const operational = {
        ...snapshot(id),
        ...(config.get(id)?.snapshot || {}),
        cursor,
      };
      const emit = (event) =>
        res.write(`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`);
      const replay = synced && fromCursor === cursor;
      if (!replay)
        emit({
          type: "snapshot",
          seq,
          cursor,
          threadId: id,
          data: operational,
        });
      if (synced && !config.get(id)?.legacy)
        emit({
          type: "sync.completed",
          seq,
          cursor,
          threadId: id,
          data: {
            protocol: 1,
            mode: replay ? "replay" : "snapshot",
            fromCursor,
            highWaterCursor: cursor,
            snapshot: { ...operational, messages: [], thinking: [] },
          },
        });
    }, 30);
    req.on("close", () => {
      clearTimeout(timer);
      list.delete(res);
    });
    return;
  }
  if (suffix === "/traces") return json({ traces: [], summary: null });
  if (suffix === "/timings")
    return json({ turns: [], averages: { totalMs: 0, ttftMs: 0 } });
  if (suffix === "/agents") return json([]);
  if (suffix === "/documents") return json({ files: [] });
  if (suffix === "/goal/history") {
    const opts = config.get(id) || {};
    await sleep(opts.goalHistoryDelay ?? 0);
    return json({ entries: opts.goalHistory ?? [] });
  }
  if (suffix.startsWith("/visualizations/")) {
    const visual = config
      .get(id)
      ?.visualizations?.find((v) => v.id === suffix.split("/").at(-1));
    return visual
      ? json(visual)
      : json({ error: "Fixture visual not found" }, 404);
  }
  if (!suffix) {
    const opts = config.get(id) || {};
    const persisted = url.searchParams.get("persisted") === "1";
    await sleep(
      persisted ? (opts.persistedDelay ?? 15) : (opts.recoveryDelay ?? 600),
    );
    if (opts.error)
      return json(
        { error: "Fixture access revoked", code: "FORBIDDEN" },
        opts.error,
      );
    entry.finishedAt = Date.now();
    const result =
      url.searchParams.get("window") === "1"
        ? historyWindow(
            histories.get(id),
            id,
            historyAnchor(id, url.searchParams.get("before") ?? undefined),
          )
        : { messages: histories.get(id) };
    return json({
      session,
      ...result,
      snapshot:
        url.searchParams.get("persisted") === "1"
          ? null
          : { ...snapshot(id), ...(opts.snapshot || {}) },
      plan: null,
      approvals: [],
      goalReview: null,
      goalHistory: [],
      recoveryError: persisted ? null : opts.recoveryError || null,
      recoveryErrorRef: null,
    });
  }
  return json({ error: "Unsupported fixture operation" }, 404);
}).listen(4400, "127.0.0.1", () =>
  console.log("Isolated synthetic API fixture http://127.0.0.1:4400"),
);
