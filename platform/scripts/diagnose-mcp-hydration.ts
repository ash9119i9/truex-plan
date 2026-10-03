/** Read-only network/protocol diagnostics. No tool execution, model calls or config writes. */
import dotenv from "dotenv";
import { MongoClient, ObjectId } from "mongodb";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolve4, resolve6, lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";

dotenv.config({ path: "platform/.env", quiet: true });
dotenv.config({ path: "agent-core/.env", quiet: true });
const timeoutMs = 20000;
const root = resolve("docs/adaptive-correctness-fix");
const mongo = new MongoClient(
  process.env.MONGO_URI || "mongodb://127.0.0.1:27017",
);
const networkEvents: any[] = [];
const attempts: any[] = [];
const sessionHash = (session: string | undefined) =>
  session
    ? createHash("sha256").update(session).digest("hex").slice(0, 12)
    : null;
const safeError = (error: any) => ({
  name: error?.name,
  code: error?.code || error?.cause?.code,
});
for (const name of [
  "undici:client:beforeConnect",
  "undici:client:connected",
  "undici:client:connectError",
])
  channel(name).subscribe((message: any) => {
    networkEvents.push({
      type: name,
      at: new Date().toISOString(),
      hostname: message.connectParams?.hostname,
      port: message.connectParams?.port,
      remoteAddress: message.socket?.remoteAddress,
      ...safeError(message.error),
    });
  });

function matchingRpc(raw: string, id: number, sse: boolean): any | undefined {
  if (!sse) {
    try {
      const value = JSON.parse(raw);
      return (Array.isArray(value) ? value : [value]).find(
        (value) => value?.id === id,
      );
    } catch {
      return undefined;
    }
  }
  for (const event of raw.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const value = JSON.parse(data);
      const match = (Array.isArray(value) ? value : [value]).find(
        (value) => value?.id === id,
      );
      if (match) return match;
    } catch {
      /* Wait for remaining chunk. */
    }
  }
  return undefined;
}

type Reply = {
  status: number;
  session?: string;
  protocol?: string;
  rpc?: any;
  notificationAccepted?: boolean;
};
type Transport = (
  body: any,
  headers: Record<string, string>,
  label: string,
) => Promise<Reply>;

async function main() {
  try {
    await mongo.connect();
    const mcp: any = await mongo
      .db(process.env.MONGO_DB || "truex")
      .collection("truex_mcp")
      .findOne({ _id: new ObjectId("6aaa7db671c8cc9e29e08d93") });
    if (!mcp) throw new Error("MCP profile missing");
    const endpoint = new URL(mcp.url);
    const credentials = { [mcp.auth.headerName]: mcp.apiKey };
    const dns = await Promise.allSettled([
      resolve4(endpoint.hostname),
      resolve6(endpoint.hostname),
      lookup(endpoint.hostname, { all: true }),
    ]);
    const dnsEvidence = dns.map((value, i) => ({
      type: ["A", "AAAA", "lookup"][i],
      ...(value.status === "fulfilled"
        ? { addresses: value.value }
        : { error: safeError(value.reason) }),
    }));
    const baseHeaders = (
      protocol: string,
      session?: string,
    ): Record<string, string> => ({
      ...credentials,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": protocol,
      ...(session ? { "Mcp-Session-Id": session } : {}),
    });
    const newEntry = (client: string, body: any, label: string) => {
      const entry: any = {
        client,
        label,
        method: body.method,
        requestedProtocol: body.params?.protocolVersion,
        at: new Date().toISOString(),
        timeoutMs,
      };
      attempts.push(entry);
      return entry;
    };
    const finish = (entry: any, rpc: any) => {
      if (rpc?.error)
        entry.rpcError = {
          code: rpc.error.code,
          message: String(rpc.error.message)
            .split(mcp.apiKey)
            .join("[REDACTED]"),
        };
      if (rpc?.result?.protocolVersion)
        entry.negotiatedProtocol = rpc.result.protocolVersion;
      if (Array.isArray(rpc?.result?.tools))
        entry.toolCount = rpc.result.tools.length;
    };

    const nodeFetch: Transport = async (body, headers, label) => {
      const entry = newEntry("node-fetch", body, label);
      const started = performance.now();
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
        entry.headersMs = performance.now() - started;
        entry.status = response.status;
        entry.contentType = response.headers.get("content-type");
        const session = response.headers.get("mcp-session-id") || undefined;
        entry.sessionHash = sessionHash(session);
        if (!response.body || body.id === undefined) {
          const cancelled = response.body?.cancel();
          if (cancelled)
            await Promise.race([
              cancelled,
              new Promise((resolve) => setTimeout(resolve, 2000)),
            ]);
          entry.totalMs = performance.now() - started;
          return {
            status: response.status,
            session,
            notificationAccepted: response.ok,
          };
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let raw = "",
          rpc: any;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (entry.firstBodyMs === undefined)
            entry.firstBodyMs = performance.now() - started;
          raw += decoder.decode(chunk.value, { stream: true });
          if (raw.length > 2 * 1024 * 1024)
            throw new Error("Diagnostic response limit");
          rpc = matchingRpc(
            raw,
            body.id,
            entry.contentType?.includes("text/event-stream"),
          );
          if (rpc) {
            entry.matchedRpcMs = performance.now() - started;
            break;
          }
        }
        entry.bytes = Buffer.byteLength(raw);
        finish(entry, rpc);
        let cancelled = false;
        const cancelStart = performance.now();
        await Promise.race([
          reader.cancel().then(() => {
            cancelled = true;
          }),
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
        entry.readerCancelCompleted = cancelled;
        entry.readerCancelMs = performance.now() - cancelStart;
        reader.releaseLock();
        entry.totalMs = performance.now() - started;
        return {
          status: response.status,
          session,
          rpc,
          protocol: rpc?.result?.protocolVersion,
        };
      } catch (error) {
        entry.error = safeError(error);
        entry.failureStage =
          entry.headersMs === undefined
            ? "before-headers"
            : entry.matchedRpcMs === undefined
              ? "response-body"
              : "reader-cancellation";
        entry.totalMs = performance.now() - started;
        throw error;
      }
    };

    const nodeHttps: Transport = async (body, headers, label) => {
      const entry = newEntry("node-https", body, label);
      const started = performance.now();
      const rawRequest = JSON.stringify(body);
      return new Promise((resolveReply, reject) => {
        const req = httpsRequest(
          endpoint,
          {
            method: "POST",
            headers: {
              ...headers,
              "content-length": String(Buffer.byteLength(rawRequest)),
            },
            timeout: timeoutMs,
          },
          (response) => {
            entry.headersMs = performance.now() - started;
            entry.status = response.statusCode;
            entry.contentType = response.headers["content-type"];
            const session =
              typeof response.headers["mcp-session-id"] === "string"
                ? response.headers["mcp-session-id"]
                : undefined;
            entry.sessionHash = sessionHash(session);
            let raw = "";
            let ended = false;
            const done = (rpc?: any) => {
              if (ended) return;
              ended = true;
              finish(entry, rpc);
              entry.totalMs = performance.now() - started;
              resolveReply({
                status: response.statusCode!,
                session,
                rpc,
                protocol: rpc?.result?.protocolVersion,
                notificationAccepted:
                  body.id === undefined && response.statusCode === 202,
              });
              response.destroy();
            };
            response.on("data", (chunk) => {
              if (entry.firstBodyMs === undefined)
                entry.firstBodyMs = performance.now() - started;
              raw += chunk;
              if (raw.length > 2 * 1024 * 1024) {
                req.destroy(new Error("Diagnostic response limit"));
                return;
              }
              const rpc = matchingRpc(
                raw,
                body.id,
                entry.contentType?.includes("text/event-stream"),
              );
              if (rpc) {
                entry.matchedRpcMs = performance.now() - started;
                entry.bytes = Buffer.byteLength(raw);
                done(rpc);
              }
            });
            response.on("end", () => done());
            response.on("error", (error) => {
              if (!ended) reject(error);
            });
            if (body.id === undefined) done();
          },
        );
        req.on("socket", (socket) => {
          socket.on("lookup", () => {
            entry.lookupMs = performance.now() - started;
          });
          socket.on("connect", () => {
            entry.tcpConnectMs = performance.now() - started;
            entry.remoteAddress = socket.remoteAddress;
          });
          socket.on("secureConnect", () => {
            entry.tlsConnectMs = performance.now() - started;
          });
        });
        req.on("timeout", () =>
          req.destroy(
            Object.assign(new Error("Timeout"), { name: "TimeoutError" }),
          ),
        );
        req.on("error", (error) => {
          entry.error = safeError(error);
          entry.failureStage =
            entry.headersMs === undefined ? "before-headers" : "response-body";
          entry.totalMs = performance.now() - started;
          reject(error);
        });
        req.end(rawRequest);
      });
    };

    const curl: Transport = async (body, headers, label) => {
      const entry = newEntry("curl-http1.1", body, label);
      const started = performance.now();
      const marker = "\n__CURL_METRICS__";
      const metrics =
        '{"status":%{http_code},"lookup":%{time_namelookup},"connect":%{time_connect},"tls":%{time_appconnect},"firstByte":%{time_starttransfer},"total":%{time_total},"remoteIp":"%{remote_ip}","httpVersion":"%{http_version}"}';
      const config =
        [
          `url = ${JSON.stringify(endpoint.href)}`,
          'request = "POST"',
          "http1.1",
          "include",
          `max-time = ${timeoutMs / 1000}`,
          ...Object.entries(headers).map(
            ([key, value]) => `header = ${JSON.stringify(`${key}: ${value}`)}`,
          ),
          `data = ${JSON.stringify(JSON.stringify(body))}`,
        ].join("\n") + "\n";
      return new Promise((resolveReply, reject) => {
        const child = spawn(
          "curl",
          [
            "--config",
            "-",
            "--silent",
            "--show-error",
            "--write-out",
            marker + metrics,
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.stdin.end(config);
        child.on("error", reject);
        child.on("close", (code) => {
          const metricStart = stdout.lastIndexOf(marker);
          const raw = metricStart >= 0 ? stdout.slice(0, metricStart) : stdout;
          if (metricStart >= 0) {
            try {
              entry.curlTimingsSeconds = JSON.parse(
                stdout.slice(metricStart + marker.length),
              );
            } catch {}
          }
          entry.exitCode = code;
          entry.totalMs = performance.now() - started;
          if (code !== 0) {
            entry.failureStage = entry.curlTimingsSeconds?.firstByte
              ? "response-body"
              : "before-headers";
            entry.error = {
              name: "CurlFailure",
              code,
              message: stderr.trim().split(mcp.apiKey).join("[REDACTED]"),
            };
            reject(new Error("Curl diagnostic failed"));
            return;
          }
          const separator = /\r?\n\r?\n/.exec(raw);
          const rawHeaders = separator ? raw.slice(0, separator.index) : raw;
          const payload = separator
            ? raw.slice(separator.index + separator[0].length)
            : "";
          const session = /^mcp-session-id:\s*(.+)$/im
            .exec(rawHeaders)?.[1]
            .trim();
          entry.sessionHash = sessionHash(session);
          entry.status = entry.curlTimingsSeconds.status;
          entry.contentType = /^content-type:\s*(.+)$/im
            .exec(rawHeaders)?.[1]
            .trim();
          entry.headersMs = entry.curlTimingsSeconds.firstByte * 1000;
          const rpc = matchingRpc(
            payload,
            body.id,
            entry.contentType?.includes("text/event-stream"),
          );
          entry.bytes = Buffer.byteLength(payload);
          finish(entry, rpc);
          resolveReply({
            status: entry.status,
            session,
            rpc,
            protocol: rpc?.result?.protocolVersion,
            notificationAccepted: body.id === undefined && entry.status === 202,
          });
        });
      });
    };

    const transports = [nodeFetch, nodeHttps, curl];
    if (process.argv.includes("--captured-rust")) {
      const capture = JSON.parse(
        await readFile(resolve(root, "codex-protocol-capture.json"), "utf8"),
      );
      const init = capture.actualRequests.find(
        (entry: any) => entry.rpc?.method === "initialize",
      );
      const actualHeaders = {
        ...credentials,
        "content-type": "application/json",
        accept: init.headers.accept,
        "user-agent": init.headers["user-agent"],
      };
      const gatewayBody = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "truex-omni-gateway", version: "0.1.0" },
        },
      };
      await Promise.allSettled([
        nodeFetch(
          gatewayBody,
          baseHeaders("2025-03-26"),
          "concurrent-gateway-baseline",
        ),
        nodeFetch(init.rpc, actualHeaders, "actual-rust-body-headers"),
        nodeHttps(init.rpc, actualHeaders, "actual-rust-body-headers"),
        curl(init.rpc, actualHeaders, "actual-rust-body-headers"),
        nodeFetch(
          init.rpc,
          { ...actualHeaders, "MCP-Protocol-Version": "2025-06-18" },
          "rust-plus-initialize-protocol-header",
        ),
        nodeFetch(gatewayBody, actualHeaders, "gateway-body-rust-headers"),
      ]);
    } else
      for (const protocol of ["2025-03-26", "2025-06-18"]) {
        await Promise.allSettled(
          transports.map(async (transport) => {
            const label = `same-body-${protocol}`;
            const initialized = await transport(
              {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                  protocolVersion: protocol,
                  capabilities: {},
                  clientInfo: { name: "truex-omni-gateway", version: "0.1.0" },
                },
              },
              baseHeaders(protocol),
              label,
            );
            if (
              !initialized.rpc?.result?.protocolVersion ||
              initialized.status !== 200
            )
              return;
            const negotiated = initialized.protocol!;
            const notified = await transport(
              { jsonrpc: "2.0", method: "notifications/initialized" },
              baseHeaders(negotiated, initialized.session),
              label,
            );
            if (notified.status < 200 || notified.status >= 300) return;
            await transport(
              { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
              baseHeaders(negotiated, initialized.session),
              label,
            );
          }),
        );
      }
    const report = {
      createdAt: new Date().toISOString(),
      evidence:
        "Read-only protocol/transport diagnostics; no model calls or business tool execution; credentials and raw session IDs excluded",
      endpoint: `${endpoint.origin}${endpoint.pathname}`,
      nodeVersion: process.version,
      timeoutMs,
      proxyEnvironmentPresence: Object.fromEntries(
        [
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "ALL_PROXY",
          "NO_PROXY",
          "http_proxy",
          "https_proxy",
          "all_proxy",
          "no_proxy",
        ].map((key) => [key, process.env[key] !== undefined]),
      ),
      dns: dnsEvidence,
      attempts,
      networkEvents,
      caveat:
        "Sequential protocol arms and concurrent client probes are diagnostic counterfactuals; differing outcomes establish the observed transport boundary, not automatically the upstream implementation's reason.",
    };
    const filename = process.argv.includes("--captured-rust")
      ? "hydration-rust-counterfactual.json"
      : "hydration-diagnostic.json";
    await mkdir(root, { recursive: true });
    await writeFile(
      resolve(root, filename),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        output: resolve(root, filename),
        attempts: attempts.map((entry) => ({
          client: entry.client,
          label: entry.label,
          method: entry.method,
          protocol: entry.requestedProtocol,
          status: entry.status,
          failureStage: entry.failureStage,
          error: entry.error,
          toolCount: entry.toolCount,
          totalMs: entry.totalMs,
        })),
      }),
    );
  } finally {
    await mongo.close();
  }
}
main().catch((error) => {
  console.error(JSON.stringify(safeError(error)));
  process.exitCode = 1;
});
