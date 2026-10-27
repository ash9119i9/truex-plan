import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseFollowUps,
  splitSuggestions,
  stripSuggestions,
} from "../lib/suggestions.ts";

const block =
  "[truex-suggestions]\n- How do I deploy this?\n- Can you add tests?\n[/truex-suggestions]";

interface GoldenCase {
  name: string;
  text: string;
  streaming?: boolean;
  expect: {
    text: string;
    status: string;
    shape: string;
    stage: string;
    items: Array<{ slot: number; intent: string; text: string }>;
  };
}

// The same file as platform-next/test/support/followups-golden.json.
const golden = JSON.parse(
  readFileSync(
    new URL("./support/followups-golden.json", import.meta.url),
    "utf8",
  ),
) as GoldenCase[];

for (const testCase of golden)
  test(`golden: ${testCase.name}`, () => {
    const parsed = parseFollowUps(testCase.text, testCase.streaming === true);
    assert.deepEqual(
      { text: parsed.text, ...parsed.followUps },
      testCase.expect,
    );
  });

test("a trailing block becomes follow-up questions and leaves the answer", () => {
  assert.deepEqual(splitSuggestions(`Here is the fix.\n\n${block}\n`), {
    body: "Here is the fix.",
    suggestions: ["How do I deploy this?", "Can you add tests?"],
  });
});

test("answers without a block are unchanged", () => {
  const text = "Plain answer with [brackets] and - dashes";
  assert.deepEqual(splitSuggestions(text), { body: text, suggestions: [] });
});

test("blocks inside code fences are content, not suggestions", () => {
  const text = "```text\n" + block + "\n```";
  assert.deepEqual(splitSuggestions(text), { body: text, suggestions: [] });
});

test("suggestions are capped, deduplicated and cleaned", () => {
  const text =
    "Done.\n[truex-suggestions]\n- **First?**\n* first?\n1. Second?\n- Third?\n- Fourth?\nnot a list item\n- " +
    "x".repeat(200) +
    "\n[/truex-suggestions]";
  assert.deepEqual(splitSuggestions(text).suggestions, [
    "First?",
    "Second?",
    "Third?",
  ]);
});

test("streaming hides a partial block and offers nothing yet", () => {
  assert.deepEqual(
    splitSuggestions("Answer\n\n[truex-suggestions]\n- How do", true),
    { body: "Answer", suggestions: [] },
  );
  assert.deepEqual(splitSuggestions("Answer\n\n[truex-sugg", true), {
    body: "Answer",
    suggestions: [],
  });
  assert.deepEqual(splitSuggestions(`Answer\n${block}`, true), {
    body: "Answer",
    suggestions: [],
  });
});

test("an unterminated block is hidden and never clickable", () => {
  assert.deepEqual(splitSuggestions("Answer\n[truex-suggestions]\n- Next?"), {
    body: "Answer",
    suggestions: [],
  });
});

test("text after the block is kept", () => {
  assert.equal(stripSuggestions(`Top\n${block}\nBottom`), "Top\n\nBottom");
});

test("no marker or row text appears at any chunk boundary", () => {
  const text =
    "Answer\n\n[truex-suggestions]\nshape: how-to; stage: build\nact: Draft a report\nverify: Check the access\n[/truex-suggestions]";
  for (let end = 0; end <= text.length; end++) {
    const seen = stripSuggestions(text.slice(0, end), true);
    assert.doesNotMatch(seen, /truex-suggestions/);
    assert.doesNotMatch(seen, /shape:/);
    assert.doesNotMatch(seen, /Draft a report/);
    assert.doesNotMatch(seen, /Check the access/);
  }
});
