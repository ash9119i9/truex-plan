import { test } from "node:test";
import assert from "node:assert/strict";
import { historyGroups, sessionTime } from "../lib/sidebar.ts";

// Wednesday 28 Oct 2026, 15:00 local.
const now = new Date(2026, 9, 28, 15, 0);
const at = (y: number, m: number, d: number, h = 12, min = 0, s = 0) =>
  new Date(y, m, d, h, min, s).toISOString();
const row = (id: string, when: string) => ({ id, when });

test("history groups are Today, Previous, Last 30 days, then months; older ones fold", () => {
  const rows = [
    row("today", at(2026, 9, 28, 9)),
    row("yesterday", at(2026, 9, 27)),
    row("sunday", at(2026, 9, 25)),
    row("week-ago", at(2026, 9, 21)),
    row("oct-1", at(2026, 9, 1)),
    row("sep", at(2026, 8, 30)),
    row("aug", at(2026, 7, 3)),
    row("last-year", at(2025, 11, 30)),
  ];
  const groups = historyGroups(rows, (r) => r.when, now);
  assert.deepEqual(
    groups.map((g) => [g.label, g.rows.map((r) => r.id), g.older]),
    [
      ["Today", ["today"], false],
      ["Previous", ["yesterday", "sunday"], false],
      ["Last 30 days", ["week-ago", "oct-1", "sep"], true],
      ["August", ["aug"], true],
      ["December 2025", ["last-year"], true],
    ],
  );
});

test("groups keep a fixed order even when rows arrive out of order", () => {
  const groups = historyGroups(
    [row("old", at(2026, 5, 2)), row("today", at(2026, 9, 28, 8))],
    (r) => r.when,
    now,
  );
  assert.deepEqual(
    groups.map((g) => g.label),
    ["Today", "June"],
  );
});

test("an unreadable or future time never hides a row", () => {
  const groups = historyGroups(
    [row("bad", "not a date"), row("future", at(2026, 9, 29))],
    (r) => r.when,
    now,
  );
  assert.deepEqual(
    groups.map((g) => [g.label, g.rows.map((r) => r.id)]),
    [
      ["Today", ["future"]],
      ["Earlier", ["bad"]],
    ],
  );
});

test("no rows means no groups", () => {
  assert.deepEqual(
    historyGroups([], (r: { when: string }) => r.when, now),
    [],
  );
});

test("times are relative today, a weekday this week and a date beyond", () => {
  assert.equal(sessionTime(at(2026, 9, 28, 14, 59, 40), now), "now");
  assert.equal(sessionTime(at(2026, 9, 28, 14, 48), now), "12m");
  assert.equal(sessionTime(at(2026, 9, 28, 13, 50), now), "1h");
  assert.equal(sessionTime(at(2026, 9, 28, 0, 5), now), "14h");
  assert.equal(sessionTime(at(2026, 9, 25), now), "Sun");
  assert.equal(sessionTime(at(2026, 9, 18), now), "Oct 18");
  assert.equal(sessionTime(at(2025, 8, 26), now), "Sep 26, 2025");
  // Clock skew: a time slightly ahead of this device is still "now".
  assert.equal(sessionTime(at(2026, 9, 28, 15, 2), now), "now");
  assert.equal(sessionTime("invalid", now), "");
});
