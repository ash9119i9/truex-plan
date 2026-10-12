import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { component } from "./next-details-runtime.ts";

const { AgentsView } = component("v2/agents-view.tsx");
const { AgentDialog } = component("v2/agent-dialog.tsx");
const react = createRequire(import.meta.url)("react");
const owned = {
  id: "my-helper",
  name: "My Helper",
  handle: "myhelper",
  description: "My helper",
  systemPrompt: "Be brief.",
  modelProfileId: "m2",
  provider: "fixture",
  model: "Model Two",
  sandbox: "read-only",
  look: 4,
  tint: "mint",
  builtin: false,
  canUse: true,
  canWrite: true,
};
const general = {
  ...owned,
  id: "truex_general",
  name: "General Agent",
  handle: "generalagent",
  builtin: true,
  canWrite: false,
};
const models = [
  { id: "m1", name: "Model One", provider: "fixture" },
  { id: "m2", name: "Model Two", provider: "fixture" },
];
const tick = () => new Promise((resolve) => setImmediate(resolve));
function find(node: any, predicate: (node: any) => boolean): any {
  if (!node || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  const children = Array.isArray(node.props?.children)
    ? node.props.children
    : [node.props?.children];
  for (const child of children.flat(Infinity)) {
    const found = find(child, predicate);
    if (found) return found;
  }
}

// Drive the real dialog's hooks and event handlers without a DOM shim.
function dialog(t: TestContext, editing: any = owned) {
  const states: any[] = [],
    refs: any[] = [],
    effects: any[] = [];
  let stateIndex = 0,
    refIndex = 0,
    effectIndex = 0;
  const scheduled: (() => void)[] = [];
  t.mock.method(react, "useState", (initial: any) => {
    const i = stateIndex++;
    if (!(i in states))
      states[i] = typeof initial === "function" ? initial() : initial;
    return [
      states[i],
      (next: any) => {
        states[i] = typeof next === "function" ? next(states[i]) : next;
      },
    ];
  });
  t.mock.method(
    react,
    "useRef",
    (initial: any) => (refs[refIndex++] ??= { current: initial }),
  );
  t.mock.method(react, "useEffect", (effect: () => any, deps: any[]) => {
    const i = effectIndex++,
      old = effects[i];
    if (old && deps.every((v, j) => Object.is(v, old.deps[j]))) return;
    scheduled.push(() => {
      old?.cleanup?.();
      effects[i] = { deps, cleanup: effect() };
    });
  });
  t.after(() => effects.forEach((e) => e?.cleanup?.()));
  const updated: any[] = [],
    created: any[] = [];
  const props = {
    open: true,
    editing,
    agents: [owned, general],
    onClose() {},
    onSayHi() {},
    onUpdated(a: any) {
      updated.push(a);
    },
    onCreated(a: any) {
      created.push(a);
    },
  };
  const render = () => {
    stateIndex = refIndex = effectIndex = 0;
    const tree = AgentDialog(props);
    scheduled.splice(0).forEach((fn) => fn());
    return tree;
  };
  const submit = () =>
    find(render(), (n) => n.type === "form").props.onSubmit({
      preventDefault() {},
    });
  return { props, render, submit, updated, created };
}

test("agent board locks built-ins and other people's agents while keeping their existing cards", () => {
  const html = renderToStaticMarkup(
    createElement(AgentsView, {
      agents: [
        general,
        owned,
        {
          ...owned,
          id: "other",
          name: "Other Helper",
          canWrite: false,
          canUse: false,
        },
      ],
      currentId: "",
      onEdit() {},
      onChat() {},
      onNew() {},
    }),
  );
  assert.match(html, /disabled="" aria-label="General Agent · read-only"/);
  assert.match(html, /class="tb-lock"/);
  assert.match(html, /aria-label="Edit My Helper"/);
  assert.match(html, /disabled="" aria-label="Other Helper · read-only"/);
  assert.equal((html.match(/class="tb-hint"/g) || []).length, 1);
  assert.match(html, /class="tb-btn">Chat<\/button>/);
});

test("editing seeds all fields, preserves the model and handle, and prevents duplicate saves", async (t) => {
  const writes: any[] = [];
  let resolveSave!: (response: Response) => void;
  t.mock.method(
    globalThis,
    "fetch",
    async (path: string, init: RequestInit) => {
      if (path === "/api/models") return Response.json(models);
      writes.push({ path, init });
      return await new Promise<Response>((resolve) => {
        resolveSave = resolve;
      });
    },
  );
  const d = dialog(t);
  d.render();
  await tick();
  let tree = d.render();
  assert.equal(find(tree, (n) => n.type === "input").props.value, owned.name);
  assert.equal(
    find(tree, (n) => n.type === "textarea").props.value,
    owned.systemPrompt,
  );
  assert.equal(find(tree, (n) => n.type === "select").props.value, "m2");
  assert.equal(
    find(tree, (n) => n.props?.id === "nad-title").props.children,
    "Edit agent",
  );
  find(tree, (n) => n.type === "input").props.onChange({
    target: { value: "Renamed Helper" },
  });
  tree = d.render();
  assert.equal(find(tree, (n) => n.props?.handle).props.handle, "myhelper");
  assert.equal(
    find(tree, (n) => n.type === "button" && n.props.type === "submit").props
      .disabled,
    false,
  );
  d.submit();
  d.submit();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/api/agents/my-helper");
  assert.equal(writes[0].init.method, "POST");
  assert.deepEqual(JSON.parse(writes[0].init.body), {
    name: "Renamed Helper",
    description: owned.description,
    systemPrompt: owned.systemPrompt,
    look: owned.look,
    tint: owned.tint,
    modelProfileId: "m2",
  });
  resolveSave(Response.json({ ...owned, name: "Renamed Helper" }));
  await tick();
  assert.equal(d.updated.length, 1);
  assert.equal(d.created.length, 0);
  assert.equal(
    find(d.render(), (n) => n.props?.className === "celebrate-stage"),
    undefined,
  );
});

test("save failures retain edits and allow retry without accepting late responses after closing", async (t) => {
  let attempts = 0,
    resolveSave!: (response: Response) => void;
  t.mock.method(globalThis, "fetch", async (path: string) => {
    if (path === "/api/models") return Response.json(models);
    if (++attempts === 1)
      return Response.json(
        { error: "Try again", code: "TEMPORARY" },
        { status: 503 },
      );
    return await new Promise<Response>((resolve) => {
      resolveSave = resolve;
    });
  });
  const d = dialog(t);
  d.render();
  await tick();
  find(d.render(), (n) => n.type === "textarea").props.onChange({
    target: { value: "My unsaved instructions" },
  });
  d.submit();
  await tick();
  assert.equal(
    find(d.render(), (n) => n.type === "textarea").props.value,
    "My unsaved instructions",
  );
  assert.ok(find(d.render(), (n) => n.props?.role === "alert"));
  d.submit();
  assert.equal(attempts, 2);
  d.props.open = false;
  d.render();
  resolveSave(Response.json(owned));
  await tick();
  assert.equal(d.updated.length, 0);
});

test("unavailable models and built-in details cannot be submitted", async (t) => {
  let writes = 0;
  t.mock.method(globalThis, "fetch", async (path: string) => {
    if (path === "/api/models") return Response.json(models.slice(0, 1));
    writes++;
    return Response.json(owned);
  });
  const d = dialog(t);
  d.render();
  await tick();
  assert.equal(find(d.render(), (n) => n.type === "select").props.value, "m2");
  assert.equal(
    find(d.render(), (n) => n.type === "button" && n.props.type === "submit")
      .props.disabled,
    true,
  );
  d.submit();
  assert.equal(writes, 0);
  find(d.render(), (n) => n.type === "select").props.onChange({
    target: { value: "m1" },
  });
  assert.equal(
    find(d.render(), (n) => n.type === "button" && n.props.type === "submit")
      .props.disabled,
    false,
  );
  d.props.editing = { ...general, modelProfileId: "m1" };
  d.render();
  await tick();
  d.submit();
  assert.equal(writes, 0);
});

test("creation keeps its existing validation and celebration", async (t) => {
  const writes: any[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (path: string, init: RequestInit) => {
      if (path === "/api/models") return Response.json(models);
      writes.push({ path, body: JSON.parse(String(init.body)) });
      return Response.json(owned);
    },
  );
  const d = dialog(t, null);
  d.render();
  await tick();
  find(d.render(), (n) => n.type === "input").props.onChange({
    target: { value: "General Agent" },
  });
  d.submit();
  assert.equal(writes.length, 0);
  find(d.render(), (n) => n.type === "input").props.onChange({
    target: { value: "My Helper" },
  });
  d.submit();
  assert.equal(writes.length, 0);
  find(d.render(), (n) => n.type === "input").props.onChange({
    target: { value: "New Helper" },
  });
  find(
    d.render(),
    (n) =>
      n.type === "input" && n.props.placeholder === "What this specialist owns",
  ).props.onChange({ target: { value: "My purpose" } });
  find(d.render(), (n) => n.type === "textarea").props.onChange({
    target: { value: "My instructions" },
  });
  d.submit();
  await tick();
  assert.equal(writes[0].path, "/api/agents");
  assert.equal(d.created.length, 1);
  assert.equal(d.updated.length, 0);
  assert.ok(find(d.render(), (n) => n.props?.className === "celebrate-stage"));
});
