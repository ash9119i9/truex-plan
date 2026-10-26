import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Settlement } from "../../src/modules/chats/chat-store";
import { withFollowUpRows } from "../../src/modules/chats/run-executor";

const block = (rows: string, shape = "how-to", stage = "build") =>
  `[truex-suggestions]\nshape: ${shape}; stage: ${stage}\n${rows}\n[/truex-suggestions]`;

function settlement(
  status: Settlement["status"],
  texts: Array<string | null>,
): Settlement {
  return {
    status,
    error: null,
    items: texts.map((text, index) =>
      text === null
        ? { type: "input" as const, clientMessageId: `cm-${index}` }
        : {
            type: "reply" as const,
            itemId: `item-${index}`,
            text,
            completed: true,
          },
    ),
    usage: null,
    threadId: null,
    turnId: null,
    threadLost: false,
  };
}

const replyTexts = (outcome: Settlement) =>
  outcome.items.flatMap((item) => (item.type === "reply" ? [item.text] : []));

describe("withFollowUpRows", () => {
  test("strips every reply and stores the final answer's rows", () => {
    const first = `First part.\n\n${block("deepen: Go deeper", "explain", "understand")}`;
    const last = `Final answer.\n\n${block("act: Run it\nverify: Check it")}`;
    const outcome = withFollowUpRows(
      settlement("completed", [first, last]),
      "on",
    );
    assert.deepEqual(replyTexts(outcome), ["First part.", "Final answer."]);
    assert.deepEqual(outcome.followUps, {
      status: "ok",
      shape: "how-to",
      stage: "build",
      items: [
        { slot: 1, intent: "act", text: "Run it" },
        { slot: 2, intent: "verify", text: "Check it" },
      ],
    });
  });

  test("steered runs take rows from the final non-empty answer", () => {
    const outcome = withFollowUpRows(
      settlement("completed", [
        `${block("act: From the first")}`,
        null,
        `Cut short.\n\n${block("verify: From the last", "verify", "test")}`,
        "",
      ]),
      "on",
    );
    assert.equal(outcome.followUps?.items[0]?.text, "From the last");
    assert.equal(outcome.followUps?.shape, "verify");
    assert.deepEqual(replyTexts(outcome), ["", "Cut short.", ""]);
  });

  test("a completed on-chat with no block stores missing", () => {
    const outcome = withFollowUpRows(
      settlement("completed", ["Just an answer."]),
      "on",
    );
    assert.deepEqual(outcome.followUps, {
      status: "missing",
      shape: "unknown",
      stage: "unknown",
      items: [],
    });
  });

  test("holdout, off and older chats are stripped but store nothing", () => {
    const text = `Answer.\n${block("act: Run it")}`;
    for (const assignment of ["holdout", "off", undefined] as const) {
      const outcome = withFollowUpRows(
        settlement("completed", [text]),
        assignment,
      );
      assert.deepEqual(replyTexts(outcome), ["Answer."]);
      assert.equal("followUps" in outcome, false);
    }
  });

  test("stopped and failed runs strip a half block and store nothing", () => {
    for (const status of ["stopped", "failed"] as const) {
      const outcome = withFollowUpRows(
        settlement(status, [
          "Partial answer.\n[truex-suggestions]\nact: Half a row",
        ]),
        "on",
      );
      assert.deepEqual(replyTexts(outcome), ["Partial answer."]);
      assert.equal("followUps" in outcome, false);
    }
  });

  test("a reply that is only a block is not an answer for rows", () => {
    const outcome = withFollowUpRows(
      settlement("completed", [
        `Answer one.\n\n${block("act: Keep this")}`,
        block("act: Not this"),
      ]),
      "on",
    );
    assert.deepEqual(replyTexts(outcome), ["Answer one.", ""]);
    assert.equal(outcome.followUps?.items[0]?.text, "Keep this");
  });
});
