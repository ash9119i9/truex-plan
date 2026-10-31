import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiRequestError } from "../lib/api.ts";
import {
  goalOffer,
  goalStartFailure,
  objectiveProblem,
} from "../lib/tenant-goal.ts";
import { component } from "./next-details-runtime.ts";

const { GoalDialog } = component("tenant/goal-dialog.tsx");

const PRESETS: [number, number, number] = [100_000, 300_000, 1_000_000];

const dialog = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(GoalDialog, {
      presets: PRESETS,
      objective: "Write the quarterly report",
      onObjective() {},
      budget: 300_000,
      onBudget() {},
      error: "",
      starting: false,
      onStart() {},
      onCancel() {},
      ...props,
    }),
  );

test("the Goal button shows only where a goal can start: goals on, none yet", () => {
  const goals = { maxTokenBudget: 3_000_000 };
  const settings = { presets: PRESETS, maxTokenBudget: 3_000_000 };
  const offer = (over: Record<string, unknown> = {}) =>
    goalOffer({
      chat: { goals, goal: null, readOnly: null },
      settings,
      state: { goal: null, ended: false },
      ...over,
    });
  assert.equal(offer(), true);
  // Goals off in the chat or the workspace.
  assert.equal(
    offer({ chat: { goals: null, goal: null, readOnly: null } }),
    false,
  );
  assert.equal(offer({ settings: null }), false);
  // A chat that cannot continue.
  assert.equal(
    offer({ chat: { goals, goal: null, readOnly: "THREAD_LOST" } }),
    false,
  );
  // Once the chat has had a goal: one per chat, none after clear.
  assert.equal(
    offer({
      chat: {
        goals,
        goal: { status: "paused", review: "none" },
        readOnly: null,
      },
    }),
    false,
  );
  assert.equal(offer({ state: { goal: null, ended: true } }), false);
});

test("an objective is 1-4000 characters, counted as Codex counts them", () => {
  assert.equal(objectiveProblem("Do it"), null);
  assert.match(objectiveProblem("   ") ?? "", /Describe the goal/);
  assert.equal(objectiveProblem("a".repeat(4000)), null);
  assert.match(objectiveProblem("a".repeat(4001)) ?? "", /4,000/);
  // An emoji is one character, not two UTF-16 units.
  assert.equal(objectiveProblem("😀".repeat(4000)), null);
});

test("GOAL_LIMIT and objective errors are shown in the dialog with the text kept", () => {
  const limit = new ApiRequestError(
    "3 goals running. Pause or finish one.",
    409,
    "GOAL_LIMIT",
  );
  assert.equal(
    goalStartFailure(limit),
    "3 goals running. Pause or finish one.",
  );
  const tooLong = new ApiRequestError(
    "objective must be 1-4000 characters.",
    400,
    "INVALID_INPUT",
  );
  assert.equal(
    goalStartFailure(tooLong),
    "objective must be 1-4000 characters.",
  );
  const html = dialog({
    error: "3 goals running. Pause or finish one.",
    objective: "Keep this text",
  });
  assert.match(html, /role="alert"[^>]*>[^<]*3 goals running/);
  assert.match(html, />Keep this text<\/textarea>/);
});

test("the dialog works by keyboard: labelled objective, radio presets, submit and cancel", () => {
  const html = dialog();
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /<label[^>]*for="[^"]+"[^>]*>Objective/);
  assert.match(html, /26 \/ 4,000/);
  assert.match(html, /role="radiogroup" aria-label="Token budget"/);
  const radios = [
    ...html.matchAll(/role="radio" aria-checked="(true|false)"[^>]*>([^<]+)</g),
  ];
  assert.deepEqual(
    radios.map((m) => [m[2], m[1]]),
    [
      ["100K tokens", "false"],
      ["300K tokens", "true"],
      ["1M tokens", "false"],
    ],
  );
  assert.match(html, /<button type="submit"[^>]*>Start goal/);
  assert.match(html, /<button type="button"[^>]*>Cancel/);
  // An objective that can't be sent disables Start and says why.
  const empty = dialog({ objective: "" });
  assert.match(empty, /<button type="submit"[^>]*disabled/);
  // While starting: busy, nothing to retype.
  assert.match(dialog({ starting: true }), /Starting…/);
});
