import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { component } from "./next-details-runtime.ts";
import { loginNotice } from "../lib/login.ts";

const react = createRequire(import.meta.url)("react");
const { LoginScreen } = component("auth/login-screen.tsx");

test("effect replay keeps a login error after URL cleanup and prevents an authenticated redirect", async (t) => {
  const descriptors = ["location", "history"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  t.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const redirects: string[] = [];
  const location = {
    search: "?error=google_failed",
    pathname: "/login",
    replace(path: string) {
      redirects.push(path);
    },
  };
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: location,
  });
  Object.defineProperty(globalThis, "history", {
    configurable: true,
    value: {
      replaceState() {
        location.search = "";
      },
    },
  });
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          user: { id: "user", email: "test@example.invalid" },
          tenant: { id: "workspace", name: "Workspace" },
          role: "user",
          auth: "google",
          tenants: [],
        }),
        { status: 200 },
      ),
  );

  const states: unknown[] = [];
  let stateIndex = 0;
  let effect!: () => () => void;
  t.mock.method(react, "useState", (initial: unknown) => {
    const index = stateIndex++;
    states[index] = initial;
    return [
      initial,
      (value: unknown) => {
        states[index] = value;
      },
    ];
  });
  t.mock.method(react, "useRef", (initial: unknown) => ({ current: initial }));
  t.mock.method(react, "useEffect", (callback: typeof effect) => {
    effect = callback;
  });
  LoginScreen();
  // React Strict Mode runs setup, cleanup, setup with the same mounted refs.
  const cleanup = effect();
  assert.equal(location.search, "", "the code is removed from the address");
  cleanup();
  const finalCleanup = effect();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(states[0], loginNotice("google_failed"));
  assert.equal(states[1], true);
  assert.deepEqual(
    redirects,
    [],
    "an error must remain readable even with a session",
  );
  finalCleanup();
});
