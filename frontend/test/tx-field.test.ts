import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";
import type { FieldProps, SwitchProps } from "../components/tx/field.tsx";

const { Field, Input, TextArea, Select, Secret, Switch } =
  component("tx/field.tsx");
const render = (type: unknown, props: Record<string, unknown>) =>
  renderToStaticMarkup(createElement(type as never, props as never));
const attr = (html: string, tag: string, name: string) =>
  html.match(new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`, "i"))?.[1];

test("a field shows its label above the control and links its hint", () => {
  const html = render(Field, {
    label: "Session name",
    required: true,
    hint: "Shown in the session list.",
    children: (control: object) =>
      createElement(Input, { ...control, defaultValue: "Plan" }),
  });
  assert.match(
    html,
    /^<div class="tx-field"><label for="([^"]+)">Session name <span class="tx-req" aria-hidden="true">\*<\/span><\/label><input/,
  );
  const id = attr(html, "label", "for");
  assert.equal(attr(html, "input", "id"), id);
  assert.equal(attr(html, "input", "class"), "tx-input");
  assert.equal(attr(html, "input", "aria-required"), "true");
  const hint = attr(html, "input", "aria-describedby");
  assert.ok(hint);
  assert.match(
    html,
    new RegExp(
      `<span class="tx-hint" id="${hint}">Shown in the session list\\.</span>`,
    ),
  );
  assert.equal(attr(html, "input", "aria-invalid"), undefined);
});

test("an error replaces the hint, names the fix and is announced through aria-describedby", () => {
  const html = render(Field, {
    label: "Jira project key",
    hint: "The short key.",
    error: "Keys are 2–6 uppercase letters, e.g. ONB.",
    children: (control: object) => createElement(Input, control),
  });
  assert.equal(attr(html, "input", "aria-invalid"), "true");
  const described = attr(html, "input", "aria-describedby");
  assert.match(
    html,
    new RegExp(
      `<span class="tx-hint tx-errmsg" id="${described}"><span aria-hidden="true">!</span>Keys are 2–6`,
    ),
  );
  assert.doesNotMatch(html, /The short key\./);
});

test("textarea, select and secret controls carry their classes", () => {
  assert.equal(
    attr(render(TextArea, { id: "a" }), "textarea", "class"),
    "tx-input",
  );
  const select = render(Select, {
    id: "m",
    children: createElement("option", null, "Ask"),
  });
  assert.equal(attr(select, "select", "class"), "tx-input tx-select");

  const secret = render(Secret, {
    id: "tok",
    noun: "token",
    defaultValue: "ya29",
  });
  assert.match(secret, /^<div class="tx-secret"><input/);
  assert.equal(attr(secret, "input", "type"), "password");
  assert.equal(attr(secret, "input", "autocomplete"), "off");
  assert.equal(attr(secret, "button", "aria-pressed"), "false");
  assert.equal(attr(secret, "button", "aria-controls"), "tok");
  assert.equal(attr(secret, "button", "aria-label"), "Show token");
  assert.match(secret, /<span class="t-micro">Show<\/span><\/button>/);
});

test("a switch is a labelled checkbox with role switch and aria-checked", () => {
  const html = render(Switch, {
    label: "Pause on error",
    checked: true,
    onChange() {},
  });
  assert.match(html, /^<label class="tx-row">/);
  assert.equal(attr(html, "input", "type"), "checkbox");
  assert.equal(attr(html, "input", "role"), "switch");
  assert.equal(attr(html, "input", "class"), "tx-switch");
  assert.equal(attr(html, "input", "aria-checked"), "true");
  assert.match(html, /<span>Pause on error<\/span><\/label>$/);
});

// Compiled by `npm run typecheck`: each line must fail to type-check.
// @ts-expect-error a field needs a visible label
export const unlabelledField: FieldProps = { children: () => null };
// @ts-expect-error a switch needs a label
export const unlabelledSwitch: SwitchProps = { checked: false, onChange() {} };
