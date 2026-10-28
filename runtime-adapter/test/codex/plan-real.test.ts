import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { Harness, completed, streamedText } from "../support/harness";

// The plan checklist on a REAL model through the real model gateway
// (Checkpoint 1). Skipped unless REAL_GATEWAY_URL, REAL_GATEWAY_SECRET,
// REAL_MODEL_ID and REAL_MODEL_NAME are set. Whether the model plans is its
// choice, so plan counts are reported, not asserted; only the shape of what
// reaches the platform is asserted.

const GATEWAY = process.env.REAL_GATEWAY_URL ?? "";
const SECRET = process.env.REAL_GATEWAY_SECRET ?? "";
const MODEL_ID = process.env.REAL_MODEL_ID ?? "";
const MODEL_NAME = process.env.REAL_MODEL_NAME ?? "";
const TENANT = process.env.REAL_TENANT ?? "6ad25557bd7f03d236240be6";
const enabled = Boolean(GATEWAY && SECRET && MODEL_ID && MODEL_NAME);
const TIMEOUT = 360_000;

// Same format as platform-next's signGatewayToken.
function gatewayToken(): string {
  const payload = Buffer.from(
    JSON.stringify({ p: MODEL_ID, t: TENANT }),
  ).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

const AGENT_PROMPT =
  "You are a business research assistant for an operations team. Answer from what you know; you have no web access.";

const MULTI_PART = [
  "Compare SAP S/4HANA, Oracle NetSuite and Microsoft Dynamics 365 for a 200-person manufacturer: licensing model, implementation time and main risks. Then recommend one.",
  "Draft a one-page month-end close checklist for a small finance team, with sections for reconciliations, accruals and reporting, and a short note on common mistakes.",
  "Research the main causes of late supplier payments, propose three process fixes, and write a short email to the AP team announcing them.",
  "Summarise GDPR, CCPA and Brazil's LGPD in a table (scope, consent, fines), then list what a SaaS company must change to comply with all three.",
];

const SIMPLE = [
  "What does EBITDA stand for?",
  "Rewrite this more politely: send me the report now.",
];

describe("plan checklist on a real model", { skip: !enabled }, () => {
  const h = new Harness({ limits: { stopMs: 15_000 } });
  const findings: string[] = [];

  before(() => h.start());
  after(async () => {
    await h.close();
    console.log(`\nPLAN FINDINGS (${MODEL_NAME})\n${findings.join("\n\n")}\n`);
  });

  async function ask(group: string, text: string) {
    const events = await h.run(
      h.body({
        chatId: `plan_${randomUUID().slice(0, 8)}`,
        agentPrompt: AGENT_PROMPT,
        input: { text, clientMessageId: `msg_${randomUUID()}` },
        model: {
          modelName: MODEL_NAME,
          gatewayUrl: `${GATEWAY}/p/${MODEL_ID}/v1`,
          gatewayToken: gatewayToken(),
          contextWindow: 200_000,
          autoCompactTokenLimit: 150_000,
          reasoningEffort: "low",
        },
      }),
    );
    const done = completed(events);
    const updates = events.filter((e) => e.type === "plan.updated");
    const plan = done.plan as
      | {
          explanation: string | null;
          steps: Array<{ step: string; status: string }>;
        }
      | undefined;
    const reply = streamedText(events);

    // Shape, whatever the model chose.
    if (plan) assert.deepEqual(plan, updates.at(-1)!.data);
    else assert.equal(updates.length, 0);
    for (const u of updates) {
      const steps = u.data.steps as Array<{ step: string; status: string }>;
      assert.ok(steps.length <= 50);
      for (const s of steps) {
        assert.ok(s.step.length > 0 && s.step.length <= 500);
        assert.ok(["pending", "inProgress", "completed"].includes(s.status));
      }
    }

    // Does the reply restate the checklist? Count step texts found in it.
    const repeated = (plan?.steps ?? []).filter((s) =>
      reply.toLowerCase().includes(s.step.toLowerCase()),
    ).length;
    // Order of text and plan updates: T = reply text, P<done>/<total> = plan.
    const timeline: string[] = [];
    for (const e of events) {
      if (e.type === "text.delta") {
        if (timeline.at(-1) !== "T") timeline.push("T");
      } else if (e.type === "plan.updated") {
        const steps = e.data.steps as Array<{ status: string }>;
        const ticked = steps.filter((s) => s.status === "completed").length;
        timeline.push(`P${ticked}/${steps.length}`);
      }
    }
    findings.push(
      [
        `[${group}] ${text.slice(0, 70)}…`,
        `  status=${done.status}${done.error ? ` error=${JSON.stringify(done.error)}` : ""} updates=${updates.length} replyChars=${reply.length}`,
        `  timeline: ${timeline.join(" ") || "(none)"}`,
        ...(plan
          ? [
              `  final: ${plan.steps.map((s) => `${s.status === "completed" ? "✔" : s.status === "inProgress" ? "▸" : "□"} ${s.step}`).join(" | ")}`,
              `  explanation: ${plan.explanation ?? "(none)"}`,
              `  steps repeated verbatim in reply: ${repeated}/${plan.steps.length}`,
            ]
          : ["  (no plan)"]),
      ].join("\n"),
    );
    return { done, updates };
  }

  for (const [i, text] of MULTI_PART.entries())
    test(`multi-part ask ${i + 1}`, { timeout: TIMEOUT }, async () => {
      await ask("multi", text);
    });

  for (const [i, text] of SIMPLE.entries())
    test(`simple ask ${i + 1}`, { timeout: TIMEOUT }, async () => {
      await ask("simple", text);
    });
});
