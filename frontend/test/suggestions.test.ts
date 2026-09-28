import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSuggestions, stripSuggestions } from "../lib/suggestions.ts";

const block =
  "[truex-suggestions]\n- How do I deploy this?\n- Can you add tests?\n[/truex-suggestions]";

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
    body: "Answer\n\n",
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
