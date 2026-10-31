import { createHmac, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { loadConfig } from "../../src/config";
import { threadStartParams } from "../../src/codex/config";
import {
  CodexProcess,
  type Notification,
  type ServerRequest,
} from "../../src/codex/rpc";
import { sleep } from "../support/model-fixture";
import { TOKEN } from "../support/harness";

// The clarifying-question card on a REAL model through the real model gateway.
// Skipped unless REAL_GATEWAY_URL, REAL_GATEWAY_SECRET, REAL_MODEL_ID and
// REAL_MODEL_NAME are set. No adapter code uses request_user_input: the tool
// and a draft of its guidance are switched on here only, through thread
// config. Whether the model asks is its choice, so what it did is reported,
// not asserted. When it asks, the recommended (first) option is answered.

const GATEWAY = process.env.REAL_GATEWAY_URL ?? "";
const SECRET = process.env.REAL_GATEWAY_SECRET ?? "";
const MODEL_ID = process.env.REAL_MODEL_ID ?? "";
const MODEL_NAME = process.env.REAL_MODEL_NAME ?? "";
const TENANT = process.env.REAL_TENANT ?? "6ad25557bd7f03d236240be6";
const enabled = Boolean(GATEWAY && SECRET && MODEL_ID && MODEL_NAME);
const TIMEOUT = 420_000;
const USER_INPUT = "item/tool/requestUserInput";

// Same format as platform-next's signGatewayToken.
function gatewayToken(): string {
  const payload = Buffer.from(
    JSON.stringify({ p: MODEL_ID, t: TENANT }),
  ).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

const AGENT_PROMPT =
  "You are a business assistant for an operations and finance team. Answer from what you know; you have no web access and no company data.";

// Draft guidance under test (not in the adapter).
const ASK_INSTRUCTIONS =
  "You have a request_user_input tool that shows the member a card with one to three short questions, each with 2 or 3 choices. Before you answer, decide whether the request is clear enough. Call request_user_input first, before update_plan and before any reply text, only when a missing detail would change your answer a lot and no sensible default exists: for example who the result is for, which of several things they mean, or a key number such as budget, team size or date range. Ask at most once per request, put the recommended choice first, and never ask about something the request already says. If the request is clear, or a reasonable assumption works, answer directly and state the assumption in one line. Never type clarifying questions in your reply; use the tool instead. The member's answers come back as the tool result; then continue as usual.";

const UNCLEAR = [
  "Make me a workout plan.",
  "Draft an email to the vendor about the invoice.",
  "Which accounting software should we buy?",
  "Create an approval policy for invoices.",
  "Write a summary report of our spending.",
];

const CLEAR = [
  "What is a three-way match in accounts payable?",
  "Rewrite this more politely: send me the report now.",
  "Draft a two-line email to Acme Ltd asking them to resend invoice INV-2041 as a PDF by Friday.",
  "Compare HubSpot, Salesforce and Zoho for a 50-person sales team on price per user and setup time, then recommend one.",
];

type Question = {
  id: string;
  header?: string;
  question: string;
  options?: Array<{ label: string }>;
};

describe("clarifying questions on a real model", { skip: !enabled }, () => {
  let root = "";
  let workspace = "";
  let codex: CodexProcess;
  const notes: Notification[] = [];
  const asked: ServerRequest[] = [];
  const findings: string[] = [];

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "runtime-adapter-user-input-real-"));
    workspace = join(root, "workspace");
    await mkdir(workspace);
    const { codexBinary } = loadConfig({
      RUNTIME_ADAPTER_TOKEN: TOKEN,
      RUNTIME_STATE_DIR: root,
      ...(process.env.RUNTIME_CODEX_BINARY
        ? { RUNTIME_CODEX_BINARY: process.env.RUNTIME_CODEX_BINARY }
        : {}),
    });
    codex = new CodexProcess({
      binary: codexBinary,
      home: root,
      workspace,
      rpcMs: 30_000,
    });
    codex.setListener((n) => notes.push(n));
    codex.setRequestHandler((r) => {
      if (r.method !== USER_INPUT) return false;
      asked.push(r);
      return true;
    });
    await codex.initialize();
  });

  after(async () => {
    console.log(
      `\nUSER INPUT FINDINGS (${MODEL_NAME})\n${findings.join("\n\n")}\n`,
    );
    await codex.stop();
    await rm(root, { recursive: true, force: true });
  });

  async function until(check: () => boolean, ms: number) {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await sleep(100);
    return check();
  }

  async function run(group: string, text: string) {
    const params = threadStartParams(
      {
        modelName: MODEL_NAME,
        gatewayUrl: `${GATEWAY}/p/${MODEL_ID}/v1`,
        gatewayToken: gatewayToken(),
        contextWindow: 200_000,
        autoCompactTokenLimit: 150_000,
        reasoningEffort: "low",
      },
      AGENT_PROMPT,
      workspace,
      [],
    );
    const started = await codex.request<{ thread: { id: string } }>(
      "thread/start",
      {
        ...params,
        developerInstructions: `${params.developerInstructions}\n\n${ASK_INSTRUCTIONS}`,
        config: {
          ...params.config,
          "tools.experimental_request_user_input": { enabled: true },
          "features.default_mode_request_user_input": true,
        },
      },
    );
    const threadId = started.thread.id;
    const from = notes.length;
    const askedFrom = asked.length;
    const t0 = Date.now();
    const turn = await codex.request<{ turn: { id: string } }>("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
    });
    const turnId = turn.turn.id;
    const mine = () =>
      notes.slice(from).filter((n) => n.params.threadId === threadId);
    const done = () =>
      mine().find(
        (n) =>
          n.method === "turn/completed" &&
          (n.params.turn as { id: string }).id === turnId,
      );

    // Order of what the model did: Q = asked, P = plan, T = reply text.
    const timeline = () => {
      const out: string[] = [];
      for (const n of mine()) {
        const mark =
          n.method === "item/agentMessage/delta"
            ? "T"
            : n.method === "turn/plan/updated"
              ? "P"
              : n.method === "serverRequest/resolved"
                ? "Q✓"
                : null;
        if (mark && out.at(-1) !== mark) out.push(mark);
      }
      return out;
    };

    let question: Question[] = [];
    let answered = "";
    while (!done() && Date.now() - t0 < TIMEOUT - 30_000) {
      const request = asked
        .slice(askedFrom)
        .find((r) => r.params.threadId === threadId);
      if (request && !answered) {
        question = (request.params.questions as Question[]) ?? [];
        const answers = Object.fromEntries(
          question.map((q) => [
            q.id,
            { answers: [q.options?.[0]?.label ?? ""] },
          ]),
        );
        answered = question.map((q) => q.options?.[0]?.label ?? "").join(" / ");
        codex.respond(request.id, { answers });
      }
      await sleep(200);
    }
    if (!done()) {
      await codex
        .request("turn/interrupt", { threadId, turnId })
        .catch(() => undefined);
      await until(() => !!done(), 20_000);
    }
    const reply = mine()
      .filter((n) => n.method === "item/agentMessage/delta")
      .map((n) => String(n.params.delta ?? ""))
      .join("");
    const status = String(
      (done()?.params.turn as { status?: unknown } | undefined)?.status ??
        "no completion",
    );
    // Clarifying questions typed into the reply instead of the card.
    const typedQuestions = (reply.match(/\?(\s|$)/g) ?? []).length;
    findings.push(
      [
        `[${group}] ${text}`,
        `  asked=${question.length ? "yes" : "no"} status=${status} ${((Date.now() - t0) / 1000).toFixed(0)}s replyChars=${reply.length} questionMarksInReply=${typedQuestions}`,
        `  timeline: ${timeline().join(" ") || "(none)"}`,
        ...question.map(
          (q) =>
            `  Q ${q.header ?? ""}: ${q.question} [${(q.options ?? []).map((o) => o.label).join(" | ")}]`,
        ),
        ...(answered ? [`  answered: ${answered}`] : []),
      ].join("\n"),
    );
  }

  for (const [i, text] of UNCLEAR.entries())
    test(`unclear ask ${i + 1}`, { timeout: TIMEOUT }, () =>
      run("unclear", text),
    );

  for (const [i, text] of CLEAR.entries())
    test(`clear ask ${i + 1}`, { timeout: TIMEOUT }, () => run("clear", text));
});
