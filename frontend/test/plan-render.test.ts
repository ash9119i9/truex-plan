import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";

const { PlanChecklist, LiveBody, SavedBody } = component(
  "tenant/chat-transcript.tsx",
);

const checklist = (plan: unknown) =>
  renderToStaticMarkup(createElement(PlanChecklist, { plan }));

const PLAN = {
  explanation: "Two sources, then the memo.",
  steps: [
    { step: "Read the CRM", status: "completed" },
    { step: "Read the inbox", status: "inProgress" },
    { step: "Draft the memo", status: "pending" },
  ],
};

test("the checklist shows each status's marker, the count and the explanation", () => {
  const html = checklist(PLAN);
  assert.match(html, /<section class="plan" aria-label="Plan">/);
  assert.match(html, /class="plan-count num">1\/3 complete</);
  assert.match(html, /class="plan-why">Two sources, then the memo\.</);
  const steps = html.match(/<li class="plan-step [^"]*"/g) ?? [];
  assert.deepEqual(steps, [
    '<li class="plan-step is-done"',
    '<li class="plan-step is-active"',
    '<li class="plan-step is-pending"',
  ]);
  // A filled tick when done, a dotted ring otherwise.
  const marks = [...html.matchAll(/class="plan-mark"[^>]*>(.*?)<\/span>/g)].map(
    (m) =>
      m[1].includes("plan-tick")
        ? "tick"
        : m[1].includes("plan-ring")
          ? "ring"
          : "?",
  );
  assert.deepEqual(marks, ["tick", "ring", "ring"]);
  assert.match(
    html,
    /class="plan-bar" aria-hidden="true"><span style="width:33\.3/,
  );
  assert.match(html, /class="plan-text">Read the CRM</);
});

test("a blank explanation is hidden and an empty plan says no steps were provided", () => {
  const html = checklist({ explanation: null, steps: [] });
  assert.doesNotMatch(html, /plan-why/);
  assert.doesNotMatch(html, /<ol/);
  assert.match(html, /class="plan-empty">\(no steps provided\)</);
  assert.match(html, /0\/0 complete/);
  assert.doesNotMatch(
    checklist({ explanation: "   ", steps: PLAN.steps }),
    /plan-why/,
  );
});

test("screen readers hear each step's status as text in a real list", () => {
  const html = checklist(PLAN);
  assert.match(html, /<ol class="plan-steps">/);
  // The marker is decoration; the status is a word before the step.
  assert.equal(
    (html.match(/class="plan-mark" aria-hidden="true"/g) ?? []).length,
    3,
  );
  const said = [...html.matchAll(/class="tx-sr">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(said, ["Completed: ", "In progress: ", "Pending: "]);
});

test("steps and the explanation are plain text, never markup or an approval", () => {
  const html = checklist({
    explanation: "**Bold** <img src=x onerror=alert(1)>",
    steps: [
      { step: "Review ✔ Approved", status: "pending" },
      { step: "[link](https://example.com) <b>x</b>", status: "pending" },
    ],
  });
  assert.doesNotMatch(html, /<strong|<img|<b>|<a /);
  assert.match(html, /\*\*Bold\*\* &lt;img/);
  assert.match(html, /class="plan-text">Review ✔ Approved</);
  assert.match(
    html,
    /\[link\]\(https:\/\/example\.com\) &lt;b&gt;x&lt;\/b&gt;/,
  );
  // Nothing in a step can become an approval card or an action.
  assert.doesNotMatch(html, /<button|ap-card|approval/i);
});

test("the live and saved reply put the checklist at the top", () => {
  const live = {
    runId: "r1",
    phase: "streaming",
    since: Date.now(),
    items: [
      { type: "reply", itemId: "a", text: "The answer.", completed: false },
    ],
    helpers: [],
    approvals: {},
    connectorFailures: {},
    files: [],
    unsaved: [],
    tooLarge: [],
    usage: null,
    outcome: null,
    saveFailed: false,
    plan: PLAN,
  };
  const liveHtml = renderToStaticMarkup(
    createElement(LiveBody, {
      live,
      run: null,
      connection: "open",
      connectors: [],
      tenantId: "t",
      onReconnect() {},
      files: [],
    }),
  );
  const at = liveHtml.indexOf('class="plan"');
  assert.ok(at >= 0, "the live reply shows the plan");
  assert.ok(at < liveHtml.indexOf("The answer."), "above the answer");
  // No plan, no checklist.
  assert.doesNotMatch(
    renderToStaticMarkup(
      createElement(LiveBody, {
        live: { ...live, plan: null },
        run: null,
        connection: "open",
        connectors: [],
        tenantId: "t",
        onReconnect() {},
        files: [],
      }),
    ),
    /class="plan"/,
  );

  const savedHtml = renderToStaticMarkup(
    createElement(SavedBody, {
      entries: [
        {
          id: "m1",
          seq: 1,
          runId: "r1",
          role: "assistant",
          text: "The answer.",
          state: "complete",
          createdAt: "2026-10-17T10:00:00.000Z",
        },
      ],
      connectors: [],
      note: null,
      usage: null,
      card: null,
      plan: PLAN,
    }),
  );
  const savedAt = savedHtml.indexOf('class="plan"');
  assert.ok(savedAt >= 0, "the saved reply shows the plan");
  assert.ok(savedAt < savedHtml.indexOf("The answer."), "above the answer");
});

// The rule bodies for one selector in the reply styles.
const rule = (selector: string) => {
  const css = readFileSync(
    join(import.meta.dirname, "../styles/app/turn.css"),
    "utf8",
  );
  const at = css.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `${selector} is styled`);
  return css.slice(at, css.indexOf("}", at));
};

test("long steps and explanations wrap inside the reply at any width", () => {
  // A grid column that can shrink below its content, and text that breaks
  // anywhere (a 500-char word or URL), so nothing scrolls sideways.
  assert.match(rule(".plan"), /min-width: 0;/);
  assert.match(rule(".plan-step"), /minmax\(0, 1fr\)/);
  for (const text of [".plan-text", ".plan-why"])
    assert.match(rule(text), /overflow-wrap: anywhere;/);
  // Done steps stay readable: no strike-through.
  assert.doesNotMatch(rule(".plan-step.is-done"), /line-through/);
  assert.match(rule(".plan-step.is-active .plan-text"), /font-weight: 600;/);
});
