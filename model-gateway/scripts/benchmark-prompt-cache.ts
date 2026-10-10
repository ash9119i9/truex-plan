import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import { createGateway } from "../src/server";
import { createProfileStore, type StoredProfile } from "../src/profiles";
import { toAnthropicRequest } from "../src/adapters/anthropic";
import { signGatewayToken } from "../../shared/gateway-token";
import { sseData } from "../src/responses";

// Real, sequential A/B calls through the actual baseline and candidate gateways.
// Credentials are read from existing app configuration and never written to reports.
// Baseline caching remains enabled exactly as implemented at the requested Git ref.
const root = resolve(__dirname, "../..");
const args = process.argv.slice(2);
function arg(name: string, fallback?: string) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--"))
    throw new Error(`Missing ${name} value`);
  return args[i + 1];
}
function bounded(name: string, fallback: string, max: number) {
  const n = Number(arg(name, fallback));
  if (!Number.isInteger(n) || n < 2 || n > max)
    throw new Error(`Invalid ${name}`);
  return n;
}
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
function stripMarkers(value: any): any {
  if (Array.isArray(value)) return value.map(stripMarkers);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "cache_control")
        .map(([key, val]) => [key, stripMarkers(val)]),
    );
  return value;
}
function percentile(values: number[], q: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (q === 0.5 && sorted.length % 2 === 0)
    return Math.round(
      (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
    );
  return Math.round(sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]);
}

const rows = Array.from({ length: 240 }, (_, i) => ({
  id: `INV-${String(i + 1).padStart(4, "0")}`,
  customer: `Account-${String(i + 1).padStart(4, "0")}`,
  amount: 1000 + i * 17,
  status: i % 3 === 0 ? "overdue" : i % 3 === 1 ? "paid" : "pending",
  region: ["north", "south", "east", "west"][i % 4],
  dueDays: i % 29,
  note: "Synthetic invoice record; amounts are in benchmark units; no private customer data.",
}));
const document = rows.map((row) => JSON.stringify(row)).join("\n");
function request(partition: string, question: number) {
  const row = rows[[17, 83, 219, 41, 137, 9, 199, 63, 111, 231][question]];
  return {
    instructions: `Benchmark partition ${partition}; this identifier has no business meaning. You are an invoice assistant. Use the supplied reference exactly. Return only a JSON object containing id, amount, status and region for the requested invoice. Do not call tools.`,
    reasoning: { effort: "low" },
    tool_choice: "none",
    // Advertise one inert tool so the existing adapter forwards tool_choice.
    // Both arms receive the exact same definition. No tool is executed.
    tools: [
      {
        type: "function",
        name: "benchmark_lookup",
        description:
          "Disabled during benchmark; use the reference already provided.",
        parameters: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    ],
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: `Invoice reference:\n${document}` },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "I will use this reference for invoice lookups.",
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: `Look up ${row.id}.` }],
      },
    ],
  };
}
function correct(answer: string, question: number) {
  const row = rows[[17, 83, 219, 41, 137, 9, 199, 63, 111, 231][question]];
  try {
    const parsed = JSON.parse(
      answer
        .trim()
        .replace(/^```(?:json)?\s*/, "")
        .replace(/\s*```$/, ""),
    );
    return (
      ["id", "amount", "status", "region"].every(
        (key) => parsed[key] === (row as any)[key],
      ) && Object.keys(parsed).length === 4
    );
  } catch {
    return false;
  }
}

type Rates = {
  currency: string;
  source: string;
  input: number;
  read: number;
  write5m: number;
  write1h: number;
  output: number;
};
function readRates(): Rates | null {
  const path = arg("--rates");
  if (!path) return null;
  const rates = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (
    typeof rates.currency !== "string" ||
    typeof rates.source !== "string" ||
    ["input", "read", "write5m", "write1h", "output"].some(
      (k) =>
        typeof rates[k] !== "number" ||
        !Number.isFinite(rates[k]) ||
        rates[k] < 0,
    )
  )
    throw new Error(
      "Rates need currency, source and nonnegative input/read/write5m/write1h/output rates per million tokens.",
    );
  return rates;
}
function cost(usage: any, rates: Rates | null): number | null {
  if (
    !rates ||
    [
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
    ].some((k) => typeof usage[k] !== "number")
  )
    return null;
  // Both benchmark arms use only 5m markers. Prefer the provider's TTL breakdown.
  const writes5m =
    usage.cache_creation?.ephemeral_5m_input_tokens ??
    usage.cache_creation_input_tokens;
  const writes1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return (
    (usage.input_tokens * rates.input +
      usage.cache_read_input_tokens * rates.read +
      writes5m * rates.write5m +
      writes1h * rates.write1h +
      usage.output_tokens * rates.output) /
    1e6
  );
}

async function main() {
  const baselineRef = arg(
    "--baseline",
    "2417dff195b22f19b3dc5c29a48d6a30d3c02354",
  )!;
  const blocks = bounded("--blocks", "2", 5);
  const requests = bounded("--requests", "3", 10);
  const rates = readRates();
  const policyMode = arg("--policy", "explicit");
  if (!["default", "explicit"].includes(policyMode!))
    throw new Error("Invalid --policy");
  const started = new Date().toISOString();
  const output = resolve(
    arg(
      "--output",
      join(
        root,
        "benchmark-reports",
        `prompt-cache-${started.replace(/[:.]/g, "-")}`,
      ),
    )!,
  );
  mkdirSync(dirname(output), { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "truex-cache-baseline-"));
  dotenv.config({ path: join(root, "model-gateway/.env"), quiet: true });
  dotenv.config({ path: join(root, "platform/.env"), quiet: true });
  const client = new MongoClient(
    process.env.MONGO_URI || "mongodb://127.0.0.1:27017",
    { serverSelectionTimeoutMS: 5000 },
  );
  const servers: ReturnType<typeof createGateway>[] = [];
  const samples: any[] = [];
  const report: any = {
    kind: "real-provider-gateway-ab",
    started,
    baselineRef,
    blocks,
    requestsPerArmPerBlock: requests,
    rates,
    policyMode,
    samples,
    workload: {
      invoices: rows.length,
      referenceBytes: Buffer.byteLength(document),
      referenceSha256: hash(document),
      maxOutputTokens: 512,
      reasoningEffort: "low",
    },
    limitations: [
      "Synthetic invoice extraction through gateways, not a full UI or agent workload.",
      "Short repeated-request test; it does not evaluate reuse after five minutes or one hour.",
      "Baseline already requests caching. Automatic caching was not artificially disabled.",
      "Each arm uses an equal-length unique partition in its initial instructions to isolate caches. Business reference and questions are identical.",
      "Small sample; latency differences are descriptive and not a statistical guarantee.",
      "Single-call answer scoring; requests for tools are recorded as no final text, not silently counted as fast answers.",
      "Provider-reported tokens are not an invoice. Monetary estimates require actual endpoint rates.",
    ],
  };
  try {
    const archive = execFileSync(
      "git",
      ["archive", baselineRef, "model-gateway/src", "shared/gateway-token.ts"],
      { cwd: root },
    );
    execFileSync("tar", ["-x", "-C", scratch], { input: archive });
    symlinkSync(
      join(root, "model-gateway/node_modules"),
      join(scratch, "model-gateway/node_modules"),
      "dir",
    );
    const baselineModule = await import(
      pathToFileURL(join(scratch, "model-gateway/src/server.ts")).href
    );
    const baselineAdapter = await import(
      pathToFileURL(join(scratch, "model-gateway/src/adapters/anthropic.ts"))
        .href
    );
    const baselineCreate =
      baselineModule.createGateway ?? baselineModule.default?.createGateway;
    const baselineTranslate =
      baselineAdapter.toAnthropicRequest ??
      baselineAdapter.default?.toAnthropicRequest;
    if (!baselineCreate || !baselineTranslate)
      throw new Error("Could not load baseline gateway exports");
    await client.connect();
    const collection = client
      .db(process.env.CATALOG_MONGO_DB || process.env.MONGO_DB || "truex")
      .collection<StoredProfile>("truex_models");
    const candidates = await collection
      .find(
        { enabled: { $ne: false }, wireApi: "anthropic" },
        { projection: { _id: 1 } },
      )
      .toArray();
    const id =
      arg("--profile") ??
      (candidates.length === 1 ? String(candidates[0]._id) : undefined);
    if (!id)
      throw new Error(
        "Choose --profile for a configured Anthropic-compatible model",
      );
    const profile = await createProfileStore({ collection }).find(id);
    if (
      !profile ||
      profile.wireApi !== "anthropic" ||
      profile.enabled === false ||
      !(profile.apiKey || profile.apikey)
    )
      throw new Error("Configured Anthropic-compatible profile unavailable");
    const baseProfile = { ...profile, maxOutputTokens: 512 };
    delete baseProfile.promptCache;
    const candidateProfile = {
      ...baseProfile,
      ...(policyMode === "explicit"
        ? {
            promptCache: {
              type: "anthropic" as const,
              ttl: "5m" as const,
              conversationBreakpoint: true,
            },
          }
        : {}),
    };
    const parityRequest = request("content-equivalence", 0);
    const oldParams = baselineTranslate(parityRequest, baseProfile).params;
    const newParams = toAnthropicRequest(
      parityRequest,
      candidateProfile,
    ).params;
    report.contentEquivalent =
      JSON.stringify(stripMarkers(oldParams)) ===
      JSON.stringify(stripMarkers(newParams));
    if (!report.contentEquivalent)
      throw new Error("Baseline/candidate prompt content mismatch");
    report.model = profile.modelName;
    report.wireApi = profile.wireApi;
    report.providerHost = new URL(profile.baseUrl).host;
    report.baselineSha = execFileSync("git", ["rev-parse", baselineRef], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    report.candidateHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const sourceFiles = [
      "shared/prompt-cache.ts",
      "model-gateway/src/prompt-cache.ts",
      "model-gateway/src/adapter.ts",
      "model-gateway/src/server.ts",
      "model-gateway/src/responses.ts",
      "model-gateway/src/logging.ts",
      "model-gateway/src/adapters/chat.ts",
      "model-gateway/src/adapters/anthropic.ts",
    ];
    report.candidateDigests = Object.fromEntries(
      sourceFiles.map((file) => [
        file,
        createHash("sha256")
          .update(readFileSync(join(root, file)))
          .digest("hex"),
      ]),
    );
    const secret = randomBytes(32).toString("hex");
    const captures: Record<string, any[]> = { baseline: [], candidate: [] };
    const logs: Record<string, string[]> = { baseline: [], candidate: [] };
    const endpoints: Record<string, string> = {};
    for (const arm of ["baseline", "candidate"]) {
      const server = (arm === "baseline" ? baselineCreate : createGateway)({
        secret,
        findProfile: async () =>
          arm === "baseline" ? baseProfile : candidateProfile,
        log: (line: string) => logs[arm].push(line),
        fetch: (async (url: any, init: any) => {
          const entry: any = { requestSha256: hash(JSON.parse(init.body)) };
          captures[arm].push(entry);
          const upstream = await fetch(url, init);
          entry.status = upstream.status;
          // Only whitelisted usage and model identity are extracted from provider SSE.
          entry.usagePromise = upstream
            .clone()
            .text()
            .then((raw) => {
              const usage: any = {};
              entry.eventCounts = {};
              for (const line of raw.split("\n")) {
                if (!line.startsWith("data:")) continue;
                try {
                  const event = JSON.parse(line.slice(5).trim());
                  if (typeof event.type === "string")
                    entry.eventCounts[event.type] =
                      (entry.eventCounts[event.type] ?? 0) + 1;
                  if (event.delta?.stop_reason)
                    entry.stopReason = event.delta.stop_reason;
                  if (event.message?.model)
                    entry.providerModel = event.message.model;
                  const source = event.message?.usage ?? event.usage;
                  if (source)
                    for (const k of [
                      "input_tokens",
                      "output_tokens",
                      "cache_read_input_tokens",
                      "cache_creation_input_tokens",
                      "cache_creation",
                    ])
                      if (source[k] !== undefined && source[k] !== null)
                        usage[k] = source[k];
                } catch {
                  /* SSE comments and DONE aren't JSON usage events. */
                }
              }
              return usage;
            });
          return upstream;
        }) as typeof fetch,
      });
      servers.push(server);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      endpoints[arm] =
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/p/${encodeURIComponent(id)}/v1/responses`;
    }
    for (let block = 0; block < blocks; block++) {
      // Reverse arm order in alternating blocks to reduce time/order bias.
      const arms =
        block % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"];
      const partitions = { baseline: randomUUID(), candidate: randomUUID() };
      for (let question = 0; question < requests; question++)
        for (const arm of arms) {
          const at = performance.now();
          const captureIndex = captures[arm].length;
          const req = request(
            partitions[arm as keyof typeof partitions],
            question,
          );
          const res = await fetch(endpoints[arm], {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${signGatewayToken(id, secret, "benchmark")}`,
            },
            body: JSON.stringify(req),
            signal: AbortSignal.timeout(120000),
          });
          let answer = "";
          let ttft: number | null = null;
          let completed: any;
          let outcome = `http_${res.status}`;
          if (res.ok && res.body)
            for await (const data of sseData(res.body)) {
              const event = JSON.parse(data);
              if (event.type === "response.output_text.delta") {
                if (ttft === null && event.delta?.trim())
                  ttft = performance.now() - at;
                answer += event.delta ?? "";
              }
              if (event.type === "response.completed") {
                completed = event.response;
                outcome = "completed";
              }
              if (event.type === "response.failed") outcome = "failed";
            }
          const elapsed = performance.now() - at;
          const captured = captures[arm][captureIndex];
          const rawUsage = captured?.usagePromise
            ? await captured.usagePromise
            : {};
          const sample = {
            arm,
            block,
            question,
            phase: question === 0 ? "cold" : "warm",
            outcome,
            durationMs: Math.round(elapsed),
            ttftMs: ttft === null ? null : Math.round(ttft),
            correct: correct(answer, question),
            answer,
            rawUsage,
            gatewayUsage: completed?.usage ?? null,
            providerModel: captured?.providerModel ?? null,
            providerStatus: captured?.status ?? null,
            providerStopReason: captured?.stopReason ?? null,
            providerEventCounts: captured?.eventCounts ?? null,
            upstreamCalls: captures[arm].length - captureIndex,
            requestSha256: captured?.requestSha256 ?? null,
            estimatedCost: cost(rawUsage, rates),
          };
          samples.push(sample);
          console.log(
            JSON.stringify({
              arm,
              block,
              question,
              phase: sample.phase,
              outcome,
              durationMs: sample.durationMs,
              ttftMs: sample.ttftMs,
              correct: sample.correct,
              usage: rawUsage,
            }),
          );
          writeFileSync(
            output + ".json",
            JSON.stringify(report, null, 2) + "\n",
          );
          if (outcome !== "completed")
            throw new Error(
              "Provider request failed; stopped to avoid repeating failed calls",
            );
        }
    }
    report.gatewayLogs = Object.fromEntries(
      Object.entries(logs).map(([arm, lines]) => [
        arm,
        lines
          .map((line) => {
            try {
              const v = JSON.parse(line);
              return v.type === "access" ? v : null;
            } catch {
              return null;
            }
          })
          .filter(Boolean),
      ]),
    );
  } catch (error) {
    report.error = error instanceof Error ? error.message : "Benchmark failed";
    process.exitCode = 1;
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
    await client.close();
    rmSync(scratch, { recursive: true, force: true });
    report.finished = new Date().toISOString();
    report.summary = Object.fromEntries(
      ["baseline", "candidate"].map((arm) => {
        const s = samples.filter((v) => v.arm === arm);
        const warm = s.filter((v) => v.phase === "warm");
        const known =
          s.length > 0 &&
          s.every(
            (v) =>
              typeof v.rawUsage.cache_read_input_tokens === "number" &&
              typeof v.rawUsage.cache_creation_input_tokens === "number" &&
              typeof v.rawUsage.input_tokens === "number",
          );
        const reads = s.reduce(
          (n, v) => n + (v.rawUsage.cache_read_input_tokens ?? 0),
          0,
        );
        const writes = s.reduce(
          (n, v) => n + (v.rawUsage.cache_creation_input_tokens ?? 0),
          0,
        );
        const uncached = s.reduce(
          (n, v) => n + (v.rawUsage.input_tokens ?? 0),
          0,
        );
        const sumInput = reads + writes + uncached;
        return [
          arm,
          {
            requests: s.length,
            correct: s.filter((v) => v.correct).length,
            emptyAnswers: s.filter((v) => !v.answer.trim()).length,
            toolRequestResponses: s.filter(
              (v) => v.providerStopReason === "tool_use",
            ).length,
            reportedInputTokens:
              s.length > 0 &&
              s.every((v) => typeof v.rawUsage.input_tokens === "number")
                ? s.reduce((n, v) => n + v.rawUsage.input_tokens, 0)
                : null,
            cacheUsageReported: s.length > 0 && known,
            cacheReadTokens: known ? reads : null,
            cacheWriteTokens: known ? writes : null,
            uncachedInputTokens: known ? uncached : null,
            outputTokens:
              s.length > 0 &&
              s.every((v) => typeof v.rawUsage.output_tokens === "number")
                ? s.reduce((n, v) => n + v.rawUsage.output_tokens, 0)
                : null,
            tokenCacheReadFraction: known && sumInput ? reads / sumInput : null,
            medianColdTtftMs: percentile(
              s
                .filter((v) => v.phase === "cold" && v.ttftMs !== null)
                .map((v) => v.ttftMs),
              0.5,
            ),
            medianWarmTtftMs: percentile(
              warm.filter((v) => v.ttftMs !== null).map((v) => v.ttftMs),
              0.5,
            ),
            medianWarmDurationMs: percentile(
              warm.map((v) => v.durationMs),
              0.5,
            ),
            medianCorrectWarmDurationMs: percentile(
              warm.filter((v) => v.correct).map((v) => v.durationMs),
              0.5,
            ),
            p95DurationMs: percentile(
              s.map((v) => v.durationMs),
              0.95,
            ),
            estimatedCost:
              rates && s.length && s.every((v) => v.estimatedCost !== null)
                ? s.reduce((n, v) => n + v.estimatedCost, 0)
                : null,
          },
        ];
      }),
    );
    writeFileSync(output + ".json", JSON.stringify(report, null, 2) + "\n");
    const a = report.summary.baseline,
      b = report.summary.candidate;
    const cell = (v: any) => (v === null ? "Unverified" : String(v));
    const markdown = [
      "# Real provider prompt-cache benchmark",
      "",
      `Started: ${started}`,
      `Baseline: \`${report.baselineSha ?? baselineRef}\``,
      `Model profile: \`${report.model ?? "unavailable"}\``,
      `Provider host: \`${report.providerHost ?? "unavailable"}\``,
      `Candidate policy: \`${policyMode}\``,
      "",
      `Prompt content equivalent before cache-isolation partitions: **${report.contentEquivalent === true ? "PASS" : "UNVERIFIED"}**.`,
      "",
      "| Metric | Existing gateway | Candidate gateway |",
      "| --- | ---: | ---: |",
      ...[
        ["Requests", "requests"],
        ["Correct answers", "correct"],
        ["Empty answers", "emptyAnswers"],
        ["Provider tool-request responses", "toolRequestResponses"],
        ["Proxy-reported input tokens", "reportedInputTokens"],
        ["Cache-read tokens", "cacheReadTokens"],
        ["Cache-write tokens", "cacheWriteTokens"],
        ["Uncached input tokens", "uncachedInputTokens"],
        ["Output tokens", "outputTokens"],
        ["Median first-request time to first text (ms)", "medianColdTtftMs"],
        ["Median repeated-request time to first text (ms)", "medianWarmTtftMs"],
        ["Median repeated-request total duration (ms)", "medianWarmDurationMs"],
        [
          "Median correct repeated-request total duration (ms)",
          "medianCorrectWarmDurationMs",
        ],
        ["p95 total duration (ms)", "p95DurationMs"],
        [
          `Estimated cost (${rates?.currency ?? "rates unavailable"})`,
          "estimatedCost",
        ],
      ].map(
        ([title, key]) => `| ${title} | ${cell(a[key])} | ${cell(b[key])} |`,
      ),
      "",
      ...(report.error ? [`Execution error: ${report.error}`, ""] : []),
      "## Interpretation",
      "",
      "Answer correctness and empty-response counts must be considered before attributing lower durations or output tokens to an improvement.",
      "",
      a.cacheUsageReported && b.cacheUsageReported
        ? b.cacheReadTokens > a.cacheReadTokens
          ? "The provider reported more reused input tokens with the candidate."
          : "The provider did not report an increase in reused input tokens with the candidate."
        : "Cache usage was not fully reported; cache savings cannot be established.",
      "",
      rates
        ? "Cost figures use supplied endpoint rates; check against actual provider billing."
        : "Actual monetary savings are unverified because this proxy's billing rates were not supplied.",
      "",
      "## Method and limitations",
      "",
      ...report.limitations.map((s: string) => `- ${s}`),
      "",
      `Raw samples and candidate source digests: [JSON report](${output.split("/").at(-1)}.json).`,
      "",
    ];
    writeFileSync(output + ".md", markdown.join("\n"));
    console.log(
      JSON.stringify({
        report: output + ".md",
        summary: report.summary,
        error: report.error,
      }),
    );
  }
}
void main().catch(() => {
  console.error(
    "Benchmark setup failed; inspect configuration without printing credentials.",
  );
  process.exitCode = 1;
});
