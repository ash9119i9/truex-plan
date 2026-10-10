import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AdaptiveSessionV2 } from "./adaptive-session-v2";
import { log } from "../../shared/logging";

/** Private per-conversation Responses boundary; upstream profile remains unchanged. */
export class AdaptiveModelRelayV2 {
  private server?: Server;
  private readonly token = randomBytes(32).toString("hex");
  private readonly stopped = new AbortController();
  private readonly invocations = new Map<
    string,
    { name: string; args: Record<string, unknown> }
  >();
  private routing?: Promise<unknown>;
  private readonly approved = new Set<string>();
  private generation = 0;
  private lastQuery = "Continue the authorized task";
  constructor(
    private readonly session: AdaptiveSessionV2,
    private readonly provider: Record<string, any>,
  ) {}

  async start(): Promise<Record<string, any>> {
    if (
      this.provider.wire_api !== "responses" ||
      typeof this.provider.base_url !== "string" ||
      this.provider.aws ||
      this.provider.requires_openai_auth
    )
      throw new Error(
        "Adaptive V2 requires a configured Responses model provider",
      );
    const upstream = new URL(this.provider.base_url);
    upstream.pathname = upstream.pathname.replace(/\/$/, "") + "/responses";
    upstream.hash = "";
    if (
      !["http:", "https:"].includes(upstream.protocol) ||
      upstream.username ||
      upstream.password
    )
      throw new Error("Invalid adaptive model provider URL");
    for (const [key, value] of Object.entries(this.provider.query_params || {}))
      upstream.searchParams.set(key, String(value));
    this.server = createServer(async (req, res) => {
      const generation = this.generation;
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      let stage = "request";
      try {
        if (req.headers.authorization !== `Bearer ${this.token}`) {
          res.writeHead(401).end();
          return;
        }
        const path = req.url?.split("?")[0];
        const compact = path === "/v1/responses/compact";
        if (req.method !== "POST" || (path !== "/v1/responses" && !compact)) {
          res.writeHead(404).end();
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) {
            res.writeHead(413).end();
            return;
          }
          chunks.push(chunk);
        }
        await this.routing;
        if (generation !== this.generation)
          throw new Error("Adaptive turn ended");
        stage = "filter";
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const { body, allowedNames } =
          compact && !Array.isArray(input.tools)
            ? { body: input, allowedNames: new Set<string>() }
            : await this.session.filterModelRequest(input);
        const headers = new Headers({
          "content-type": "application/json",
          ...this.provider.http_headers,
        });
        for (const name of [
          "x-codex-turn-state",
          "x-codex-session-id",
          "x-codex-thread-id",
          "openai-beta",
        ]) {
          const value = req.headers[name];
          if (typeof value === "string") headers.set(name, value);
        }
        for (const [name, variable] of Object.entries(
          this.provider.env_http_headers || {},
        )) {
          const value = process.env[String(variable)];
          if (value) headers.set(name, value);
        }
        const bearer =
          this.provider.experimental_bearer_token ??
          (this.provider.env_key
            ? process.env[this.provider.env_key]
            : undefined);
        if (bearer) headers.set("authorization", `Bearer ${bearer}`);
        const target = new URL(upstream);
        if (compact) target.pathname += "/compact";
        stage = "provider";
        const response = await fetch(target, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.any([
            controller.signal,
            this.stopped.signal,
            AbortSignal.timeout(
              Number(process.env.REQUEST_TIMEOUT_MS) || 120000,
            ),
          ]),
          redirect: "error",
        });
        stage = "response";
        if (generation !== this.generation) {
          void response.body?.cancel().catch(() => {});
          throw new Error("Adaptive turn ended");
        }
        // Compaction returns conversation history, not executable new actions.
        const guarded = compact
          ? response
          : this.session.guardModelResponse(response, allowedNames, (item) => {
              if (generation !== this.generation)
                throw new Error("Adaptive turn ended");
              if (
                item.namespace !== "mcp__adaptive" ||
                typeof item.call_id !== "string" ||
                typeof item.arguments !== "string"
              )
                return;
              if (this.approved.has(item.call_id)) return;
              const args = JSON.parse(item.arguments);
              if (!args || typeof args !== "object" || Array.isArray(args))
                throw new Error("Invalid MCP invocation arguments");
              if (
                this.invocations.size >= 1000 &&
                !this.invocations.has(item.call_id)
              )
                throw new Error("Too many pending MCP invocations");
              this.invocations.set(item.call_id, { name: item.name, args });
            });
        res.writeHead(guarded.status, {
          "content-type":
            guarded.headers.get("content-type") || "application/json",
          ...(guarded.headers.has("x-codex-turn-state")
            ? {
                "x-codex-turn-state":
                  guarded.headers.get("x-codex-turn-state")!,
              }
            : {}),
          ...(guarded.headers.has("retry-after")
            ? { "retry-after": guarded.headers.get("retry-after")! }
            : {}),
        });
        if (guarded.body)
          await pipeline(Readable.fromWeb(guarded.body as any), res);
        else res.end();
      } catch (error) {
        if (!controller.signal.aborted && !this.stopped.signal.aborted)
          log("warn", "adaptive model request failed", {
            errorName: error instanceof Error ? error.name : "Error",
            stage,
          });
        if (!res.headersSent)
          res.writeHead(502).end(
            JSON.stringify({
              error: {
                message: "Adaptive model request failed",
                type: "adaptive_boundary_error",
              },
            }),
          );
        else res.destroy();
      }
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const port = (this.server.address() as { port: number }).port;
    // Provider credentials and environment headers stay solely in the upstream leg.
    const profile: Record<string, any> = {
      ...this.provider,
      base_url: `http://127.0.0.1:${port}/v1`,
      experimental_bearer_token: this.token,
      supports_websockets: false,
    };
    delete profile.env_key;
    delete profile.http_headers;
    delete profile.env_http_headers;
    delete profile.query_params;
    return profile;
  }

  approve(questionId: string, name: string) {
    const id = questionId.slice("mcp_tool_call_approval_".length);
    const invocation = this.invocations.get(id);
    if (!invocation || invocation.name !== name)
      throw new Error("Adaptive approval does not match an emitted invocation");
    this.session.approveInvocation(name, invocation.args);
    this.approved.add(id);
    this.invocations.delete(id);
  }
  async beforeTurn(query: string) {
    this.lastQuery = query;
    this.routing = this.session.beforeTurn(query);
    try {
      await this.routing;
    } catch (error) {
      this.routing = undefined;
      throw error;
    }
  }
  /** Goal continuations start inside the runtime rather than through turn/start. */
  continueTurn() {
    if (!this.routing) {
      this.routing = this.session.beforeTurn(this.lastQuery);
      // The request boundary also awaits this promise and fails closed on errors.
      void this.routing.catch(() => {});
    }
  }
  finishTurn() {
    this.generation++;
    this.routing = undefined;
    this.invocations.clear();
    this.approved.clear();
    this.session.finishTurn();
  }
  close() {
    this.stopped.abort();
    this.finishTurn();
    this.server?.closeAllConnections();
    this.server?.close();
  }
}
