import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import { createSessionBody } from "../lib/projects.ts";

// Execute the real page handlers in an isolated state/API harness. No provider,
// browser credentials, or user service is contacted.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const source = readFileSync(
  process.env.TRUEX_DISPATCH_SOURCE ??
    new URL("../legacy/chat.tsx", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile(
  "page.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const names = new Set([
  "changeApprovalMode",
  "prepareSession",
  "ensureSession",
  "send",
  "askSuggestion",
  "submitInput",
]);
const parts: string[] = [];
let form = "";
function collect(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text))
    parts.push(node.getText(ast));
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(ast) === "composerForm"
  )
    form = node.initializer!.getText(ast);
  ts.forEachChild(node, collect);
}
collect(ast);
function harness(options: Record<string, any> = {}) {
  const calls: string[] = [];
  const payloads: any[] = [];
  const setters = [
    "DraftMode",
    "ModeError",
    "DraftActive",
    "PreparationStatus",
    "Session",
    "SelectedId",
    "Error",
    "Busy",
    "Entries",
    "CommandOpen",
    "Notice",
    "Goal",
    "GoalReview",
    "GoalMode",
    "GoalBudget",
    "DispatchState",
    "ChangingMode",
  ];
  const context: any = {
    text: "A",
    entries: [],
    busy: false,
    running: false,
    preparationFailed: false,
    agentId: "agent-a",
    delegation: {},
    draftProjectId: null,
    preparationKey: "draft-a",
    modeChanging: { current: false },
    changingMode: false,
    sending: { current: false },
    suggesting: { current: false },
    following: { current: false },
    generation: { current: 1 },
    sessionRef: { current: null },
    draftModeRef: { current: "readOnly" },
    composer: { current: { focus() {} } },
    commandAttempt: { current: null },
    goalMode: false,
    goal: null,
    goalBudget: null,
    goalBudgetValid: true,
    commandSuggestions: [],
    commandIndex: 0,
    SLASH_COMMANDS_ENABLED: false,
    history: { replaceState() {} },
    preparation: {
      current: {
        prepare(key: string, create: any) {
          return { key, promise: create() };
        },
        isCurrent() {
          return true;
        },
      },
    },
    createSessionBody,
    projects: { expand() {}, refreshAll() {} },
    refreshSessions: async () => {},
    setText(value: any) {
      context.text = typeof value === "function" ? value(context.text) : value;
    },
    setApprovalMode: async () => {
      calls.push("mode");
      throw new Error("Runtime mode update failed");
    },
    api: async (path: string, payload: unknown) => {
      calls.push(path);
      payloads.push(payload);
      return { _id: "session-a", approvalMode: "ask" };
    },
    transport: {
      send: async (...args: any[]) => {
        calls.push("send");
        payloads.push(args);
        return { turnId: "turn-a" };
      },
    },
    userMessage: (e: Error) => e.message,
    ApiRequestError: class extends Error {},
    reportError: (e: Error) => {
      context.error = e.message;
    },
    crypto: { randomUUID: () => "client-a" },
    setTimeout: (fn: any) => {
      context.timer = fn;
    },
    historyEntries: (entries: unknown[]) => entries,
    syncSessionGoal() {},
    goalCommand: () => ({
      kind: "command",
      method: "thread/goal/set",
      params: { objective: "A" },
    }),
    window: { confirm: () => true },
    require: createRequire(import.meta.url),
    ...options,
  };
  for (const name of setters)
    context[`set${name}`] = (value: any) => {
      const key = name[0].toLowerCase() + name.slice(1);
      context[key] = typeof value === "function" ? value(context[key]) : value;
    };
  // The production helper is loaded if present; baseline handlers do not use it.
  try {
    const helperSource = readFileSync(
      new URL("../lib/composer-submission.ts", import.meta.url),
      "utf8",
    );
    const module = { exports: {} as any };
    vm.runInNewContext(
      ts.transpileModule(helperSource, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText,
      { module, exports: module.exports, require: context.require },
    );
    Object.assign(context, module.exports);
    context.draft = { current: new module.exports.ComposerDraft() };
    context.draft.current.edit(context.text);
    const set = context.setText;
    context.setText = (value: string) => {
      context.draft.current.edit(value);
      set(value);
    };
    context.approvalConfirmation = {
      current: new module.exports.ApprovalConfirmation(),
    };
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    context.messageTextError = context.require(
      "../../shared/message-input.ts",
    ).messageTextError;
  } catch (error: any) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
  }
  vm.createContext(context);
  vm.runInContext(
    ts.transpileModule(parts.join("\n"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
  return { context, calls, payloads };
}

test("first message and retry cannot run after approval confirmation fails", async () => {
  const { context: c, calls } = harness();
  await c.send();
  assert.equal(
    c.sessionRef.current._id,
    "session-a",
    "keep the created session",
  );
  assert.equal(calls.filter((x) => x === "send").length, 0);
  c.setText("retry");
  await c.send();
  assert.equal(calls.filter((x) => x === "send").length, 0);
  assert.equal(calls.filter((x) => x === "/api/sessions").length, 1);
});

test("oversized normal message stays editable and creates no session or row", async () => {
  const { context: c, calls } = harness({ text: "x".repeat(100001) });
  await c.send();
  assert.equal(c.text.length, 100001);
  assert.equal(c.entries.length, 0);
  assert.deepEqual(calls, []);
});

test("editor stays usable during catalog loading and local dispatch, while Send is gated", () => {
  for (const options of [
    { loading: true, agentId: "", session: null, busy: false },
    { loading: false, agentId: "", session: null, busy: false },
    { loading: false, agentId: "agent-a", session: null, busy: true },
  ]) {
    const { context: c } = harness(options);
    Object.assign(c, {
      empty: true,
      openingId: null,
      pendingProject: null,
      picker: null,
      notice: "",
      modeError: "",
      text: "A",
      rotatingPlaceholder: "Ask",
      PLACEHOLDERS: ["Ask"],
      dispatchState: options.busy ? "creating" : null,
    });
    for (const name of [
      "Composer",
      "Icon",
      "PrivacyNote",
      "BudgetField",
      "ApprovalModePicker",
      "SmoothTextarea",
    ])
      c[name] = name;
    for (const name of [
      "startGoal",
      "stopTurn",
      "setComposerFocused",
      "changeDraftProject",
      "selectCommand",
      "setGoalBudgetValid",
      "setCommandIndex",
    ])
      c[name] = () => {};
    c.require = () => ({
      jsx: (type: unknown, props: unknown) => ({ type, props }),
      jsxs: (type: unknown, props: unknown) => ({ type, props }),
      Fragment: "Fragment",
    });
    vm.runInContext(
      ts
        .transpileModule(`const renderedForm = ${form};`, {
          compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
          },
        })
        .outputText.replace(/Object.defineProperty\(exports[^;]+;/, ""),
      c,
    );
    const frame = vm.runInContext("renderedForm.props.children", c);
    assert.equal(frame.props.children.type, "SmoothTextarea");
    assert.ok(!frame.props.children.props.disabled);
    assert.equal(frame.props.canSend, false);
    let keyboardSubmits = 0;
    c.submitInput = () => {
      keyboardSubmits++;
    };
    const keyDown = frame.props.children.props.onKeyDown;
    keyDown({
      key: "Enter",
      keyCode: 229,
      nativeEvent: { isComposing: false },
    });
    keyDown({ key: "Enter", nativeEvent: { isComposing: true } });
    assert.equal(keyboardSubmits, 0, "IME confirmation never submits");
    keyDown({
      key: "Enter",
      shiftKey: true,
      nativeEvent: {},
      preventDefault() {},
    });
    assert.equal(keyboardSubmits, 0, "Shift+Enter retains newline handling");
    keyDown({ key: "Enter", nativeEvent: {}, preventDefault() {} });
    assert.equal(keyboardSubmits, 1);
  }
});

test("successful goal command cannot clear B typed while A awaits creation", async () => {
  const startup = deferred<any>();
  const { context: c } = harness({
    goalMode: true,
    draftModeRef: { current: null },
    api: async (path: string) =>
      path === "/api/sessions"
        ? startup.promise
        : {
            commandMessage: {
              kind: "message",
              id: "client-a",
              command: {
                state: "succeeded",
                method: "thread/goal/set",
                result: {},
              },
            },
          },
  });
  const sent = c.submitInput();
  await Promise.resolve();
  c.setText("B");
  startup.resolve({ _id: "session-a" });
  await sent;
  assert.equal(c.text, "B");
});

test("delayed suggestion never replaces B typed before it starts sending", async () => {
  const { context: c } = harness({
    text: "old draft",
    draftModeRef: { current: null },
  });
  c.askSuggestion("suggestion");
  c.setText("B");
  c.timer();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(c.text, "B");
});

test("double submit creates and dispatches once; B survives slow creation and acceptance", async () => {
  const creation = deferred<any>();
  const acceptance = deferred<any>();
  const { context: c, calls } = harness({ draftModeRef: { current: null } });
  c.api = async () => {
    calls.push("create");
    return creation.promise;
  };
  c.transport.send = async (_id: string, value: string) => {
    calls.push(value);
    return acceptance.promise;
  };
  const sent = c.send();
  assert.equal(c.dispatchState, "creating");
  assert.equal(c.sending.current, true);
  await c.send();
  assert.deepEqual(calls, ["create"]);
  c.setText("B");
  creation.resolve({ _id: "session-a" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(c.dispatchState, "sending");
  assert.deepEqual(calls, ["create", "A"]);
  acceptance.resolve({ turnId: "turn-a" });
  await sent;
  assert.equal(c.text, "B");
  assert.equal(c.dispatchState, null);
  assert.equal(c.sending.current, false);
});

test("definite creation failure restores only the unchanged submitted draft", async () => {
  for (const newer of [false, true]) {
    const creation = deferred<any>();
    const { context: c } = harness({ api: async () => creation.promise });
    const sent = c.send();
    if (newer) c.setText("B");
    creation.reject(new Error("provisioning failed"));
    await sent;
    assert.equal(c.text, newer ? "B" : "A");
    assert.equal(c.entries.length, 0);
    assert.equal(c.preparationStatus.state, "failed");
  }
});

test("uncertain send preserves B and its unknown row without automatic resend", async () => {
  const acceptance = deferred<any>();
  const { context: c, calls } = harness({
    sessionRef: { current: { _id: "session-a" } },
  });
  c.transport.send = async () => {
    calls.push("send");
    return acceptance.promise;
  };
  const sent = c.send();
  await Promise.resolve();
  c.setText("B");
  acceptance.reject(new Error("lost response"));
  await sent;
  assert.equal(c.text, "B");
  assert.equal(c.entries[0].delivery, "unknown");
  assert.deepEqual(calls, ["send"]);
});

test("retry confirms the requested approval mode on the same session before dispatch", async () => {
  const { context: c, calls } = harness();
  await c.send();
  assert.equal(c.text, "A");
  c.setApprovalMode = async (_id: string, mode: string) => {
    calls.push("confirmed");
    return mode;
  };
  await c.send();
  assert.deepEqual(calls, ["/api/sessions", "mode", "confirmed", "send"]);
  assert.equal(c.modeError, "");
});

test("goal creation and existing command retries require confirmed approval mode", async () => {
  const { context: c, calls } = harness({ goalMode: true });
  await c.submitInput();
  assert.equal(c.text, "A");
  assert.equal(c.entries.length, 0);
  assert.deepEqual(calls, ["/api/sessions", "mode"]);
  await c.submitInput();
  assert.deepEqual(calls, ["/api/sessions", "mode", "mode"]);
});

test("a pending approval update gates sends and overlapping mode changes", async () => {
  const update = deferred<string>();
  const { context: c, calls } = harness({
    sessionRef: { current: { _id: "session-a", approvalMode: "ask" } },
    setApprovalMode: async () => update.promise,
  });
  const changing = c.changeApprovalMode("readOnly");
  assert.equal(c.changingMode, true);
  await c.send();
  assert.equal(await c.changeApprovalMode("auto"), false);
  assert.deepEqual(calls, []);
  update.resolve("readOnly");
  await changing;
  assert.equal(c.changingMode, false);
  await c.send();
  assert.deepEqual(calls, ["send"]);
});

test("a mismatched approval confirmation blocks first send", async () => {
  const { context: c, calls } = harness({ setApprovalMode: async () => "ask" });
  await c.send();
  assert.deepEqual(calls, ["/api/sessions"]);
  assert.equal(c.text, "A");
});

test("disabled approval modes make no configuration request; steering is explicit", async () => {
  const { context: c, calls } = harness({
    draftModeRef: { current: null },
    sessionRef: { current: { _id: "session-a" } },
    running: true,
  });
  const acceptance = deferred<any>();
  c.transport.send = async () => {
    calls.push("steer");
    return acceptance.promise;
  };
  const sent = c.send();
  assert.equal(c.dispatchState, "steering");
  await Promise.resolve();
  acceptance.resolve({ turnId: "turn-a", steer: true });
  await sent;
  assert.deepEqual(calls, ["steer"]);
  assert.equal(c.entries[0].steer, true);
});

test("navigation invalidates late creation without sending, attaching or replacing B", async () => {
  const creation = deferred<any>();
  const { context: c, calls } = harness({ api: async () => creation.promise });
  const sent = c.send();
  c.generation.current++;
  c.setText("B");
  creation.resolve({ _id: "old-session" });
  await sent;
  assert.equal(c.sessionRef.current, null);
  assert.deepEqual(calls, []);
  assert.equal(c.text, "B");
});

test("normal input boundaries reject whitespace/non-string and preserve UTF-16 length", async () => {
  for (const value of [
    " \t\n",
    null,
    undefined,
    12,
    "😀".repeat(50000) + "x",
  ]) {
    const { context: c, calls } = harness();
    await c.send(value === undefined ? null : value);
    assert.deepEqual(calls, []);
    assert.equal(c.entries.length, 0);
    assert.equal(c.text, "A");
  }
  for (const value of ["x".repeat(100000), "😀".repeat(50000), " a "]) {
    const { context: c, payloads } = harness({
      draftModeRef: { current: null },
    });
    await c.send(value);
    assert.equal(payloads.at(-1)[1], value);
  }
});

test("suggestion restores previous draft only when no later edit owns the composer", async () => {
  for (const newer of [false, true]) {
    const acceptance = deferred<any>();
    const { context: c } = harness({
      text: "old draft",
      draftModeRef: { current: null },
      transport: { send: async () => acceptance.promise },
    });
    c.askSuggestion("suggestion");
    c.timer();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (newer) c.setText("B");
    acceptance.resolve({ turnId: "turn-a" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(c.text, newer ? "B" : "old draft");
  }
});

test("a newer same-value draft keeps ownership after a goal completes", async () => {
  const completion = deferred<any>();
  const { context: c } = harness({
    goalMode: true,
    sessionRef: { current: { _id: "session-a" } },
    api: async () => completion.promise,
  });
  const sent = c.submitInput();
  await Promise.resolve();
  c.setText("B");
  c.setText("A");
  completion.resolve({
    commandMessage: {
      kind: "message",
      id: "client-a",
      command: { state: "succeeded", method: "thread/goal/set", result: {} },
    },
  });
  await sent;
  assert.equal(c.text, "A");
  assert.equal(c.goalMode, true);
});

test("existing capability command sends frozen A and preserves B on failure", async () => {
  const completion = deferred<any>();
  const { context: c, payloads } = harness({
    SLASH_COMMANDS_ENABLED: true,
    sessionRef: { current: { _id: "session-a" } },
    parseChatInput: () => ({
      kind: "command",
      method: "help",
      params: {},
      success: "",
    }),
    api: async (_path: string, payload: any) => {
      payloads.push(payload);
      return completion.promise;
    },
  });
  const sent = c.submitInput();
  c.setText("B");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(payloads[0].command.text, "A");
  completion.reject(new Error("connection lost"));
  await sent;
  assert.equal(c.text, "B");
  assert.equal(c.entries[0].command.state, "unknown");
});

test("configured creation sends the frozen selected mode and skips a redundant update", async () => {
  const creation = deferred<any>();
  const { context: c, calls, payloads } = harness();
  c.api = async (path: string, body: unknown) => {
    calls.push(path);
    payloads.push(body);
    return creation.promise;
  };
  const sent = c.send();
  assert.equal(payloads[0].approvalMode, "readOnly");
  c.draftModeRef.current = "auto";
  creation.resolve({ _id: "session-a", approvalMode: "readOnly" });
  await sent;
  assert.deepEqual(calls, ["/api/sessions", "send"]);
});

test("older platform response still confirms the selected mode before sending", async () => {
  const {
    context: c,
    calls,
    payloads,
  } = harness({
    setApprovalMode: async () => {
      calls.push("mode-confirmed");
      return "readOnly";
    },
  });
  await c.send();
  assert.equal(payloads[0].approvalMode, "readOnly");
  assert.deepEqual(calls, ["/api/sessions", "mode-confirmed", "send"]);
});
