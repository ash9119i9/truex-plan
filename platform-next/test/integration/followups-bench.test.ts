import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evalSummary,
  probeSummary,
  runBench,
  type BenchConfig,
} from "../../bench/followups-harness";
import { PROBE_PROMPTS } from "../../bench/followups-prompts";
import { FakeGateway, GATEWAY_SECRET } from "../support/chat-stack";

const MODEL_ID = "6ad28658942bdeb193bbd80f";
const TENANT_ID = "6ad25557bd7f03d236240be6";
describe("Follow Up bench harness", () => {
  const gateway = new FakeGateway();
  let directory: string;

  before(async () => {
    await gateway.start();
    directory = await mkdtemp(join(tmpdir(), "followups-bench-"));
  });

  after(async () => {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  });

  const config = (name: string): BenchConfig => ({
    gatewayUrl: gateway.url,
    gatewaySecret: GATEWAY_SECRET,
    tenantId: TENANT_ID,
    models: [MODEL_ID],
    timeoutMs: 10_000,
    out: join(directory, name),
  });

  test("records a compliant reply and a deliberate none, then writes the file", async () => {
    gateway.script.push(
      {
        kind: "reply",
        text: "Answer.\n\n[truex-suggestions]\nshape: how-to; stage: build\nact: Draft a report\nverify: Check the access\n[/truex-suggestions]",
        chunk: 7,
      },
      {
        kind: "reply",
        text: "Hi! How can I help?\n\n[truex-suggestions]\nshape: chat; stage: none\n[/truex-suggestions]",
      },
    );
    const prompts = [
      PROBE_PROMPTS.find((p) => p.id === "howto-po-bapi")!,
      PROBE_PROMPTS.find((p) => p.id === "greeting")!,
    ];
    const result = await runBench(config("probe.json"), prompts, "probe");
    assert.equal(result.results[MODEL_ID]?.length, 2);
    assert.equal(result.results[MODEL_ID]![0]!.followUps.status, "ok");
    assert.equal(
      result.results[MODEL_ID]![0]!.followUps.items[0]?.text,
      "Draft a report",
    );
    assert.equal(result.results[MODEL_ID]![1]!.followUps.status, "none");
    const summary = probeSummary(result) as Record<
      string,
      {
        keep: boolean;
        compliantShare: number;
        counts: { ok: number; none: number };
      }
    >;
    assert.equal(summary[MODEL_ID]!.keep, true);
    assert.equal(summary[MODEL_ID]!.compliantShare, 1);
    assert.deepEqual(summary[MODEL_ID]!.counts.ok, 1);
    assert.deepEqual(summary[MODEL_ID]!.counts.none, 1);
    const saved = JSON.parse(
      await readFile(join(directory, "probe.json"), "utf8"),
    ) as { modelIds: string[]; promptVersion: string };
    assert.deepEqual(saved.modelIds, [MODEL_ID]);
    assert.equal(saved.promptVersion, "v5");
  });

  test("an eval scores the format, anchor, intents and slot-1 rule", async () => {
    gateway.script.push({
      kind: "reply",
      text: `A BAPI stages the purchase order until the commit runs.\n\n[truex-suggestions]\nshape: how-to; stage: build\nact: Draft an ABAP report that calls the BAPI\nverify: Check the BAPI authorisation objects\ndeepen: Explain the purchase order return table\n[/truex-suggestions]`,
    });
    const result = await runBench(
      config("eval.json"),
      [PROBE_PROMPTS.find((p) => p.id === "howto-po-bapi")!],
      "eval",
    );
    const summary = evalSummary(result) as Record<
      string,
      {
        exclude: boolean;
        counts: { ok: number };
        rules: Record<
          string,
          { passed: number; measured: number; rate: number }
        >;
      }
    >;
    assert.equal(summary[MODEL_ID]!.counts.ok, 1);
    assert.equal(summary[MODEL_ID]!.exclude, false);
    assert.equal(summary[MODEL_ID]!.rules.format?.rate, 1);
    assert.equal(summary[MODEL_ID]!.rules.distinctIntents?.rate, 1);
    assert.equal(summary[MODEL_ID]!.rules.slotOneForward?.rate, 1);
    assert.equal(summary[MODEL_ID]!.rules.noYesNo?.rate, 1);
  });
});
