import { test } from "node:test";
import assert from "node:assert/strict";
import {
  afterPick,
  answerPayload,
  answersOnClick,
  complete,
  isDecline,
  needsText,
  optionLabel,
  timeLeft,
  type InputQuestion,
} from "../lib/request-input.ts";

const approval: InputQuestion = {
  id: "mcp_tool_call_approval_1",
  kind: "toolApproval",
  question: "The assistant wants to use a connected business service.",
  options: [
    { label: "Allow" },
    { label: "Allow for this session" },
    { label: "Cancel" },
  ],
};

test("a single multiple-choice question is answered by one click", () => {
  assert.equal(answersOnClick([approval]), true);
  assert.equal(answersOnClick([approval, approval]), false);
  assert.equal(answersOnClick([{ id: "a", question: "Name?" }]), false);
});

test("tool approvals show friendly labels but keep the Codex value", () => {
  const [allow, session, cancel] = approval.options!;
  assert.equal(optionLabel(approval, allow), "Allow once");
  assert.equal(optionLabel(approval, session), "Allow for this chat");
  assert.equal(isDecline(approval, cancel), true);
  assert.deepEqual(answerPayload([approval], { [approval.id]: session.label }), {
    answers: { [approval.id]: { answers: ["Allow for this session"] } },
  });
  const plain = { id: "q", question: "Pick", options: [{ label: "Allow" }] };
  assert.equal(optionLabel(plain, plain.options[0]), "Allow");
  assert.equal(isDecline(plain, { label: "Cancel" }), false);
});

test("free text appears only without options or when Other is chosen", () => {
  assert.equal(needsText({ id: "a", question: "Name?" }, false), true);
  assert.equal(needsText(approval, true), false);
  const open = { ...approval, kind: undefined, isOther: true };
  assert.equal(needsText(open, false), false);
  assert.equal(needsText(open, true), true);
});

test("answers must be non-blank and are trimmed", () => {
  const qs = [{ id: "a", question: "A" }];
  assert.equal(complete(qs, { a: "  " }), false);
  assert.equal(complete(qs, { a: " x " }), true);
  assert.deepEqual(answerPayload(qs, { a: " x " }), {
    answers: { a: { answers: ["x"] } },
  });
});

test("expiry reads in minutes and disappears once passed", () => {
  const now = Date.parse("2030-01-01T00:00:00.000Z");
  assert.equal(timeLeft("2030-01-01T00:04:10.000Z", now), "Expires in 5 min");
  assert.equal(
    timeLeft("2030-01-01T00:00:30.000Z", now),
    "Expires in under a minute",
  );
  assert.equal(timeLeft("2029-12-31T23:59:00.000Z", now), "");
});

test("multi-question requests step forward and send after the last answer", () => {
  const qs: InputQuestion[] = [
    { id: "focus", question: "Focus?", options: [{ label: "Strength" }] },
    { id: "level", question: "Level?", options: [{ label: "Beginner" }] },
  ];
  assert.equal(afterPick(qs, 0, { focus: "Strength" }), "next");
  assert.equal(afterPick(qs, 1, { focus: "Strength", level: "Beginner" }), "send");
  assert.equal(afterPick(qs, 1, { level: "Beginner" }), "wait");
});
