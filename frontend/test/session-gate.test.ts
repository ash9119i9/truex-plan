import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createRequire } from "node:module";
import { component } from "./next-details-runtime.ts";
import { loginNotice } from "../lib/login.ts";

const react = createRequire(import.meta.url)("react");
const { SessionGate } = component("auth/session-gate.tsx");
const session = component("../lib/session.ts");
const ME = {
  user: { id: "user", email: "test@example.invalid" },
  tenant: { id: "workspace", name: "Workspace" },
  role: "user",
  auth: "google",
  tenants: [],
};
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

// Execute the real gate's effects and event handlers with controlled server
// responses. Hook slots persist across renders, just as they do in a mounted tab.
function mountGate(
  t: TestContext,
  initialStatus: number,
  initialBody?: unknown,
) {
  let reloads = 0;
  let broadcast!: (message: unknown) => void;
  t.mock.method(session, "openTabChannel", (listener: (m: unknown) => void) => {
    broadcast = listener;
    return { post() {}, close() {} };
  });
  const events = new EventTarget();
  const restoreGlobals: (() => void)[] = [];
  const globals = {
    location: {
      search: "",
      pathname: "/",
      reload() {
        reloads++;
      },
      replace() {},
      assign() {},
    },
    document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    BroadcastChannel: undefined,
  };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    restoreGlobals.push(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  let status = initialStatus;
  let body = initialBody;
  let logoutStatus = 204;
  const requests: string[] = [];
  t.mock.method(session, "fetchMe", async () => {
    requests.push("session");
    if (status === 401) return { kind: "signedOut" };
    if (status === 403)
      return { kind: "blocked", message: "Workspace unavailable" };
    if (status !== 200) return { kind: "unavailable", message: "Try again" };
    return { kind: "ok", me: body };
  });
  t.mock.method(session, "signOut", async () => ({
    confirmed: logoutStatus === 204,
  }));
  const states: any[] = [];
  const refs: { current: unknown }[] = [];
  let stateIndex = 0,
    refIndex = 0;
  let effect!: () => () => void;
  let actions: any;
  let privateRenders = 0;
  t.mock.method(react, "useState", (initial: unknown) => {
    const index = stateIndex++;
    if (!(index in states)) states[index] = initial;
    return [
      states[index],
      (next: any) => {
        states[index] = typeof next === "function" ? next(states[index]) : next;
      },
    ];
  });
  t.mock.method(react, "useRef", (initial: unknown) => {
    const index = refIndex++;
    return (refs[index] ??= { current: initial });
  });
  t.mock.method(react, "useCallback", (callback: unknown) => callback);
  t.mock.method(react, "useEffect", (callback: typeof effect) => {
    effect = callback;
  });
  const render = () => {
    stateIndex = refIndex = 0;
    return SessionGate({
      children: (_me: unknown, nextActions: unknown) => {
        privateRenders++;
        actions = nextActions;
        return "Private workspace";
      },
    });
  };
  render();
  const cleanup = effect();
  t.after(() => {
    cleanup();
    restoreGlobals.forEach((restore) => restore());
  });
  return {
    render,
    unmount: cleanup,
    broadcast: (message: unknown) => broadcast(message),
    reloads: () => reloads,
    requests,
    state: () => states[0],
    actions: () => actions,
    privateRenders: () => privateRenders,
    response(nextStatus: number, nextBody?: unknown) {
      status = nextStatus;
      body = nextBody;
    },
    logoutResponse(nextStatus: number) {
      logoutStatus = nextStatus;
    },
    async recheck() {
      events.dispatchEvent(
        Object.assign(new Event("pageshow"), { persisted: true }),
      );
      await settle();
    },
  };
}

test("fresh browsers show sign-in without claiming a session ended, including repeated checks", async (t) => {
  const gate = mountGate(t, 401);
  await settle();
  assert.equal(gate.state().kind, "signedOut");
  assert.equal(gate.render().props.notice, null);
  await gate.recheck();
  assert.equal(gate.render().props.notice, null);
  assert.equal(gate.privateRenders(), 0);
  assert.deepEqual(gate.requests, ["session", "session"]);
});

test("an established session ending still shows its notice after later checks", async (t) => {
  const gate = mountGate(t, 200, ME);
  await settle();
  gate.render();
  assert.equal(gate.state().kind, "ready");
  gate.response(401);
  await gate.recheck();
  assert.deepEqual(gate.render().props.notice, loginNotice("session_ended"));
  await gate.recheck();
  assert.deepEqual(gate.render().props.notice, loginNotice("session_ended"));
  assert.equal(gate.privateRenders(), 1);
});

test("a blocked authenticated account losing its session still gets the notice", async (t) => {
  const gate = mountGate(t, 403, { code: "TENANT_DISABLED" });
  await settle();
  assert.equal(gate.state().kind, "blocked");
  gate.response(401);
  await gate.recheck();
  assert.deepEqual(gate.render().props.notice, loginNotice("session_ended"));
  assert.equal(gate.privateRenders(), 0);
});

for (const confirmed of [true, false]) {
  test(`${confirmed ? "confirmed" : "failed"} sign-out keeps its message and retry action after a session check`, async (t) => {
    const gate = mountGate(t, 200, ME);
    await settle();
    gate.render();
    gate.logoutResponse(confirmed ? 204 : 503);
    gate.actions().signOut();
    await settle();
    const before = gate.render().props;
    assert.deepEqual(
      before.notice,
      loginNotice(confirmed ? "signed_out" : "logout_failed"),
    );
    assert.equal(Boolean(before.action), !confirmed);
    gate.response(401);
    await gate.recheck();
    const after = gate.render().props;
    assert.deepEqual(after.notice, before.notice);
    assert.equal(Boolean(after.action), !confirmed);
  });
}

test("an initial outage followed by an unauthenticated response is a fresh sign-in", async (t) => {
  const gate = mountGate(t, 503);
  await settle();
  assert.equal(gate.state().kind, "unavailable");
  gate.response(401);
  await gate.recheck();
  assert.equal(gate.render().props.notice, null);
  assert.equal(gate.privateRenders(), 0);
});

test("an outage during a session retains the private view and a later expiry shows the notice", async (t) => {
  const gate = mountGate(t, 200, ME);
  await settle();
  gate.render();
  gate.response(503);
  await gate.recheck();
  assert.equal(gate.state().kind, "ready");
  gate.response(401);
  await gate.recheck();
  assert.deepEqual(gate.render().props.notice, loginNotice("session_ended"));
});

test("a late identity check cannot restore a workspace after sign-out", async (t) => {
  const gate = mountGate(t, 200, ME);
  await settle();
  gate.render();
  let resolve!: (result: unknown) => void;
  t.mock.method(
    session,
    "fetchMe",
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const check = gate.recheck();
  gate.actions().signOut();
  await settle();
  resolve({ kind: "ok", me: ME });
  await check;
  assert.equal(gate.state().kind, "signedOut");
});

test("effect cleanup invalidates a pending identity check", async (t) => {
  const gate = mountGate(t, 200, ME);
  await settle();
  gate.render();
  let resolve!: (result: unknown) => void;
  t.mock.method(
    session,
    "fetchMe",
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const pending = gate.recheck();
  gate.unmount();
  resolve({ kind: "blocked", message: "Old response" });
  await pending;
  assert.equal(gate.state().kind, "ready");
});

test("another tab entering a different tenant for the same user does not reload this tab", async (t) => {
  const gate = mountGate(t, 200, ME);
  await settle();
  gate.render();
  gate.broadcast({ type: "login", key: ME.user.id });
  assert.equal(gate.reloads(), 0);
  gate.broadcast({ type: "login", key: "another-person" });
  assert.equal(gate.reloads(), 1);
});

test("another tab's logout clears the private view without reloading a still-live cookie", async (t) => {
  const gate = mountGate(t, 200, ME);
  await settle();
  gate.render();
  gate.broadcast({ type: "logout" });
  assert.equal(gate.state().kind, "signedOut");
  assert.equal(gate.reloads(), 0);
  await gate.recheck();
  assert.equal(gate.state().kind, "signedOut");
});
