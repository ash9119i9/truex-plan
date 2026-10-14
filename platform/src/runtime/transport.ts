import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  type InvokeAgentRuntimeCommandOutput,
} from "@aws-sdk/client-bedrock-agentcore";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { createHash } from "node:crypto";
import { ApiError } from "../core/errors";
import {
  runtimeWindowOption,
  runtimeWindowQuery,
  runtimeSyncOption,
} from "../../../shared/runtime-read-options";
import { runtimeResumeResponse } from "../../../shared/runtime-resume-options";

const runtimeArn =
  /^arn:(?:aws|aws-us-gov|aws-cn):bedrock-agentcore:([a-z0-9-]+):\d{12}:runtime\/[A-Za-z0-9_-]+$/;

export const isAgentCoreRuntime = (owner: string) => runtimeArn.test(owner);

export function runtimeHosts(env = process.env): string[] {
  if (env.AGENTCORE_RUNTIME_ARN) {
    const arn = env.AGENTCORE_RUNTIME_ARN.trim();
    if (!isAgentCoreRuntime(arn))
      throw new Error("Invalid AGENTCORE_RUNTIME_ARN");
    return [arn];
  }
  return (env.AGENT_CORE_URLS || env.AGENT_CORE_URL || "http://127.0.0.1:4100")
    .split(",")
    .map((host) => host.trim().replace(/\/$/, ""));
}

type Send = (
  region: string,
  command: InvokeAgentRuntimeCommand,
  signal: AbortSignal,
) => Promise<InvokeAgentRuntimeCommandOutput>;

export type RuntimeRequest = {
  owner: string;
  path: string;
  method?: string;
  body?: unknown;
  sessionId?: string;
  requestId?: string;
  cursor?: string;
  signal?: AbortSignal;
  window?: boolean;
  sync?: "v1";
};

export class RuntimeTransport {
  private clients = new Map<string, BedrockAgentCoreClient>();
  constructor(private readonly send?: Send) {}

  async request(input: RuntimeRequest): Promise<Response> {
    const method = input.method ?? "GET";
    const url = new URL(input.path, "http://runtime");
    if (method === "POST" && /^\/threads\/[^/]+\/resume$/.test(url.pathname)) {
      try {
        runtimeResumeResponse(
          (input.body as Record<string, unknown> | null | undefined)?.response,
        );
      } catch {
        throw new ApiError(
          400,
          "Invalid runtime resume options",
          "INVALID_INPUT",
        );
      }
    }
    let window: boolean | undefined;
    let sync: "v1" | undefined;
    try {
      const queries = url.searchParams.getAll("window");
      if (queries.length > 1)
        throw new TypeError("Invalid runtime snapshot window");
      const queried = runtimeWindowQuery(queries[0]);
      window = runtimeWindowOption(
        method,
        url.pathname,
        input.window === undefined ? queried : input.window,
      );
      if (queried && input.window === false)
        throw new TypeError("Conflicting runtime snapshot window");
      const syncQueries = url.searchParams.getAll("sync");
      if (syncQueries.length > 1)
        throw new TypeError("Invalid runtime synchronization mode");
      sync = runtimeSyncOption(
        method,
        url.pathname,
        input.sync === undefined ? syncQueries[0] : input.sync,
      );
      if (
        syncQueries[0] !== undefined &&
        input.sync !== undefined &&
        syncQueries[0] !== input.sync
      )
        throw new TypeError("Conflicting runtime synchronization mode");
    } catch {
      throw new ApiError(400, "Invalid runtime read options", "INVALID_INPUT");
    }
    if (window) url.searchParams.set("window", "1");
    if (sync) url.searchParams.set("sync", sync);
    if (!isAgentCoreRuntime(input.owner)) {
      return fetch(input.owner + url.pathname + url.search, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(input.requestId ? { "x-request-id": input.requestId } : {}),
          ...(input.cursor ? { "Last-Event-ID": input.cursor } : {}),
        },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: input.signal ?? AbortSignal.timeout(35_000),
      });
    }

    if (
      [...url.searchParams.keys()].some(
        (key) => !["cursor", "window", "sync"].includes(key),
      )
    )
      throw new ApiError(400, "Unsupported runtime query", "INVALID_INPUT");
    let sessionId = input.sessionId;
    if (
      !sessionId &&
      (["/healthz", "/livez", "/capabilities"].includes(url.pathname) ||
        /^\/schemas\/[A-Za-z0-9_]+$/.test(url.pathname))
    )
      sessionId =
        "truex-health-" +
        createHash("sha256").update(input.owner).digest("hex").slice(0, 48);
    if (!sessionId || !/^[A-Za-z0-9][A-Za-z0-9_-]{32,255}$/.test(sessionId))
      throw new ApiError(
        503,
        "This conversation has no configured runtime session. Start a new conversation.",
        "OWNER_SESSION_UNCONFIGURED",
      );

    const region = input.owner.match(runtimeArn)![1];
    const signal = input.signal ?? AbortSignal.timeout(150_000);
    const cursor = input.cursor || url.searchParams.get("cursor") || undefined;
    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: input.owner,
      runtimeSessionId: sessionId,
      contentType: "application/json",
      accept: url.pathname.endsWith("/events")
        ? "text/event-stream"
        : "application/json",
      payload: Buffer.from(
        JSON.stringify({
          method,
          path: url.pathname,
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(cursor === undefined ? {} : { cursor }),
          ...(input.requestId ? { requestId: input.requestId } : {}),
          ...(window === undefined ? {} : { window }),
          ...(sync === undefined ? {} : { sync }),
        }),
      ),
    });
    const output = this.send
      ? await this.send(region, command, signal)
      : await this.client(region).send(command, { abortSignal: signal });
    if (output.runtimeSessionId && output.runtimeSessionId !== sessionId)
      throw new ApiError(
        502,
        "The assistant service returned a different session.",
        "INVALID_UPSTREAM_RESPONSE",
      );
    if (!output.response)
      throw new ApiError(
        502,
        "The assistant service returned an empty response.",
        "INVALID_UPSTREAM_RESPONSE",
      );
    const response = new Response(
      output.response.transformToWebStream() as ReadableStream<Uint8Array>,
      {
        status: output.statusCode ?? output.$metadata.httpStatusCode ?? 200,
        headers: { "Content-Type": output.contentType ?? "application/json" },
      },
    );
    if (!response.ok || output.contentType?.startsWith("text/event-stream"))
      return response;
    let envelope: any;
    try {
      envelope = await response.json();
    } catch (cause) {
      throw new ApiError(
        502,
        "The assistant service returned an unreadable response.",
        "INVALID_UPSTREAM_RESPONSE",
        { cause },
      );
    }
    if (
      !Number.isInteger(envelope?.status) ||
      envelope.status < 200 ||
      envelope.status > 599 ||
      !Object.hasOwn(envelope, "body")
    )
      throw new ApiError(
        502,
        "The assistant service returned an invalid response.",
        "INVALID_UPSTREAM_RESPONSE",
      );
    return new Response(
      [204, 205, 304].includes(envelope.status)
        ? null
        : JSON.stringify(envelope.body),
      {
        status: envelope.status,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  private client(region: string) {
    let client = this.clients.get(region);
    if (!client) {
      client = new BedrockAgentCoreClient({
        region,
        // Retrying an accepted thread/turn creation could duplicate work.
        maxAttempts: 1,
        requestHandler: new NodeHttpHandler({
          connectionTimeout: 10_000,
          socketTimeout: 0,
          requestTimeout: 0,
        }),
      });
      this.clients.set(region, client);
    }
    return client;
  }

  close() {
    for (const client of this.clients.values()) client.destroy();
    this.clients.clear();
  }
}
