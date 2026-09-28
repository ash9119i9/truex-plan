import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closingSummary,
  goalDocuments,
  previewText,
  SUMMARY_PREVIEW_CHARS,
} from "../lib/goal-completion.ts";
import type { Entry } from "../lib/chat.ts";

// Codex goal times are Unix seconds.
const created = Date.UTC(2026, 8, 1, 12, 0, 0) / 1000;
const goal = {
  objective: "Quarterly report",
  status: "complete" as const,
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 600,
  createdAt: created,
  updatedAt: created + 600,
};
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const file = (id: string, at: string, extra = {}) => ({
  id,
  name: `${id}.docx`,
  size: 2048,
  createdAt: at,
  mediaType: "application/octet-stream",
  ...extra,
});
const answer = (id: string, text: string, final = true): Entry => ({
  kind: "message",
  id,
  role: "assistant",
  text,
  final,
});

test("closing summary is the last final assistant reply", () => {
  const entries: Entry[] = [
    { kind: "message", id: "u1", role: "user", text: "Go", final: true },
    answer("a1", "First pass"),
    { kind: "item", id: "i1", item: {} },
    answer("a2", "  Report written.  "),
    answer("a3", "Still streaming", false),
  ];
  assert.deepEqual(closingSummary(entries, goal), {
    text: "Report written.",
    preview: "Report written.",
    truncated: false,
  });
});

test("closing summary ignores replies from before the goal was set", () => {
  const entries: Entry[] = [
    answer("old", "Earlier chat"),
    {
      kind: "message",
      id: "cmd",
      role: "user",
      text: "/goal Quarterly report",
      final: true,
      command: {
        method: "thread/goal/set",
        params: {},
        state: "succeeded",
        result: { goal },
      },
    },
  ];
  assert.equal(closingSummary(entries, goal), null);
  assert.equal(
    closingSummary([...entries, answer("new", "Done")], goal)?.text,
    "Done",
  );
});

test("closing summary skips empty replies and handles no entries", () => {
  assert.equal(closingSummary([], goal), null);
  assert.equal(closingSummary([answer("a", "   ")], goal), null);
});

test("long summaries are cut at a word with a flag", () => {
  const text = "word ".repeat(100).trim();
  const summary = closingSummary([answer("a", text)], goal)!;
  assert.equal(summary.truncated, true);
  assert.equal(summary.text, text);
  assert.ok(summary.preview.length <= SUMMARY_PREVIEW_CHARS + 1);
  assert.ok(summary.preview.endsWith("word…"));
  assert.deepEqual(previewText("x".repeat(10), 4), {
    preview: "xxxx…",
    truncated: true,
  });
});

test("goal documents fall between creation and completion", () => {
  const files = [
    file("before", iso(created - 1)),
    file("late", iso(created + 400)),
    file("early", iso(created)),
    file("lastSecond", new Date((created + 600) * 1000 + 500).toISOString()),
    file("after", iso(created + 601)),
    file("visual", iso(created + 10), { kind: "visualization" as const }),
    file("broken", "not a date"),
  ];
  assert.deepEqual(
    goalDocuments(files, goal).map((f) => f.id),
    ["early", "late", "lastSecond"],
  );
});

test("goal documents need creation times", () => {
  const files = [file("a", iso(created + 5))];
  assert.deepEqual(goalDocuments(files, { ...goal, createdAt: null }), []);
  assert.deepEqual(
    goalDocuments([file("b", "")], goal),
    [],
  );
});

test("a goal still running has no end yet", () => {
  const files = [file("a", iso(created + 5000))];
  assert.deepEqual(
    goalDocuments(files, { ...goal, status: "active" }).map((f) => f.id),
    ["a"],
  );
});

test("millisecond goal times are accepted", () => {
  const files = [file("a", iso(created + 5))];
  assert.deepEqual(
    goalDocuments(files, {
      ...goal,
      createdAt: created * 1000,
      updatedAt: (created + 600) * 1000,
    }).map((f) => f.id),
    ["a"],
  );
});
