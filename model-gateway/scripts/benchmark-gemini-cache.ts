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
import { createGateway } from "../src/server";
import { toGeminiRequest } from "../src/adapters/gemini";
import type { GatewayProfile } from "../src/adapter";
import { sseData } from "../src/responses";
import { signGatewayToken } from "../../shared/gateway-token";

// Live implicit-cache verification. Profile credentials stay in a private file,
// outside reports; the stored catalog and normal application traffic are untouched.
const root = resolve(__dirname, "../..");
const args = process.argv.slice(2);
function arg(name: string, fallback?: string) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--"))
    throw new Error(`Missing ${name}`);
  return args[i + 1];
}
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(
    sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
  );
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
const questions = [17, 83, 219, 41, 137, 9];
function request(partition: string, question: number) {
  return {
    instructions: `Benchmark partition ${partition}; this identifier has no business meaning. You are an invoice assistant. Use the supplied reference exactly. Return only a JSON object containing id, amount, status and region for the requested invoice. Do not call tools.`,
    reasoning: { effort: "low" },
    tool_choice: "none",
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
        content: [
          {
            type: "input_text",
            text: `Look up ${rows[questions[question]].id}.`,
          },
        ],
      },
    ],
  };
}
function correct(answer: string, question: number) {
  try {
    const value = JSON.parse(
      answer
        .trim()
        .replace(/^```(?:json)?\s*/, "")
        .replace(/\s*```$/, ""),
    );
    const expected = rows[questions[question]];
    return (
      Object.keys(value).length === 4 &&
      ["id", "amount", "status", "region"].every(
        (key) => value[key] === (expected as any)[key],
      )
    );
  } catch {
    return false;
  }
}

async function main() {
  const profilePath = arg("--profile-file");
  if (!profilePath)
    throw new Error("Provide --profile-file with private credentials");
  const supplied = JSON.parse(readFileSync(resolve(profilePath), "utf8"));
  if (
    !["google", "gemini"].includes(supplied.wireApi) ||
    (!supplied.apikey && !supplied.apiKey)
  )
    throw new Error("Google/Gemini profile required");
  if (
    new URL(supplied.baseUrl).origin !==
    "https://generativelanguage.googleapis.com"
  )
    throw new Error("This benchmark requires the direct Google endpoint");
  const profile: GatewayProfile = {
    ...supplied,
    wireApi: "gemini",
    maxOutputTokens: 1024,
  };
  const key = profile.apiKey || profile.apikey!;
  const safe = (value: string) => value.split(key).join("[REDACTED]");
  const baselineRef = arg(
    "--baseline",
    "2417dff195b22f19b3dc5c29a48d6a30d3c02354",
  )!;
  const blocks = Number(arg("--blocks", "2"));
  const requests = Number(arg("--requests", "3"));
  if (
    !Number.isInteger(blocks) ||
    blocks < 1 ||
    blocks > 4 ||
    !Number.isInteger(requests) ||
    requests < 2 ||
    requests > questions.length
  )
    throw new Error("Invalid benchmark size");
  const output = resolve(
    arg(
      "--output",
      join(root, "benchmark-reports", `gemini-cache-${Date.now()}`),
    )!,
  );
  mkdirSync(dirname(output), { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "truex-gemini-baseline-"));
  const servers: ReturnType<typeof createGateway>[] = [];
  const samples: any[] = [];
  const report: any = {
    kind: "real-google-implicit-cache-gateway-ab",
    started: new Date().toISOString(),
    baselineRef,
    candidateHead: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    model: profile.modelName,
    profileId: String(profile._id),
    providerHost: new URL(profile.baseUrl).host,
    suppliedWireApi: supplied.wireApi,
    testedWireApi: "gemini",
    policy:
      "Google implicit caching; identical provider settings in both gateways",
    blocks,
    requestsPerArmPerBlock: requests,
    workload: {
      invoices: rows.length,
      referenceBytes: Buffer.byteLength(document),
      referenceSha256: hash(document),
      maxOutputTokens: 1024,
      reasoningEffort: "low",
    },
    candidateDigests: Object.fromEntries(
      [
        "model-gateway/src/adapters/gemini.ts",
        "model-gateway/src/server.ts",
        "model-gateway/src/responses.ts",
        "model-gateway/scripts/benchmark-gemini-cache.ts",
      ].map((file) => [
        file,
        createHash("sha256")
          .update(readFileSync(join(root, file)))
          .digest("hex"),
      ]),
    ),
    samples,
    limitations: [
      "Synthetic invoice extraction, not a full application agent or tool execution test.",
      "Implicit caching is provider controlled; first requests are first-observed, not guaranteed cold.",
      "Fresh equal-length partitions isolate each arm and block; reference content, tools and questions are identical.",
      "Missing cachedContentTokenCount stays unknown; gateway fallback zero alone is not cache evidence.",
      "No explicit cache objects or storage charges were created; no new Gemini cache controls are implemented by the earlier application changes.",
      "No billing tier or endpoint rates supplied; monetary savings remain unverified.",
      "Small sample; latency differences are descriptive and do not establish causal improvement or all-task quality.",
      "The latest model alias may change; response modelVersion is recorded when supplied.",
    ],
  };
  try {
    const archive = execFileSync(
      "git",
      ["archive", baselineRef, "model-gateway/src", "shared"],
      { cwd: root, maxBuffer: 16 * 1024 * 1024 },
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
      pathToFileURL(join(scratch, "model-gateway/src/adapters/gemini.ts")).href
    );
    const baselineCreate =
      baselineModule.createGateway ?? baselineModule.default?.createGateway;
    const translate =
      baselineAdapter.toGeminiRequest ??
      baselineAdapter.default?.toGeminiRequest;
    if (!baselineCreate || !translate)
      throw new Error("Baseline exports unavailable");
    report.contentEquivalent =
      JSON.stringify(translate(request("parity", 0), profile).body) ===
      JSON.stringify(toGeminiRequest(request("parity", 0), profile).body);
    if (!report.contentEquivalent)
      throw new Error("Upstream request bodies differ");
    const secret = randomBytes(32).toString("hex");
    const endpoints: Record<string, string> = {};
    const captures: Record<string, any[]> = { baseline: [], candidate: [] };
    for (const arm of ["baseline", "candidate"]) {
      const server = (arm === "baseline" ? baselineCreate : createGateway)({
        secret,
        findProfile: async () => profile,
        log: () => {},
        fetch: (async (url: any, init: any) => {
          const capture: any = { requestSha256: hash(JSON.parse(init.body)) };
          captures[arm].push(capture);
          const res = await fetch(url, init);
          capture.status = res.status;
          capture.done = res
            .clone()
            .text()
            .then((raw) => {
              const usage: any = {};
              if (!res.ok) {
                try {
                  const error = JSON.parse(raw).error;
                  capture.error = {
                    code: error?.code,
                    status: error?.status,
                    message: safe(String(error?.message ?? "")),
                  };
                } catch {
                  capture.error = { status: res.status };
                }
                return usage;
              }
              for (const line of raw.split("\n")) {
                if (!line.startsWith("data:")) continue;
                try {
                  const event = JSON.parse(line.slice(5).trim());
                  if (event.modelVersion)
                    capture.modelVersion = event.modelVersion;
                  for (const candidate of event.candidates ?? []) {
                    if (candidate.finishReason)
                      capture.finishReason = candidate.finishReason;
                    if (
                      candidate.content?.parts?.some(
                        (part: any) => part.functionCall,
                      )
                    )
                      capture.toolCall = true;
                  }
                  for (const field of [
                    "promptTokenCount",
                    "cachedContentTokenCount",
                    "candidatesTokenCount",
                    "thoughtsTokenCount",
                    "totalTokenCount",
                    "cacheTokensDetails",
                    "promptTokensDetails",
                    "serviceTier",
                  ])
                    if (event.usageMetadata?.[field] !== undefined)
                      usage[field] = event.usageMetadata[field];
                } catch {
                  /* Ignore non-JSON SSE lines. */
                }
              }
              return usage;
            });
          return res;
        }) as typeof fetch,
      });
      servers.push(server);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      endpoints[arm] =
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/p/${encodeURIComponent(String(profile._id))}/v1/responses`;
    }
    for (let block = 0; block < blocks; block++) {
      const partitions: Record<string, string> = {
        baseline: randomUUID(),
        candidate: randomUUID(),
      };
      for (let question = 0; question < requests; question++) {
        for (const arm of block % 2
          ? ["candidate", "baseline"]
          : ["baseline", "candidate"]) {
          const at = performance.now();
          const index = captures[arm].length;
          const res = await fetch(endpoints[arm], {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${signGatewayToken(String(profile._id), secret, "benchmark")}`,
            },
            body: JSON.stringify(request(partitions[arm], question)),
            signal: AbortSignal.timeout(120000),
          });
          let answer = "",
            outcome = `http_${res.status}`;
          let ttft: number | null = null,
            gatewayUsage: any = null;
          if (res.ok && res.body)
            for await (const data of sseData(res.body)) {
              const event = JSON.parse(data);
              if (event.type === "response.output_text.delta") {
                if (ttft === null && event.delta?.trim())
                  ttft = performance.now() - at;
                answer += event.delta ?? "";
              }
              if (event.type === "response.completed") {
                outcome = "completed";
                gatewayUsage = event.response?.usage;
              }
              if (event.type === "response.failed") outcome = "failed";
            }
          const durationMs = Math.round(performance.now() - at);
          const captured = captures[arm][index];
          const rawUsage = (captured ? await captured.done : null) ?? {};
          const sample = {
            arm,
            block,
            question,
            phase: question ? "repeated" : "first-observed",
            outcome,
            durationMs,
            ttftMs: ttft === null ? null : Math.round(ttft),
            correct: correct(answer, question),
            answer,
            rawUsage,
            gatewayUsage,
            providerModelVersion: captured?.modelVersion ?? null,
            providerStatus: captured?.status ?? null,
            providerFinishReason: captured?.finishReason ?? null,
            toolCall: captured?.toolCall ?? false,
            providerError: captured?.error ?? null,
            requestSha256: captured?.requestSha256 ?? null,
            upstreamCalls: captures[arm].length - index,
          };
          samples.push(sample);
          console.log(
            JSON.stringify({
              arm,
              block,
              question,
              outcome,
              durationMs,
              ttftMs: sample.ttftMs,
              correct: sample.correct,
              rawUsage,
              providerError: sample.providerError,
            }),
          );
          writeFileSync(
            output + ".json",
            JSON.stringify(report, null, 2) + "\n",
          );
          if (outcome !== "completed")
            throw new Error(
              "Provider request failed; stopped without automatic retry",
            );
        }
      }
    }
  } catch (error) {
    report.error = safe(
      error instanceof Error ? error.message : "Benchmark failed",
    );
    process.exitCode = 1;
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
    rmSync(scratch, { recursive: true, force: true });
    report.finished = new Date().toISOString();
    report.summary = Object.fromEntries(
      ["baseline", "candidate"].map((arm) => {
        const s = samples.filter((v) => v.arm === arm);
        const repeated = s.filter((v) => v.phase === "repeated" && v.correct);
        const reported = s.filter(
          (v) => typeof v.rawUsage.cachedContentTokenCount === "number",
        );
        const promptKnown =
          s.length > 0 &&
          s.every((v) => typeof v.rawUsage.promptTokenCount === "number");
        const reads = reported.reduce(
          (n, v) => n + v.rawUsage.cachedContentTokenCount,
          0,
        );
        const prompts = promptKnown
          ? s.reduce((n, v) => n + v.rawUsage.promptTokenCount, 0)
          : null;
        return [
          arm,
          {
            requests: s.length,
            correct: s.filter((v) => v.correct).length,
            failures: s.filter((v) => v.outcome !== "completed").length,
            emptyAnswers: s.filter((v) => !v.answer.trim()).length,
            cacheHitRequests: reported.filter(
              (v) => v.rawUsage.cachedContentTokenCount > 0,
            ).length,
            cacheCounterReportedRequests: reported.length,
            cacheCounterUnknownRequests: s.length - reported.length,
            observedCacheReadTokens: reported.length ? reads : null,
            promptTokens: prompts,
            observedReadFractionLowerBound:
              prompts && reported.length ? reads / prompts : null,
            outputTokensIncludingThoughts:
              s.length &&
              s.every((v) => typeof v.gatewayUsage?.output_tokens === "number")
                ? s.reduce((n, v) => n + v.gatewayUsage.output_tokens, 0)
                : null,
            medianFirstObservedTtftMs: median(
              s
                .filter(
                  (v) =>
                    v.phase === "first-observed" &&
                    v.correct &&
                    v.ttftMs !== null,
                )
                .map((v) => v.ttftMs),
            ),
            medianCorrectRepeatedTtftMs: median(
              repeated.filter((v) => v.ttftMs !== null).map((v) => v.ttftMs),
            ),
            medianCorrectRepeatedDurationMs: median(
              repeated.map((v) => v.durationMs),
            ),
            estimatedCost: null,
          },
        ];
      }),
    );
    const cell = (value: unknown) =>
      value == null ? "Unverified" : String(value);
    const md = [
      "# Google implicit-cache verification",
      "",
      `Model: \`${report.model}\`; host: \`${report.providerHost}\`.`,
      `Baseline: \`${baselineRef}\`; candidate HEAD: \`${report.candidateHead}\`.`,
      `Started: ${report.started}; finished: ${report.finished}.`,
      "",
      `Supplied wire API: \`${report.suppliedWireApi}\`; test uses supported \`gemini\` adapter. Stored profile was not changed.`,
      `Equivalent upstream bodies before isolation partitions: **${report.contentEquivalent ? "PASS" : "UNVERIFIED"}**.`,
      "",
      "| Metric | Original gateway | Current gateway |",
      "| --- | ---: | ---: |",
      ...[
        ["Requests", "requests"],
        ["Correct answers", "correct"],
        ["Failures", "failures"],
        ["Cache-hit requests", "cacheHitRequests"],
        ["Requests with missing cache counters", "cacheCounterUnknownRequests"],
        ["Observed cached input tokens", "observedCacheReadTokens"],
        ["Total prompt tokens (includes cached)", "promptTokens"],
        ["Output tokens including thoughts", "outputTokensIncludingThoughts"],
        ["Median first-observed TTFT (ms)", "medianFirstObservedTtftMs"],
        ["Median correct repeated TTFT (ms)", "medianCorrectRepeatedTtftMs"],
        [
          "Median correct repeated duration (ms)",
          "medianCorrectRepeatedDurationMs",
        ],
      ].map(
        ([label, field]) =>
          `| ${label} | ${cell(report.summary.baseline[field])} | ${cell(report.summary.candidate[field])} |`,
      ),
      "",
      ...(report.error ? [`Execution error: ${report.error}`, ""] : []),
      "Positive provider cache counters verify reuse. This is a comparison with identical implicit-cache settings, not a test of additional Gemini cache controls. Monetary savings remain unverified without the billing tier and applicable rates.",
      "",
      "## Limitations",
      "",
      ...report.limitations.map((v: string) => `- ${v}`),
      "",
      "Sources: [Google caching guide](https://ai.google.dev/gemini-api/docs/caching), [generateContent usage fields](https://ai.google.dev/api/generate-content#UsageMetadata).",
      "",
      `Raw evidence: [JSON](${output.split("/").at(-1)}.json).`,
      "",
    ];
    writeFileSync(output + ".json", JSON.stringify(report, null, 2) + "\n");
    writeFileSync(output + ".md", md.join("\n"));
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
    "Benchmark setup failed; check private profile configuration without printing credentials.",
  );
  process.exitCode = 1;
});
