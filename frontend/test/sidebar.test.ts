import { test } from "node:test";
import assert from "node:assert/strict";
import {
  convoGroup,
  convoTime,
  groupSidebarSessions,
  sidebarWindow,
  SIDEBAR_INITIAL_COUNT,
  SIDEBAR_PAGE_COUNT,
} from "../lib/sidebar.ts";

const sessions = Array.from({ length: 70 }, (_, index) => ({
  _id: `s${index}`,
  title: `Conversation ${index}`,
  createdAt: new Date(2026, 8, 1).toISOString(),
  projectId: index % 2 ? "project-a" : undefined,
}));

test("the Earlier shelf starts at ten rows and expands by twenty-five", () => {
  const initial = sidebarWindow(sessions);
  assert.equal(initial.items.length, 10);
  assert.equal(initial.hiddenCount, 60);
  const next = sidebarWindow(sessions, {
    count: SIDEBAR_INITIAL_COUNT + SIDEBAR_PAGE_COUNT,
  });
  assert.equal(next.items.length, 35);
  assert.equal(next.hiddenCount, 35);
  assert.equal(next.items[34], sessions[34]);
});

test("a deep selected conversation stays reachable without expanding intervening rows", () => {
  const window = sidebarWindow(sessions, { activeId: "s69" });
  assert.equal(window.items.length, 11);
  assert.equal(window.items.at(-1), sessions[69]);
  assert.equal(window.hiddenCount, 59);
  assert.equal(sidebarWindow(sessions, { activeId: "s0" }).items.length, 10);
});

test("a collapsed shelf retains only the selected row and restores its limit on expansion", () => {
  const collapsed = sidebarWindow(sessions, {
    activeId: "s69",
    count: 35,
    expanded: false,
  });
  assert.deepEqual(collapsed.items, [sessions[69]]);
  assert.equal(collapsed.hiddenCount, 69);
  assert.equal(sidebarWindow(sessions, { expanded: false }).items.length, 0);
  assert.equal(
    sidebarWindow(sessions, { count: 35, activeId: "s69" }).items.length,
    36,
  );
});

test("windowing does not mutate or remove Search and project menu data", () => {
  const original = [...sessions];
  sidebarWindow(sessions, { activeId: "missing" });
  assert.deepEqual(sessions, original);
  assert.equal(sessions.length, 70);
  assert.equal(sidebarWindow(sessions).items[1].projectId, "project-a");
});

test("empty lists, a short tail and refreshed missing selections stay valid", () => {
  assert.deepEqual(sidebarWindow([]), { items: [], hiddenCount: 0 });
  const short = sessions.slice(0, 3);
  assert.deepEqual(sidebarWindow(short, { count: 100, activeId: "removed" }), {
    items: short,
    hiddenCount: 0,
  });
  assert.deepEqual(sidebarWindow(short, { count: 0, activeId: "s1" }).items, [
    sessions[1],
  ]);
  assert.equal(sidebarWindow(sessions, { count: NaN }).items.length, 10);
});

test("local date groups preserve source ordering and object references", () => {
  const now = new Date(2026, 8, 7, 12);
  const today = {
    _id: "today",
    createdAt: new Date(2026, 8, 7, 1).toISOString(),
  };
  const earlier = {
    _id: "earlier",
    createdAt: new Date(2026, 8, 6, 23).toISOString(),
  };
  const invalid = { _id: "invalid", createdAt: "invalid" };
  const groups = groupSidebarSessions([earlier, today, invalid], now);
  assert.deepEqual(groups.today, [today]);
  assert.deepEqual(groups.earlier, [earlier, invalid]);
  assert.equal(groups.today[0], today);
  assert.equal(convoGroup(today.createdAt, now), "Today");
  assert.equal(convoGroup(earlier.createdAt, now), "Earlier");
  assert.equal(convoTime("invalid", now), "");
});
