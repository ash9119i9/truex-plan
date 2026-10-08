import { randomUUID } from "node:crypto";
import {
  Client,
  ScheduleAlreadyRunning,
  ScheduleOverlapPolicy,
  WorkflowExecutionAlreadyStartedError,
  type ScheduleSpec,
  type DayOfWeek,
} from "@temporalio/client";
import Long from "long";
import type { temporal } from "@temporalio/proto";
import { defaultPayloadConverter } from "@temporalio/common";
import type { AutomationTrigger } from "../../../shared/automations";
import type { AutomationOccurrenceInput } from "./workflows";

const WEEKDAYS: DayOfWeek[] = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
];
export function nativeScheduleSpec(trigger: AutomationTrigger): ScheduleSpec {
  if (trigger.kind === "interval") {
    const anchor = new Date(trigger.anchorAt);
    return {
      startAt: anchor,
      intervals: [
        {
          every: trigger.everyMs,
          offset:
            ((anchor.getTime() % trigger.everyMs) + trigger.everyMs) %
            trigger.everyMs,
        },
      ],
    };
  }
  const [hour, minute] = trigger.localTime.split(":").map(Number);
  return {
    calendars: [
      {
        second: 0,
        minute,
        hour,
        dayOfWeek: trigger.weekdays.map((day) => WEEKDAYS[day]),
      },
    ],
    timezone: trigger.timeZone,
  };
}
export interface AutomationScheduleControl {
  tenantId: string;
  automationId: string;
  revision: number;
  controlVersion: number;
  enabled: boolean;
  trigger: AutomationTrigger;
}
const timestamp = (ms: number) => ({
  seconds: Long.fromNumber(Math.floor(ms / 1_000)),
  nanos: (ms % 1_000) * 1_000_000,
});
const range = (start: number, end = start) => ({ start, end, step: 1 });
function wireSpec(trigger: AutomationTrigger) {
  if (trigger.kind === "interval") {
    const anchor = new Date(trigger.anchorAt).getTime();
    return {
      startTime: timestamp(anchor),
      interval: [
        {
          interval: timestamp(trigger.everyMs),
          phase: timestamp(
            ((anchor % trigger.everyMs) + trigger.everyMs) % trigger.everyMs,
          ),
        },
      ],
    };
  }
  const [hour, minute] = trigger.localTime.split(":").map(Number);
  return {
    timezoneName: trigger.timeZone,
    structuredCalendar: [
      {
        second: [range(0)],
        minute: [range(minute)],
        hour: [range(hour)],
        dayOfWeek: trigger.weekdays.map((day) => range(day)),
        dayOfMonth: [range(1, 31)],
        month: [range(1, 12)],
        year: [],
      },
    ],
  };
}
function safeInput(
  control: AutomationScheduleControl,
): AutomationOccurrenceInput {
  return {
    tenantId: control.tenantId,
    automationId: control.automationId,
    revision: control.revision,
    controlVersion: control.controlVersion,
    trigger: "scheduled",
  };
}
const note = (version: number) => `truex-control-version:${version}`;
const controlVersion = (value: string | null | undefined) =>
  Number(/^truex-control-version:(\d+)$/.exec(value ?? "")?.[1] ?? -1);

export class AutomationTemporalClient {
  constructor(
    readonly client: Client,
    readonly taskQueue: string,
  ) {}
  scheduleId(tenantId: string, automationId: string): string {
    return `truex-automation:${encodeURIComponent(tenantId)}:${encodeURIComponent(automationId)}`;
  }
  async start(
    input: AutomationOccurrenceInput,
    workflowId: string,
  ): Promise<void> {
    const allowed = [
      "tenantId",
      "automationId",
      "revision",
      "controlVersion",
      "trigger",
      "requestId",
      "retryOfRunId",
      "scheduledAt",
    ];
    if (Object.keys(input).some((key) => !allowed.includes(key)))
      throw new Error("workflow input contains restricted fields");
    try {
      await this.client.workflow.start("automationOccurrence", {
        taskQueue: this.taskQueue,
        workflowId,
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        args: [input],
        retry: { maximumAttempts: 1 },
        workflowExecutionTimeout: "35 minutes",
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
  }
  async cancel(workflowId: string): Promise<void> {
    await this.client.workflow
      .getHandle(workflowId)
      .signal("cancelAutomationRun");
  }

  async sync(control: AutomationScheduleControl): Promise<{
    appliedVersion: number;
    nextActionTimes: string[];
    missedCatchupWindow: number;
  }> {
    const scheduleId = this.scheduleId(control.tenantId, control.automationId);
    const handle = this.client.schedule.getHandle(scheduleId);
    try {
      await this.client.schedule.create({
        scheduleId,
        spec: nativeScheduleSpec(control.trigger),
        action: {
          type: "startWorkflow",
          workflowType: "automationOccurrence",
          taskQueue: this.taskQueue,
          workflowId: `${scheduleId}:occurrence`,
          args: [safeInput(control)],
          retry: { maximumAttempts: 1 },
          workflowExecutionTimeout: "35 minutes",
        },
        policies: {
          overlap: ScheduleOverlapPolicy.ALLOW_ALL,
          catchupWindow: "10 minutes",
          pauseOnFailure: false,
        },
        state: { paused: !control.enabled, note: note(control.controlVersion) },
      });
    } catch (error) {
      if (!(error instanceof ScheduleAlreadyRunning)) throw error;
    }
    // SDK update omits the server conflict token; use the public service CAS to prevent stale writes.
    for (let attempt = 0; attempt <= 5; attempt++) {
      const description = await handle.describe();
      const appliedVersion = controlVersion(
        description.raw.schedule?.state?.notes,
      );
      if (appliedVersion >= control.controlVersion)
        return {
          appliedVersion,
          nextActionTimes: description.info.nextActionTimes
            .slice(0, 5)
            .map((time) => time.toISOString()),
          missedCatchupWindow: description.info.numActionsMissedCatchupWindow,
        };
      if (attempt === 5) break;
      const raw = description.raw.schedule!;
      try {
        await this.client.workflowService.updateSchedule({
          namespace: this.client.options.namespace,
          scheduleId,
          conflictToken: description.raw.conflictToken,
          requestId: randomUUID(),
          schedule: {
            ...raw,
            spec: wireSpec(control.trigger),
            state: {
              ...raw.state,
              paused: !control.enabled,
              notes: note(control.controlVersion),
            },
            action: {
              ...raw.action,
              startWorkflow: {
                ...raw.action?.startWorkflow,
                input: {
                  payloads: [
                    defaultPayloadConverter.toPayload(safeInput(control))!,
                  ],
                },
              },
            },
            policies: {
              ...raw.policies,
              overlapPolicy: 6,
              catchupWindow: { seconds: Long.fromNumber(600) },
              pauseOnFailure: false,
            },
          },
        });
      } catch (error) {
        // Temporal reports compare-and-swap conflicts as FailedPrecondition (9).
        if ((error as { code?: number }).code !== 9 || attempt === 4)
          throw error;
      }
    }
    throw new Error("Temporal schedule synchronization did not converge");
  }

  /** Query Temporal itself; no duplicate timezone or recurrence engine lives in the platform. */
  async preview(
    trigger: AutomationTrigger,
    after = new Date().toISOString(),
  ): Promise<string[]> {
    const scheduleId = `truex-preview:${randomUUID()}`;
    const handle = await this.client.schedule.create({
      scheduleId,
      spec: nativeScheduleSpec(trigger),
      state: { paused: true },
      action: {
        type: "startWorkflow",
        workflowType: "automationOccurrence",
        taskQueue: this.taskQueue,
        args: [],
      },
    });
    try {
      const start = new Date(after).getTime();
      const result =
        await new Promise<temporal.api.workflowservice.v1.ListScheduleMatchingTimesResponse>(
          (resolve, reject) => {
            this.client.workflowService.listScheduleMatchingTimes(
              {
                namespace: this.client.options.namespace,
                scheduleId,
                startTime: timestamp(start),
                endTime: timestamp(start + 366 * 24 * 60 * 60_000),
              },
              (error, response) => (error ? reject(error) : resolve(response!)),
            );
          },
        );
      return (result.startTime ?? [])
        .slice(0, 5)
        .map((time) =>
          new Date(
            Number(time.seconds) * 1_000 + (time.nanos ?? 0) / 1_000_000,
          ).toISOString(),
        );
    } finally {
      await handle.delete();
    }
  }
}
