// Shared plumbing for the Follow Up bench. Talks to the real model gateway
// through the same Responses protocol Codex uses, parses each answer with the
// production parser, and writes a dated JSON file under bench/. The probe
// (Task 1) and the eval (Task 10) differ only in prompts and scoring.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadEnvFileIfPresent } from "../src/config/env-file";
import {
  BASE_INSTRUCTIONS,
  SUGGESTION_RULE,
} from "../src/modules/chats/chat-prompt";
import {
  parseFollowUps,
  type FollowUpSet,
} from "../src/modules/chats/followups";
import { signGatewayToken } from "../src/modules/chats/gateway-token";
import type { BenchPrompt } from "./followups-prompts";

export interface BenchConfig {
  gatewayUrl: string;
  gatewaySecret: string;
  tenantId: string;
  models: string[];
  timeoutMs: number;
  out: string;
}

export interface Usage {
  input: number;
  cached: number;
  output: number;
}

export interface Sample {
  prompt: BenchPrompt;
  // The model's raw answer, including the block, for the manual read.
  raw: string;
  // The answer with the block removed.
  answer: string;
  followUps: FollowUpSet;
  latencyMs: number;
  usage: Usage | null;
  error: string | null;
}

export interface BenchResult {
  kind: "probe" | "eval";
  generatedAt: string;
  promptVersion: "v5";
  gatewayUrl: string;
  modelIds: string[];
  promptCount: number;
  results: Record<string, Sample[]>;
}

function required(value: string | undefined, name: string): string {
  if (!value || value.trim() === "")
    throw new Error(`${name} is required. See docs/FOLLOW_UPS.md.`);
  return value.trim();
}

export function benchConfig(
  argv: readonly string[],
  kind: "probe" | "eval",
): BenchConfig {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        models: { type: "string" },
        out: { type: "string" },
        timeout: { type: "string" },
      },
    });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Bad flags.");
  }
  loadEnvFileIfPresent();
  const models = (parsed.values.models ?? process.env.FOLLOWUPS_MODELS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (models.length === 0)
    throw new Error(
      "Name at least one model: --models <gateway profile id,...> (or FOLLOWUPS_MODELS).",
    );
  const gatewayUrl = required(
    process.env.MODEL_GATEWAY_URL,
    "MODEL_GATEWAY_URL",
  ).replace(/\/+$/, "");
  const gatewaySecret = required(
    process.env.MODEL_GATEWAY_SECRET,
    "MODEL_GATEWAY_SECRET",
  );
  const timeout = parsed.values.timeout;
  const timeoutMs = timeout === undefined ? 180_000 : Number(timeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000)
    throw new Error(
      "--timeout must be a whole number of milliseconds (>= 1000).",
    );
  const date = new Date().toISOString().slice(0, 10);
  return {
    gatewayUrl,
    gatewaySecret,
    tenantId: (process.env.FOLLOWUPS_BENCH_TENANT ?? "").trim(),
    models: [...new Set(models)],
    timeoutMs,
    out: resolve(parsed.values.out ?? `bench/followups-${kind}-${date}.json`),
  };
}

// The production v5 base plus any hostile agent text, then the rule last,
// exactly as chatPrompt orders it.
export function systemFor(prompt: BenchPrompt): string {
  return [
    BASE_INSTRUCTIONS.v5!("2026-10-25", [], []),
    prompt.agentInstructions,
    SUGGESTION_RULE,
  ]
    .filter((part): part is string => !!part)
    .join("\n\n");
}

interface CallResult {
  text: string;
  usage: Usage | null;
  latencyMs: number;
}

interface GatewayEvent {
  type?: string;
  delta?: string;
  item?: {
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  response?: {
    usage?: {
      input_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
      output_tokens?: number;
    };
    error?: { code?: string; message?: string };
  };
}

function itemText(event: GatewayEvent): string {
  if (event.item?.type !== "message") return "";
  return (event.item.content ?? [])
    .map((part) => (part.type === "output_text" ? (part.text ?? "") : ""))
    .join("");
}

export async function ask(
  config: BenchConfig,
  modelId: string,
  prompt: BenchPrompt,
): Promise<CallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const startedAt = performance.now();
  try {
    const res = await fetch(
      `${config.gatewayUrl}/p/${encodeURIComponent(modelId)}/v1/responses`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${signGatewayToken(modelId, config.gatewaySecret, config.tenantId)}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: modelId,
          instructions: systemFor(prompt),
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: prompt.text }],
            },
          ],
          stream: true,
          store: false,
        }),
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      const body = (await res.text()).slice(0, 500);
      throw new Error(`gateway HTTP ${res.status}: ${body}`);
    }
    if (!res.body) throw new Error("gateway returned no stream");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let deltaText = "";
    let doneText = "";
    let usage: Usage | null = null;
    let failure: string | null = null;
    let completed = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let event: GatewayEvent;
          try {
            event = JSON.parse(data) as GatewayEvent;
          } catch {
            continue;
          }
          if (event.type === "response.output_text.delta" && event.delta)
            deltaText += event.delta;
          else if (event.type === "response.output_item.done")
            doneText = itemText(event) || doneText;
          else if (event.type === "response.completed") {
            completed = true;
            const raw = event.response?.usage;
            if (raw)
              usage = {
                input: raw.input_tokens ?? 0,
                cached: raw.input_tokens_details?.cached_tokens ?? 0,
                output: raw.output_tokens ?? 0,
              };
          } else if (
            event.type === "response.failed" ||
            event.type === "error"
          ) {
            failure =
              event.response?.error?.message ??
              event.response?.error?.code ??
              "the model gateway reported a failure";
          }
        }
      }
    }
    if (failure) throw new Error(failure);
    if (!completed)
      throw new Error("the stream ended before response.completed");
    const text = deltaText || doneText;
    if (!text.trim()) throw new Error("the model returned no text");
    return { text, usage, latencyMs: performance.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

export async function runBench(
  config: BenchConfig,
  prompts: readonly BenchPrompt[],
  kind: "probe" | "eval",
): Promise<BenchResult> {
  const result: BenchResult = {
    kind,
    generatedAt: new Date().toISOString(),
    promptVersion: "v5",
    gatewayUrl: config.gatewayUrl,
    modelIds: config.models,
    promptCount: prompts.length,
    results: {},
  };
  const save = () => {
    mkdirSync(dirname(config.out), { recursive: true });
    writeFileSync(config.out, `${JSON.stringify(result, null, 2)}\n`);
  };
  for (const modelId of config.models) {
    const samples: Sample[] = [];
    result.results[modelId] = samples;
    for (const [index, prompt] of prompts.entries()) {
      process.stderr.write(
        `${modelId}: ${index + 1}/${prompts.length} ${prompt.id}\n`,
      );
      try {
        const call = await ask(config, modelId, prompt);
        const parsed = parseFollowUps(call.text);
        samples.push({
          prompt,
          raw: call.text.slice(0, 20_000),
          answer: parsed.text.slice(0, 20_000),
          followUps: parsed.followUps,
          latencyMs: Math.round(call.latencyMs),
          usage: call.usage,
          error: null,
        });
      } catch (error) {
        samples.push({
          prompt,
          raw: "",
          answer: "",
          followUps: {
            status: "missing",
            shape: "unknown",
            stage: "unknown",
            items: [],
          },
          latencyMs: 0,
          usage: null,
          error:
            error instanceof Error ? error.message.slice(0, 500) : "unknown",
        });
      }
    }
    // A long eval can take minutes per model; keep finished models on disk.
    save();
  }
  save();
  return result;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

// Task 1's acceptance: per-model compliance, none on none prompts, missing
// and invalid counts, median output tokens, keep/exclude at 90%.
export function probeSummary(result: BenchResult): unknown {
  return Object.fromEntries(
    Object.entries(result.results).map(([modelId, samples]) => {
      const counts = { ok: 0, none: 0, missing: 0, invalid: 0, error: 0 };
      let compliant = 0;
      let noneExpected = 0;
      let noneCompliant = 0;
      for (const sample of samples) {
        if (sample.error) {
          counts.error++;
          continue;
        }
        counts[sample.followUps.status]++;
        const isNone = sample.prompt.kind === "none";
        if (isNone) {
          noneExpected++;
          if (sample.followUps.status === "none") noneCompliant++;
        }
        if (
          (isNone && sample.followUps.status === "none") ||
          (!isNone && sample.followUps.status === "ok")
        )
          compliant++;
      }
      // Errors are failures: a model that fails half its calls is not keep.
      const share = samples.length > 0 ? compliant / samples.length : 0;
      return [
        modelId,
        {
          keep: share >= 0.9,
          compliantShare: share,
          counts,
          noneCompliant,
          noneExpected,
          medianOutputTokens: median(
            samples.flatMap((sample) =>
              sample.usage ? [sample.usage.output] : [],
            ),
          ),
        },
      ];
    }),
  );
}

// ---- Eval scoring (Task 10) ----

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "then",
  "that",
  "this",
  "is",
  "are",
  "was",
  "were",
  "be",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "from",
  "as",
  "it",
  "its",
  "you",
  "your",
  "we",
  "our",
  "how",
  "what",
  "which",
  "why",
  "when",
  "where",
  "do",
  "does",
  "did",
  "can",
  "could",
  "should",
  "would",
  "will",
  "i",
  "me",
  "my",
  "please",
  "show",
  "tell",
  "give",
  "make",
  "sure",
  "help",
  "want",
  "need",
  "der",
  "die",
  "das",
  "und",
  "oder",
  "ein",
  "eine",
  "einen",
  "ist",
  "sind",
  "war",
  "wie",
  "was",
  "warum",
  "ich",
  "wir",
  "sie",
  "es",
  "zu",
  "von",
  "mit",
  "für",
  "auf",
  "aus",
  "bei",
  "im",
  "den",
  "dem",
  "des",
  "nicht",
  "noch",
  "auch",
  "kann",
  "kannst",
  "soll",
]);

function words(text: string): Set<string> {
  return new Set(
    text
      .normalize("NFKC")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 1 && !STOP.has(word)),
  );
}

const YES_NO_START = new Set([
  "is",
  "are",
  "was",
  "were",
  "am",
  "do",
  "does",
  "did",
  "can",
  "could",
  "should",
  "would",
  "will",
  "shall",
  "may",
  "might",
  "have",
  "has",
  "had",
]);

const GERMAN_MARKERS = new Set([
  "der",
  "die",
  "das",
  "und",
  "oder",
  "ein",
  "eine",
  "einen",
  "ist",
  "sind",
  "wie",
  "was",
  "warum",
  "ich",
  "wir",
  "sie",
  "mit",
  "für",
  "auf",
  "aus",
  "bei",
  "den",
  "dem",
  "des",
  "nicht",
  "auch",
  "kann",
  "kannst",
  "prüfe",
  "prüfen",
  "welche",
  "welcher",
  "lege",
  "anlegen",
  "vergleiche",
  "warum",
]);
const ENGLISH_MARKERS = new Set([
  "the",
  "and",
  "or",
  "is",
  "are",
  "how",
  "what",
  "which",
  "why",
  "when",
  "where",
  "do",
  "does",
  "can",
  "should",
  "would",
  "will",
  "with",
  "for",
  "from",
  "check",
  "compare",
  "explain",
  "show",
  "list",
  "draft",
  "run",
]);

function detectedLanguage(text: string): "en" | "de" | "unknown" {
  let de = /[äöüß]/i.test(text) ? 1 : 0;
  let en = 0;
  for (const word of text.toLowerCase().split(/[^\p{L}]+/u)) {
    if (GERMAN_MARKERS.has(word)) de++;
    if (ENGLISH_MARKERS.has(word)) en++;
  }
  if (de === 0 && en === 0) return "unknown";
  return de >= en ? "de" : "en";
}

function anchored(answer: string, items: FollowUpSet["items"]): boolean {
  const source = words(answer);
  if (source.size === 0) return false;
  return items.every((item) => {
    for (const word of words(item.text)) if (source.has(word)) return true;
    return false;
  });
}

function slotOneForward(
  stage: string,
  items: FollowUpSet["items"],
): boolean | null {
  const first = items[0];
  if (!first) return null;
  if (stage === "operate") return ["deepen", "verify"].includes(first.intent);
  if (
    !["understand", "locate", "design", "build", "test", "transport"].includes(
      stage,
    )
  )
    return null;
  return first.intent === "act";
}

function noYesNo(items: FollowUpSet["items"]): boolean {
  return items.every((item) => {
    const first = item.text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    return !YES_NO_START.has(first.replace(/[^\p{L}]/gu, ""));
  });
}

interface RuleTally {
  passed: number;
  measured: number;
}

function tally(rules: RuleTally, pass: boolean | null) {
  if (pass === null) return;
  rules.measured++;
  if (pass) rules.passed++;
}

export function evalSummary(result: BenchResult): unknown {
  return Object.fromEntries(
    Object.entries(result.results).map(([modelId, samples]) => {
      const format = { passed: 0, measured: 0 };
      const anchor = { passed: 0, measured: 0 };
      const distinct = { passed: 0, measured: 0 };
      const forward = { passed: 0, measured: 0 };
      const language = { passed: 0, measured: 0 };
      const clear = { passed: 0, measured: 0 };
      const counts = { ok: 0, none: 0, missing: 0, invalid: 0, error: 0 };
      for (const sample of samples) {
        if (sample.error) {
          counts.error++;
          tally(format, false);
          continue;
        }
        counts[sample.followUps.status]++;
        const answerPrompt = sample.prompt.kind === "answer";
        tally(
          format,
          answerPrompt
            ? sample.followUps.status === "ok"
            : sample.followUps.status === "none",
        );
        if (!answerPrompt || sample.followUps.status !== "ok") continue;
        const items = sample.followUps.items;
        tally(
          distinct,
          items.length < 2
            ? null
            : new Set(items.map((item) => item.intent)).size >= 2,
        );
        tally(anchor, anchored(sample.answer, items));
        tally(
          forward,
          slotOneForward(
            sample.followUps.stage !== "unknown"
              ? sample.followUps.stage
              : (sample.prompt.stage ?? "unknown"),
            items,
          ),
        );
        const detected = detectedLanguage(
          items.map((item) => item.text).join(" "),
        );
        tally(
          language,
          detected === "unknown" ? null : detected === sample.prompt.language,
        );
        tally(clear, noYesNo(items));
      }
      const scored = (rule: RuleTally) =>
        rule.measured > 0 ? rule.passed / rule.measured : null;
      return [
        modelId,
        {
          exclude: (scored(format) ?? 0) < 0.9,
          counts,
          rules: {
            format: { ...format, rate: scored(format) },
            anchor: { ...anchor, rate: scored(anchor) },
            distinctIntents: { ...distinct, rate: scored(distinct) },
            slotOneForward: { ...forward, rate: scored(forward) },
            languageMatch: { ...language, rate: scored(language) },
            noYesNo: { ...clear, rate: scored(clear) },
          },
        },
      ];
    }),
  );
}
