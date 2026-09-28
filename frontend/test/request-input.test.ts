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
  msLeft,
  missingAnswers,
  answerErrorMessage,
  type InputQuestion,
} from "../lib/request-input.ts";
import { ApiRequestError } from "../lib/api.ts";

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
  assert.deepEqual(
    answerPayload([approval], { [approval.id]: session.label }),
    {
      answers: { [approval.id]: { answers: ["Allow for this session"] } },
    },
  );
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

test("expiry counts down in milliseconds and stops at zero", () => {
  const now = Date.parse("2030-01-01T00:00:00.000Z");
  assert.equal(msLeft("2030-01-01T00:04:10.000Z", now), 250_000);
  assert.equal(msLeft("2030-01-01T00:00:30.000Z", now), 30_000);
  assert.equal(msLeft("2029-12-31T23:59:00.000Z", now), 0);
  assert.equal(msLeft("not a date", now), 0);
});

test("multi-question requests step forward and send after the last answer", () => {
  const qs: InputQuestion[] = [
    { id: "focus", question: "Focus?", options: [{ label: "Strength" }] },
    { id: "level", question: "Level?", options: [{ label: "Beginner" }] },
  ];
  assert.equal(afterPick(qs, 0, { focus: "Strength" }), "next");
  assert.equal(
    afterPick(qs, 1, { focus: "Strength", level: "Beginner" }),
    "send",
  );
  assert.equal(afterPick(qs, 1, { level: "Beginner" }), "wait");
});

test("the allow-for-this-chat option shows as given and keeps its label", () => {
  const withChat: InputQuestion = {
    ...approval,
    options: [
      { label: "Allow" },
      { label: "Allow for this chat", description: "Until this chat ends" },
      { label: "Cancel" },
    ],
  };
  const chat = withChat.options![1];
  assert.equal(optionLabel(withChat, chat), "Allow for this chat");
  assert.equal(isDecline(withChat, chat), false);
  assert.equal(answersOnClick([withChat]), true);
  assert.deepEqual(
    answerPayload([withChat], { [withChat.id]: chat.label }).answers[
      withChat.id
    ],
    { answers: ["Allow for this chat"] },
  );
});

test("missing answers are listed by question id, in order", () => {
  const qs: InputQuestion[] = [
    { id: "a", question: "A" },
    { id: "b", question: "B" },
    { id: "c", question: "C" },
  ];
  assert.deepEqual(missingAnswers(qs, { b: "x", c: "  " }), ["a", "c"]);
  assert.deepEqual(missingAnswers(qs, { a: "1", b: "2", c: "3" }), []);
});

test("answer errors explain conflicts and withdrawn requests", (t) => {
  t.mock.method(console, "error", () => {});
  assert.equal(
    answerErrorMessage(new ApiRequestError("x", 409, "CONFLICT")),
    "This was already answered.",
  );
  for (const status of [404, 410])
    assert.equal(
      answerErrorMessage(new ApiRequestError("x", status, "GONE")),
      "This request is no longer available.",
    );
  assert.equal(
    answerErrorMessage(new ApiRequestError("Service down", 503, "HTTP_503")),
    "Service down",
  );
  assert.equal(
    answerErrorMessage(new TypeError("boom")),
    "Your answer could not be sent. Please try again.",
  );
});
