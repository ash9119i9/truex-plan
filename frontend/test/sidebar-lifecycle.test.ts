import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Actual Sidebar with a deterministic hook/clock/browser fixture. No user
// storage or network is read. The retained storage contains one boolean only.
function mount({
  now,
  storage = new Map<string, string>(),
  storageAccessDenied = false,
  sessions = [
    { _id: "yesterday", createdAt: new Date(2026, 9, 5, 12).toISOString() },
  ],
}: {
  now: number;
  storage?: Map<string, string>;
  storageAccessDenied?: boolean;
  sessions?: any[];
}) {
  let time = now;
  let hidden = false;
  let hookIndex = 0;
  let changed = false;
  let rendering = false;
  let mounted = true;
  let tree: any;
  let nextTimer = 0;
  const hooks: any[] = [];
  const timers = new Map<number, { at: number; fn: () => void }>();
  const listeners = new Map<string, Set<() => void>>();
  const effects: (() => void)[] = [];
  const eventTarget = {
    addEventListener(name: string, fn: () => void) {
      const set = listeners.get(name) ?? new Set();
      set.add(fn);
      listeners.set(name, set);
    },
    removeEventListener(name: string, fn: () => void) {
      listeners.get(name)?.delete(fn);
    },
  };
  const clock = function (...args: any[]) {
    return Reflect.construct(Date, args.length ? args : [time]);
  } as any;
  clock.now = () => time;
  clock.prototype = Date.prototype;
  const react = {
    memo: (fn: any) => fn,
    useId: () => "shelf-id",
    useState(initial: any) {
      const index = hookIndex++;
      if (!(index in hooks))
        hooks[index] = {
          value: typeof initial === "function" ? initial() : initial,
        };
      return [
        hooks[index].value,
        (next: any) => {
          const value =
            typeof next === "function" ? next(hooks[index].value) : next;
          if (!Object.is(value, hooks[index].value)) {
            hooks[index].value = value;
            changed = true;
          }
        },
      ];
    },
    useMemo(fn: () => any, deps: unknown[]) {
      const index = hookIndex++;
      if (
        !hooks[index] ||
        deps.some((value, i) => !Object.is(value, hooks[index].deps[i]))
      )
        hooks[index] = { value: fn(), deps };
      return hooks[index].value;
    },
    useEffect(fn: () => any, deps: unknown[]) {
      const index = hookIndex++;
      if (
        !hooks[index] ||
        deps.some((value, i) => !Object.is(value, hooks[index].deps[i]))
      ) {
        hooks[index]?.cleanup?.();
        hooks[index] = { deps };
        effects.push(() => {
          hooks[index].cleanup = fn();
        });
      }
    },
  };
  const modules = new Map<string, any>();
  const globals: any = {
    Date: clock,
    document: {
      ...eventTarget,
      get visibilityState() {
        return hidden ? "hidden" : "visible";
      },
    },
    window: {
      ...eventTarget,
      setTimeout(fn: () => void, delay: number) {
        const id = ++nextTimer;
        timers.set(id, { at: time + delay, fn });
        return id;
      },
      clearTimeout(id: number) {
        timers.delete(id);
      },
    },
    localStorage: {
      getItem: (key: string) => {
        if (storageAccessDenied) throw new Error("fixture storage denied");
        return storage.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (storageAccessDenied) throw new Error("fixture storage denied");
        storage.set(key, value);
      },
    },
  };
  function load(path: string) {
    if (modules.has(path)) return modules.get(path);
    const module = { exports: {} as any };
    modules.set(path, module.exports);
    const filename =
      path === "../components/v2/sidebar.tsx" &&
      process.env.TRUEX_SIDEBAR_SOURCE
        ? process.env.TRUEX_SIDEBAR_SOURCE
        : new URL(path, import.meta.url);
    const source = readFileSync(filename, "utf8");
    const require = (name: string) => {
      if (name === "react") return react;
      if (name === "react/jsx-runtime")
        return {
          jsx: (type: any, props: any) => ({ type, props }),
          jsxs: (type: any, props: any) => ({ type, props }),
          Fragment: "Fragment",
        };
      if (name === "./icon") return { Icon: "Icon" };
      if (name === "@/lib/sidebar" || name === "./sidebar")
        return load("../lib/sidebar.ts");
      if (name === "@/lib/use-sidebar-clock")
        return load("../lib/use-sidebar-clock.ts");
      throw new Error(`Unexpected fixture import: ${name}`);
    };
    vm.runInNewContext(
      ts.transpileModule(source, {
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText,
      { ...globals, module, exports: module.exports, require },
    );
    return module.exports;
  }
  const Sidebar = load("../components/v2/sidebar.tsx").Sidebar;
  const props = { sessions, onOpen() {}, onNew() {}, onSearch() {} };
  function render() {
    if (rendering || !mounted) return;
    rendering = true;
    do {
      changed = false;
      hookIndex = 0;
      tree = Sidebar(props);
      while (effects.length) effects.shift()!();
    } while (changed);
    rendering = false;
  }
  render();
  function nodes() {
    const result: any[] = [];
    const visit = (node: any) => {
      if (Array.isArray(node)) node.forEach(visit);
      else if (node && typeof node === "object") {
        result.push(node);
        visit(node.props?.children);
      }
    };
    visit(tree);
    return result;
  }
  return {
    storage,
    timers,
    listeners,
    nodes,
    clickShelf() {
      nodes()
        .find((node) => node.props?.className === "side-shelf-toggle eyebrow")
        .props.onClick();
      render();
    },
    expanded() {
      return nodes().find(
        (node) => node.props?.className === "side-shelf-toggle eyebrow",
      )?.props["aria-expanded"];
    },
    group(name: string) {
      return nodes().find(
        (node) =>
          node.type === "section" && node.props?.["aria-label"] === name,
      );
    },
    setHidden(value: boolean) {
      hidden = value;
      for (const fn of listeners.get("visibilitychange") ?? []) fn();
      if (changed) render();
    },
    focus() {
      for (const fn of listeners.get("focus") ?? []) fn();
      if (changed) render();
    },
    advanceTo(next: number) {
      time = next;
      for (const [id, timer] of [...timers])
        if (timer.at <= time) {
          timers.delete(id);
          timer.fn();
        }
      if (changed) render();
    },
    unmount() {
      mounted = false;
      hooks.forEach((hook) => hook.cleanup?.());
    },
  };
}

test("unchanged memoized sidebar moves Today to Earlier at local midnight", () => {
  const fixture = mount({ now: new Date(2026, 9, 5, 23, 59, 59).getTime() });
  assert.ok(fixture.group("Today"));
  fixture.advanceTo(new Date(2026, 9, 6, 0, 0, 1).getTime());
  assert.equal(fixture.group("Today"), undefined);
  assert.ok(fixture.group("Earlier"));
  fixture.unmount();
});

test("collapsed shelf preference survives an actual sidebar remount", () => {
  const now = new Date(2026, 9, 7, 12).getTime();
  const first = mount({ now });
  assert.equal(first.expanded(), true);
  first.clickShelf();
  assert.equal(first.expanded(), false);
  first.unmount();
  const reopened = mount({ now, storage: first.storage });
  assert.equal(reopened.expanded(), false);
  reopened.unmount();
});

test("hidden sidebar clock wakes only on visibility/focus and cleans up", () => {
  const fixture = mount({ now: new Date(2026, 9, 5, 23, 59, 59).getTime() });
  fixture.setHidden(true);
  assert.equal(fixture.timers.size, 0);
  fixture.advanceTo(new Date(2026, 9, 7, 12).getTime());
  fixture.setHidden(false);
  assert.equal(fixture.group("Today"), undefined);
  assert.ok(fixture.group("Earlier"));
  assert.equal(fixture.timers.size, 1);
  fixture.focus();
  assert.equal(fixture.timers.size, 1, "focus cannot accumulate timers");
  fixture.unmount();
  assert.equal(fixture.timers.size, 0);
  assert.ok([...fixture.listeners.values()].every((set) => set.size === 0));
});

test("midnight scheduling follows 23 and 25 hour local DST days", (t) => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  t.after(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });
  for (const [date, hours] of [
    ["2026-03-08T00:00:00-05:00", 23],
    ["2026-11-01T00:00:00-04:00", 25],
  ] as const) {
    const now = new Date(date).getTime();
    const fixture = mount({ now, sessions: [] });
    assert.equal(
      [...fixture.timers.values()][0].at - now,
      hours * 3600000 + 50,
    );
    fixture.unmount();
  }
});

test("invalid stored preference keeps the default; remount stores only a boolean", () => {
  const storage = new Map([["truex-sidebar-earlier-expanded", "{bad-json}"]]);
  const fixture = mount({ now: new Date(2026, 9, 7, 12).getTime(), storage });
  assert.equal(fixture.expanded(), true);
  fixture.clickShelf();
  assert.deepEqual([...storage.values()], ["false"]);
  fixture.unmount();
});

test("denied preference storage leaves the mounted shelf usable", () => {
  const fixture = mount({
    now: new Date(2026, 9, 7, 12).getTime(),
    storageAccessDenied: true,
  });
  assert.equal(fixture.expanded(), true);
  fixture.clickShelf();
  assert.equal(fixture.expanded(), false);
  fixture.clickShelf();
  assert.equal(fixture.expanded(), true);
  assert.equal(fixture.storage.size, 0);
  fixture.unmount();
});

test("focus resynchronizes local calendar grouping after a time-zone change", (t) => {
  const previous = process.env.TZ;
  process.env.TZ = "UTC";
  t.after(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });
  const fixture = mount({
    now: new Date("2026-10-05T08:00:00Z").getTime(),
    sessions: [{ _id: "morning", createdAt: "2026-10-05T01:00:00Z" }],
  });
  assert.ok(fixture.group("Today"));
  process.env.TZ = "America/Los_Angeles";
  fixture.focus();
  assert.equal(fixture.group("Today"), undefined);
  assert.ok(fixture.group("Earlier"));
  fixture.unmount();
});
