import assert from "node:assert/strict";
import test from "node:test";
import { nativeScheduleSpec } from "../src/automation/temporal";

test("interval cadence preserves its saved anchor and ignores display timezone", () => {
  const anchorAt = "2026-10-09T08:07:12.000Z";
  const everyMs = 300_000;
  const spec = nativeScheduleSpec({
    kind: "interval",
    everyMs,
    anchorAt,
    timeZone: "Asia/Kolkata",
  });
  assert.equal(spec.startAt?.toISOString(), anchorAt);
  assert.deepEqual(spec.intervals, [
    { every: everyMs, offset: new Date(anchorAt).getTime() % everyMs },
  ]);
});

test("calendar maps local weekdays and time directly to native Temporal calendars", () => {
  assert.deepEqual(
    nativeScheduleSpec({
      kind: "calendar",
      weekdays: [0, 1, 6],
      localTime: "02:30",
      timeZone: "America/New_York",
    }),
    {
      calendars: [
        {
          second: 0,
          minute: 30,
          hour: 2,
          dayOfWeek: ["SUNDAY", "MONDAY", "SATURDAY"],
        },
      ],
      timezone: "America/New_York",
    },
  );
});

test("Temporal rejects restricted workflow payloads before calling the server", async () => {
  const { AutomationTemporalClient } =
    await import("../src/automation/temporal");
  const client = new AutomationTemporalClient({} as never, "isolated-test");
  await assert.rejects(
    client.start(
      {
        tenantId: "tenant",
        automationId: "automation",
        revision: 1,
        trigger: "manual",
        prompt: "restricted recipe",
      } as never,
      "workflow",
    ),
    /restricted fields/,
  );
});
